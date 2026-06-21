"""Redis + SM-2 integration tests, backed by fakeredis (see conftest.py)."""
import json
import time

import pytest

import backend.services.redis_client as redis_client_module
from backend.models import QuizConcept
from backend.services.redis_client import (
    REDIS_TTL_SECONDS,
    cache_quiz_content,
    get_due_concepts,
    get_quiz_content,
    get_redis,
    update_sm2_state,
)

SIX_DAYS = 6 * 24 * 60 * 60


def _concept(user_id="u1", pr=999, slug="memoization"):
    return QuizConcept(
        concept_id=f"{user_id}:{pr}:{slug}",
        concept="memoization",
        roast_text="No caching? Bold.",
        question_text="What eliminates redundant recomputation?",
        answer_hint="memoization, caching, dynamic programming",
    )


async def test_cache_and_fetch_quiz_content():
    c = _concept()
    await cache_quiz_content("u1", c)

    quiz = await get_quiz_content("u1", c.concept_id)
    assert quiz is not None
    assert quiz["concept"] == "memoization"
    assert quiz["question_text"]
    assert quiz["answer_hint"]


async def test_quiz_content_fields_complete():
    """All four quiz fields must survive the round-trip."""
    c = _concept()
    await cache_quiz_content("u1", c)
    quiz = await get_quiz_content("u1", c.concept_id)
    assert quiz is not None
    for field in ("concept", "roast_text", "question_text", "answer_hint"):
        assert field in quiz, f"Missing field: {field}"


async def test_get_quiz_content_missing_returns_none():
    """get_quiz_content must return None for an unknown concept, not raise."""
    result = await get_quiz_content("u1", "u1:0:nonexistent")
    assert result is None


async def test_ttl_at_least_six_days():
    c = _concept()
    await cache_quiz_content("u1", c)
    r = await get_redis()
    for suffix in ("quiz", "state"):
        ttl = await r.ttl(f"concept:u1:{c.concept_id}:{suffix}")
        assert ttl > SIX_DAYS, f"TTL too short on {suffix}: {ttl}s"
    assert REDIS_TTL_SECONDS == 7 * 24 * 60 * 60


async def test_get_due_concepts_empty_when_none_stored():
    """Fresh keyspace → no due concepts."""
    due = await get_due_concepts("nobody")
    assert due == []


async def test_get_due_concepts_excludes_future():
    """Concepts scheduled in the future must not appear in due list."""
    c = _concept()
    await cache_quiz_content("u1", c)
    r = await get_redis()
    # Push score far into the future.
    await r.zadd("due:u1", {c.concept_id: int(time.time()) + 9999})

    due = await get_due_concepts("u1")
    assert due == []


async def test_get_due_concepts_returns_overdue():
    c = _concept()
    await cache_quiz_content("u1", c)
    # Force the concept overdue by backdating its score in the due set.
    r = await get_redis()
    await r.zadd("due:u1", {c.concept_id: int(time.time()) - 10})

    due = await get_due_concepts("u1")
    assert len(due) == 1
    assert due[0]["id"] == c.concept_id
    assert due[0]["concept"] == "memoization"
    assert "next_review" in due[0]
    assert "interval" in due[0]
    assert "ease_factor" in due[0]


async def test_get_due_concepts_multiple_users_isolated():
    """Due list for user A must not bleed into user B's results."""
    ca = _concept(user_id="alice", slug="recursion")
    cb = _concept(user_id="bob", slug="recursion")
    await cache_quiz_content("alice", ca)
    await cache_quiz_content("bob", cb)

    r = await get_redis()
    past = int(time.time()) - 10
    await r.zadd("due:alice", {ca.concept_id: past})
    await r.zadd("due:bob", {cb.concept_id: past})

    alice_due = await get_due_concepts("alice")
    bob_due = await get_due_concepts("bob")

    assert len(alice_due) == 1 and alice_due[0]["id"] == ca.concept_id
    assert len(bob_due) == 1 and bob_due[0]["id"] == cb.concept_id


async def test_update_sm2_state_advances_schedule():
    c = _concept()
    await cache_quiz_content("u1", c)

    next_review = await update_sm2_state("u1", c.concept_id, quality=4)
    assert next_review > int(time.time()), "next_review must be in the future"

    # Quiz content must still be intact after SM-2 update.
    quiz = await get_quiz_content("u1", c.concept_id)
    assert quiz is not None


