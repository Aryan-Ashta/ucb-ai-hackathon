import json
import time

import redis.asyncio as aioredis
import sentry_sdk

from backend.config import (
    REDIS_HOST,
    REDIS_PASSWORD,
    REDIS_PORT,
    REDIS_TLS,
    REDIS_URL,
    REDIS_USERNAME,
)
from backend.models import QuizConcept
from backend.services.sm2 import sm2_next

REDIS_TTL_SECONDS = 7 * 24 * 60 * 60  # 7 days minimum

_redis: aioredis.Redis | None = None

# Connection options shared by both connect paths. A pooled, health-checked
# client with tight timeouts keeps a long-lived link to Redis Cloud resilient:
#   • socket_*_timeout  → fail fast on a dead/unreachable node instead of hanging
#   • health_check_interval → ping idle pooled connections so a cloud load
#     balancer doesn't silently drop them out from under us
#   • retry_on_timeout  → transparently retry a single timed-out round-trip
#   • max_connections   → cap the pool so a burst can't exhaust the database
_CONNECT_KWARGS = dict(
    decode_responses=True,
    socket_connect_timeout=5,
    socket_timeout=5,
    health_check_interval=30,
    retry_on_timeout=True,
    max_connections=50,
)


async def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        if REDIS_URL:
            # Explicit URL wins — a local redis:// or a pasted rediss:// string.
            _redis = aioredis.from_url(REDIS_URL, **_CONNECT_KWARGS)
        else:
            # Connect straight from Redis Cloud credentials. Passing discrete
            # params (rather than assembling a URL) avoids URL-encoding pitfalls
            # with passwords that contain special characters.
            _redis = aioredis.Redis(
                host=REDIS_HOST,
                port=REDIS_PORT,
                username=REDIS_USERNAME,
                password=REDIS_PASSWORD or None,
                ssl=REDIS_TLS,
                **_CONNECT_KWARGS,
            )
    return _redis


# ── Key schema ──────────────────────────────────────────────────────────────
# concept:{user_id}:{concept_id}:state  → JSON {ease_factor, interval, repetitions, next_review}
# concept:{user_id}:{concept_id}:quiz   → JSON {concept, roast_text, question_text, answer_hint}
# due:{user_id}                         → sorted set, score = next_review unix timestamp


async def cache_quiz_content(user_id: str, concept: QuizConcept) -> None:
    """Store concept quiz content in Redis. Called immediately after A3 extraction."""
    r = await get_redis()
    quiz_key = f"concept:{user_id}:{concept.concept_id}:quiz"
    state_key = f"concept:{user_id}:{concept.concept_id}:state"
    due_key = f"due:{user_id}"

    quiz_data = {
        "concept": concept.concept,
        "roast_text": concept.roast_text,
        "question_text": concept.question_text,
        "answer_hint": concept.answer_hint,
    }

    now = int(time.time())
    next_review = now + 60  # due in 1 minute for first review (hackathon demo)

    initial_state = {
        "ease_factor": 2.5,
        "interval": 1,
        "repetitions": 0,
        "next_review": next_review,
    }

    pipe = r.pipeline()
    pipe.set(quiz_key, json.dumps(quiz_data), ex=REDIS_TTL_SECONDS)
    pipe.set(state_key, json.dumps(initial_state), ex=REDIS_TTL_SECONDS)
    pipe.zadd(due_key, {concept.concept_id: next_review})
    pipe.expire(due_key, REDIS_TTL_SECONDS)
    await pipe.execute()

    sentry_sdk.add_breadcrumb(
        category="redis",
        message=f"Cached quiz content for concept: {concept.concept}",
        level="info",
    )


async def get_due_concepts(user_id: str) -> list[dict]:
    """Return all concepts due for review, sorted by urgency."""
    r = await get_redis()
    due_key = f"due:{user_id}"
    now = int(time.time())

    due_concept_ids = await r.zrangebyscore(due_key, "-inf", now)

    result = []
    for concept_id in due_concept_ids:
        quiz_key = f"concept:{user_id}:{concept_id}:quiz"
        state_key = f"concept:{user_id}:{concept_id}:state"
        quiz_data = await r.get(quiz_key)
        state_data = await r.get(state_key)
        if quiz_data and state_data:
            result.append(
                {
                    "concept_id": concept_id,
                    **json.loads(quiz_data),
                    "state": json.loads(state_data),
                }
            )

    return result


