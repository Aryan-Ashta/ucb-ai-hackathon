"""Redis + SM-2 integration tests, backed by fakeredis (see conftest.py)."""
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
    assert due[0]["concept_id"] == c.concept_id
    assert due[0]["concept"] == "memoization"
    assert "state" in due[0]


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

    assert len(alice_due) == 1 and alice_due[0]["concept_id"] == ca.concept_id
    assert len(bob_due) == 1 and bob_due[0]["concept_id"] == cb.concept_id


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