async def test_update_sm2_state_low_quality_reschedules_soon():
    """Quality=0 (complete blackout) must keep next_review close (≤2 days)."""
    c = _concept()
    await cache_quiz_content("u1", c)

    next_review = await update_sm2_state("u1", c.concept_id, quality=0)
    two_days = int(time.time()) + 2 * 24 * 60 * 60
    assert next_review <= two_days, (
        f"Failed answer should reschedule within 2 days, got {next_review}"
    )


async def test_update_sm2_persists_to_due_set():
    """The sorted-set score must exactly match the timestamp update_sm2_state returns."""
    c = _concept()
    await cache_quiz_content("u1", c)
    r = await get_redis()

    new_review = await update_sm2_state("u1", c.concept_id, quality=5)
    new_score = await r.zscore("due:u1", c.concept_id)

    assert int(new_score) == new_review


async def test_update_sm2_state_missing_concept_raises():
    with pytest.raises(ValueError):
        await update_sm2_state("u1", "u1:1:nonexistent", quality=5)


async def test_get_redis_returns_same_instance():
    """get_redis() must be a singleton — same object on repeated calls."""
    r1 = await get_redis()
    r2 = await get_redis()
    assert r1 is r2



async def test_mark_pr_processed_and_list_roundtrip():
    """After the commit-support refactor, list_processed_prs returns items
    with a `source_type` discriminator and a unified `key` field (PR number
    for PRs, short-SHA for commits). This pins the PR shape."""
    from backend.services.redis_client import mark_pr_processed, list_processed_prs
    await mark_pr_processed(
        "u1", repo="octocat/hello", pr_number=42, merged_at="2026-06-01T00:00:00Z"
    )
    prs = await list_processed_prs("u1")
    assert len(prs) == 1
    assert prs[0]["source_type"] == "pr"
    assert prs[0]["key"] == 42
    assert prs[0]["repo"] == "octocat/hello"
    assert prs[0]["merged_at"] == "2026-06-01T00:00:00Z"


async def test_mark_commit_processed_and_list_roundtrip():
    """Pins the commit shape: source_type='commit', key=<short SHA>, committed_at."""
    from backend.services.redis_client import list_processed_prs, mark_commit_processed
    await mark_commit_processed(
        "u1", repo="octocat/hello",
        commit_sha="abc1234567890def", committed_at="2026-06-01T00:00:00Z",
    )
    items = await list_processed_prs("u1")
    assert len(items) == 1
    assert items[0]["source_type"] == "commit"
    assert items[0]["key"] == "abc1234"  # first 7 chars of the SHA
    assert items[0]["repo"] == "octocat/hello"
    assert items[0]["committed_at"] == "2026-06-01T00:00:00Z"


async def test_mixed_processed_prs_and_commits():
    """Both kinds co-exist in the same HASH, distinguished by the 'c-' prefix."""
    from backend.services.redis_client import (
        list_processed_prs,
        mark_commit_processed,
        mark_pr_processed,
    )
    await mark_pr_processed("u1", repo="r1", pr_number=10, merged_at="t1")
    await mark_commit_processed("u1", repo="r1",
                                commit_sha="deadbeef0001", committed_at="t2")
    await mark_pr_processed("u1", repo="r2", pr_number=11, merged_at="t3")
    items = await list_processed_prs("u1")
    assert len(items) == 3
    by_type: dict[str, list[dict]] = {"pr": [], "commit": []}
    for it in items:
        by_type[it["source_type"]].append(it)
    assert len(by_type["pr"]) == 2
    assert {it["key"] for it in by_type["pr"]} == {10, 11}
    assert len(by_type["commit"]) == 1
    assert by_type["commit"][0]["key"] == "deadbee"  # first 7 chars of "deadbeef0001"


async def test_get_last_sync_roundtrip():
    from backend.services.redis_client import get_last_sync, set_last_sync
    assert await get_last_sync("u1") is None
    await set_last_sync("u1", 1_700_000_000)
    assert await get_last_sync("u1") == 1_700_000_000


