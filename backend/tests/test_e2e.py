"""
End-to-end pipeline test.

The full ingestion path (Bear-2 → Claude → Redis) needs a real TOKENROUTER_API_KEY,
so it runs only when one is configured. Without it, we still exercise the Redis-backed
review loop end to end (cache → due → grade/SM-2 → TTL) using fakeredis, which is the
part of A8 that can be verified hermetically.
"""
import os
import time

from backend.models import QuizConcept
from backend.services.redis_client import (
    cache_quiz_content,
    get_due_concepts,
    get_quiz_content,
    get_redis,
    update_sm2_state,
)

SIX_DAYS = 6 * 24 * 60 * 60


def _has_real_key() -> bool:
    key = os.environ.get("TOKENROUTER_API_KEY", "")
    return bool(key) and not key.startswith("placeholder")


async def _seed_overdue(user_id: str, pr: int, slug: str) -> str:
    c = QuizConcept(
        concept_id=f"{user_id}:{pr}:{slug}",
        concept=slug,
        roast_text="roast",
        question_text="q?",
        answer_hint="a, b, c",
    )
    await cache_quiz_content(user_id, c)
    r = await get_redis()
    await r.zadd(f"due:{user_id}", {c.concept_id: int(time.time()) - 5})
    return c.concept_id


async def test_review_loop_hermetic():
    """cache → due → quiz present → SM-2 update → TTL holds. No external services."""
    user_id = "stress_user"
    cid = await _seed_overdue(user_id, 1001, "recursion")

    due = await get_due_concepts(user_id)
    assert len(due) == 1, f"Expected 1 due concept, got {len(due)}"

    quiz = await get_quiz_content(user_id, cid)
    assert quiz is not None, "Quiz content missing"

    next_review = await update_sm2_state(user_id, cid, quality=4)
    assert next_review > 0, "next_review timestamp invalid"

    # After a passing grade the concept is no longer overdue.
    due_after = await get_due_concepts(user_id)
    assert all(item["id"] != cid for item in due_after), (
        "Concept should leave the due set after a passing grade"
    )

    # TTL must remain well above six days on every concept key.
    r = await get_redis()
    keys = await r.keys(f"concept:{user_id}:*")
    assert keys, "No concept keys written"
    for k in keys:
        ttl = await r.ttl(k)
        assert ttl > SIX_DAYS, f"TTL too short on {k}: {ttl}s"


async def test_full_pipeline_with_claude():
    """Full Bear-2 → Claude → Redis ingestion. Runs only with a real TokenRouter key."""
    if not _has_real_key():
        return  # skipped without credentials

    from backend.services.claude import extract_concepts_and_cache

    small_diff = (
        "diff --git a/utils.py b/utils.py\n+def add(a, b):\n+    return a + b\n"
    )
    concepts = await extract_concepts_and_cache(
        small_diff, user_id="stress_user", source_id=1002
    )
    assert isinstance(concepts, list)
    due = await get_due_concepts("stress_user")
    assert isinstance(due, list)