async def get_quiz_content(user_id: str, concept_id: str) -> dict | None:
    """Fetch pre-cached quiz content for a concept. Used in quiz hot path."""
    r = await get_redis()
    quiz_key = f"concept:{user_id}:{concept_id}:quiz"
    data = await r.get(quiz_key)
    return json.loads(data) if data else None


async def update_sm2_state(user_id: str, concept_id: str, quality: int) -> int:
    """
    Update SM-2 state after a quiz answer. Returns next_review unix timestamp.
    quality: 0-5 (from Claude grader)
    """
    r = await get_redis()
    state_key = f"concept:{user_id}:{concept_id}:state"
    due_key = f"due:{user_id}"

    state_data = await r.get(state_key)
    if not state_data:
        raise ValueError(f"No state found for concept {concept_id}")

    state = json.loads(state_data)
    new_state = sm2_next(state, quality)

    pipe = r.pipeline()
    pipe.set(state_key, json.dumps(new_state), ex=REDIS_TTL_SECONDS)
    pipe.zadd(due_key, {concept_id: new_state["next_review"]})
    pipe.expire(due_key, REDIS_TTL_SECONDS)
    await pipe.execute()

    sentry_sdk.add_breadcrumb(
        category="sm2",
        message=(
            f"Updated SM-2 for {concept_id}: quality={quality}, "
            f"next_review in {new_state['interval']} days"
        ),
        level="info",
        data=new_state,
    )

    return new_state["next_review"]

# ── user-scoped state (added by OAuth refactor) ────────────────────────────
async def mark_pr_processed(user_id: str, *, repo: str, pr_number: int, merged_at: str) -> None:
    """Record that we ingested this PR, so a subsequent sync skips it."""
    r = await get_redis()
    key = f"user:{user_id}:prs"
    await r.hset(key, str(pr_number), json.dumps({"repo": repo, "merged_at": merged_at}))
    await r.expire(key, REDIS_TTL_SECONDS)


async def list_processed_prs(user_id: str) -> list[dict]:
    """All PRs we've previously ingested for this user, as [{pr_number, repo, merged_at}]."""
    r = await get_redis()
    raw = await r.hgetall(f"user:{user_id}:prs")
    return [{"pr_number": int(k), **json.loads(v)} for k, v in raw.items()]


async def get_last_sync(user_id: str) -> int | None:
    """Unix timestamp of the user's last successful sync, or None."""
    r = await get_redis()
    val = await r.get(f"user:{user_id}:last_sync")
    return int(val) if val else None


async def set_last_sync(user_id: str, ts: int) -> None:
    r = await get_redis()
    await r.set(f"user:{user_id}:last_sync", ts, ex=REDIS_TTL_SECONDS)


async def acquire_sync_lock(user_id: str, ttl: int = 300) -> bool:
    """
    Best-effort mutex so two simultaneous syncs for the same user don't
    double-bill Claude. Uses Redis SET NX with a short TTL — if the caller
    dies mid-sync, the lock auto-releases.
    """
    r = await get_redis()
    return bool(await r.set(f"user:{user_id}:sync_inflight", "1", ex=ttl, nx=True))


async def release_sync_lock(user_id: str) -> None:
    r = await get_redis()
    await r.delete(f"user:{user_id}:sync_inflight")


async def add_user_repo(user_id: str, repo_full_name: str) -> None:
    """Track which repos the user has access to (for the dashboard sidebar)."""
    r = await get_redis()
    await r.sadd(f"user:{user_id}:repos", repo_full_name)
    await r.expire(f"user:{user_id}:repos", REDIS_TTL_SECONDS)


async def list_user_repos_cached(user_id: str) -> list[str]:
    r = await get_redis()
    return list(await r.smembers(f"user:{user_id}:repos"))