async def test_sync_inflight_lock():
    from backend.services.redis_client import (
        acquire_sync_lock,
        release_sync_lock,
    )
    assert await acquire_sync_lock("u1") is True
    assert await acquire_sync_lock("u1") is False  # already held
    await release_sync_lock("u1")
    assert await acquire_sync_lock("u1") is True
    await release_sync_lock("u1")


async def test_user_repos_roundtrip():
    from backend.services.redis_client import (
        add_user_repo,
        list_user_repos_cached,
    )
    await add_user_repo("u1", "octocat/hello")
    await add_user_repo("u1", "octocat/world")
    assert set(await list_user_repos_cached("u1")) == {
        "octocat/hello",
        "octocat/world",
    }


# ── Gap-analysis coverage: documented-but-untested Redis behaviors ─────────


async def test_get_due_concepts_sorted_by_urgency():
    """Concepts further overdue must appear first (sorted by score ascending)."""
    c_recent = _concept(slug="recent")
    c_overdue = _concept(slug="overdue")
    await cache_quiz_content("u1", c_recent)
    await cache_quiz_content("u1", c_overdue)

    r = await get_redis()
    now = int(time.time())
    await r.zadd("due:u1", {c_recent.concept_id: now - 1})      # very recently due
    await r.zadd("due:u1", {c_overdue.concept_id: now - 100})   # overdue 100s ago

    due = await get_due_concepts("u1")
    assert len(due) == 2
    # More-overdue concept must come first.
    assert due[0]["id"] == c_overdue.concept_id
    assert due[1]["id"] == c_recent.concept_id


async def test_orphan_in_due_set_is_silently_skipped():
    """If a concept_id lives in the due set without quiz/state keys, drop it silently.

    Pins the current behavior of redis_client.get_due_concepts which checks
    `if quiz_data and state_data` and skips members with missing data. If a
    future change makes this fail loud, this test will fail and force a
    deliberate decision.
    """
    r = await get_redis()
    await r.zadd("due:u1", {"u1:999:orphan": int(time.time()) - 10})

    due = await get_due_concepts("u1")
    assert due == []


async def test_mark_pr_processed_sets_seven_day_ttl():
    from backend.services.redis_client import mark_pr_processed
    await mark_pr_processed(
        "u1", repo="octocat/hello", pr_number=42, merged_at="2026-06-01T00:00:00Z"
    )
    r = await get_redis()
    ttl = await r.ttl("user:u1:prs")
    assert ttl > 0, f"TTL must be positive, got {ttl}"
    assert ttl <= REDIS_TTL_SECONDS, f"TTL must be <= REDIS_TTL_SECONDS ({REDIS_TTL_SECONDS}), got {ttl}"
    assert ttl > SIX_DAYS, f"TTL must be > 6 days ({SIX_DAYS}s), got {ttl}s"


async def test_set_last_sync_sets_seven_day_ttl():
    from backend.services.redis_client import set_last_sync
    await set_last_sync("u1", 1_700_000_000)
    r = await get_redis()
    ttl = await r.ttl("user:u1:last_sync")
    assert ttl > 0, f"TTL must be positive, got {ttl}"
    assert ttl <= REDIS_TTL_SECONDS, f"TTL must be <= REDIS_TTL_SECONDS, got {ttl}"
    assert ttl > SIX_DAYS, f"TTL must be > 6 days ({SIX_DAYS}s), got {ttl}s"


async def test_add_user_repo_sets_seven_day_ttl():
    from backend.services.redis_client import add_user_repo
    await add_user_repo("u1", "octocat/hello")
    r = await get_redis()
    ttl = await r.ttl("user:u1:repos")
    assert ttl > 0, f"TTL must be positive, got {ttl}"
    assert ttl <= REDIS_TTL_SECONDS, f"TTL must be <= REDIS_TTL_SECONDS, got {ttl}"
    assert ttl > SIX_DAYS, f"TTL must be > 6 days ({SIX_DAYS}s), got {ttl}s"


async def test_due_set_has_seven_day_ttl():
    """The due:{user_id} sorted set must expire with the same 7-day window."""
    c = _concept()
    await cache_quiz_content("u1", c)
    r = await get_redis()
    ttl = await r.ttl("due:u1")
    assert ttl > 0, f"due: TTL must be positive, got {ttl}"
    assert ttl <= REDIS_TTL_SECONDS, f"due: TTL must be <= REDIS_TTL_SECONDS, got {ttl}"
    assert ttl > SIX_DAYS, f"due: TTL must be > 6 days ({SIX_DAYS}s), got {ttl}s"


async def test_sync_lock_ttl_set():
    """acquire_sync_lock must apply the requested TTL to the sync_inflight key."""
    from backend.services.redis_client import acquire_sync_lock, release_sync_lock
    try:
        assert await acquire_sync_lock("u1", ttl=60) is True
        r = await get_redis()
        ttl = await r.ttl("user:u1:sync_inflight")
        assert 0 < ttl <= 60, f"Sync-lock TTL must be in (0, 60], got {ttl}"
    finally:
        await release_sync_lock("u1")


async def test_release_sync_lock_idempotent_on_missing():
    """release_sync_lock must not raise when no lock is held."""
    from backend.services.redis_client import release_sync_lock
    # No lock was acquired — release must be a no-op rather than throwing.
    await release_sync_lock("u1")


async def test_cache_quiz_content_overwrites_existing_state():
    """Re-caching a concept must reset SM-2 state back to initial values.

    Today's behavior resets state to repetitions=0 / ease_factor=2.5, which is
    masked in production by mark_pr_processed skipping already-ingested PRs.
    """
    c = _concept()
    await cache_quiz_content("u1", c)

    # Advance the schedule.
    await update_sm2_state("u1", c.concept_id, quality=5)
    r = await get_redis()
    advanced = await r.get(f"concept:u1:{c.concept_id}:state")
    assert advanced is not None
    assert json.loads(advanced)["repetitions"] == 1

    # Re-cache: state must be back to initial.
    await cache_quiz_content("u1", c)
    reset = await r.get(f"concept:u1:{c.concept_id}:state")
    assert reset is not None
    state = json.loads(reset)
    assert state["repetitions"] == 0
    assert state["ease_factor"] == 2.5


async def test_sm2_state_preserved_across_update_under_normal_conditions():
    """update_sm2_state must advance the schedule without touching quiz content."""
    c = _concept()
    await cache_quiz_content("u1", c)

    quiz_before = await get_quiz_content("u1", c.concept_id)
    assert quiz_before is not None

    await update_sm2_state("u1", c.concept_id, quality=5)

    # Core quiz fields must be preserved after SM-2 update.
    quiz_after = await get_quiz_content("u1", c.concept_id)
    for field in ("concept", "roast_text", "question_text", "answer_hint"):
        assert quiz_after[field] == quiz_before[field], f"{field} changed after SM-2 update"

    # But state must have advanced: repetitions incremented from 0 → 1.
    r = await get_redis()
    state_raw = await r.get(f"concept:u1:{c.concept_id}:state")
    assert state_raw is not None
    assert json.loads(state_raw)["repetitions"] == 1


async def test_connect_kwargs_match_spec():
    """Guard against accidental drop of any of the five documented connection kwargs.

    These are load-bearing for resilience (timeouts + health checks + retry +
    pool cap). A future refactor must not silently remove them.
    """
    import inspect

    source = inspect.getsource(redis_client_module)
    for needle in (
        "socket_connect_timeout=5",
        "socket_timeout=5",
        "health_check_interval=30",
        "retry_on_timeout=True",
        "max_connections=50",
    ):
        assert needle in source, (
            f"_CONNECT_KWARGS is missing required kwarg {needle!r} — "
            "refactor likely regressed the redis resilience config"
        )


@pytest.mark.xfail(
    reason="P2: production should clamp quality to [0, 5] inside update_sm2_state; "
    "today it forwards the value verbatim to sm2_next.",
    strict=False,
)
async def test_update_sm2_state_quality_clamps_via_caller():
    """`update_sm2_state` must reject out-of-range quality values.

    Today the production function forwards quality verbatim to sm2_next, which
    silently absorbs nonsense values via the 1.3 ease-factor floor. The
    contract we want: callers should not be able to write garbage state.

    Marked xfail so the gap is documented and the test stays in the suite.
    When production adds clamping, the strict=False xfail will turn green
    automatically and the test becomes a real regression guard.
    """
    c = _concept()
    await cache_quiz_content("u1", c)
    with pytest.raises((ValueError, AssertionError)):
        await update_sm2_state("u1", c.concept_id, quality=99)
