"""Tests for backend/scripts/make_all_due.py.

Hermetic — exercises the script against fakeredis so the key-parsing,
SCAN batching, JSON rewrite, and ZADD updates are pinned without needing
a live Redis Cloud connection.
"""
import asyncio
import json
import time

import pytest

from backend.scripts import make_all_due as script


# --- _parse_state_key --------------------------------------------------------

def test_parse_state_key_basic():
    """The middle segment can contain colons (concept_id is '{user_id}:{pr}:{slug}')
    so we must split on the FIRST and LAST colons, not on every colon.
    """
    parsed = script._parse_state_key("concept:42:42:time_complexity:state")
    assert parsed == ("42", "42:time_complexity")


def test_parse_state_key_simple_concept_id():
    parsed = script._parse_state_key("concept:alice:1:memoization:state")
    assert parsed == ("alice", "1:memoization")


def test_parse_state_key_rejects_wrong_prefix():
    assert script._parse_state_key("user:42:encrypted_token") is None


def test_parse_state_key_rejects_wrong_suffix():
    assert script._parse_state_key("concept:42:1:memoization:quiz") is None


def test_parse_state_key_rejects_missing_user_id():
    assert script._parse_state_key("concept::1:memoization:state") is None


# --- _collect_state_keys -----------------------------------------------------

@pytest.fixture
def populated_redis(fake_redis):
    """Seed fakeredis with two users' worth of concepts so SCAN + filtering work.

    Each concept needs THREE entries (mirroring the production schema):
      - concept:{u}:{concept_id}:state  (SM-2 state JSON)
      - concept:{u}:{concept_id}:quiz   (cached quiz content — get_due_concepts
        requires this; without it the concept is silently filtered out)
      - due:{u} ZSET member             (score = next_review unix ts)
    """
    async def _seed():
        r = await script.get_redis()
        now = int(time.time())
        quiz_payload = json.dumps({
            "concept": "memoization", "roast_text": "r", "question_text": "q",
            "answer_hint": "h", "repo": "myorg/app", "pr_title": "PR title",
        })
        # User 7: 3 concepts, all scheduled for the future (NOT due yet).
        for pr, slug in [(1, "memoization"), (2, "time_complexity"), (3, "recursion")]:
            concept_id = f"7:{pr}:{slug}"
            await r.set(
                f"concept:7:{concept_id}:state",
                json.dumps({"ease_factor": 2.5, "interval": 1, "repetitions": 0,
                           "next_review": now + 86400}),
                ex=604800,
            )
            await r.set(f"concept:7:{concept_id}:quiz", quiz_payload, ex=604800)
            await r.zadd(f"due:7", {concept_id: now + 86400})
        # User 99: 2 concepts, both already overdue (next_review in the past).
        for pr, slug in [(10, "closures"), (11, "iterators")]:
            concept_id = f"99:{pr}:{slug}"
            await r.set(
                f"concept:99:{concept_id}:state",
                json.dumps({"ease_factor": 2.5, "interval": 1, "repetitions": 0,
                           "next_review": now - 3600}),
                ex=604800,
            )
            await r.set(f"concept:99:{concept_id}:quiz", quiz_payload, ex=604800)
            await r.zadd(f"due:99", {concept_id: now - 3600})
        # Distraction keys — must NOT be picked up by SCAN.
        await r.set("concept:7:1:memoization:enrichment", "{}", ex=604800)
        await r.set("user:7:encrypted_token", "x", ex=2592000)
        return r
    return _seed


async def test_collect_state_keys_returns_all_users(populated_redis):
    r = await populated_redis()
    keys = await script._collect_state_keys(r, user_filter=None)
    assert len(keys) == 5
    user_ids = {u for _k, u, _c in keys}
    assert user_ids == {"7", "99"}


async def test_collect_state_keys_filters_by_user(populated_redis):
    r = await populated_redis()
    keys = await script._collect_state_keys(r, user_filter="7")
    assert len(keys) == 3
    assert all(u == "7" for _k, u, _c in keys)


async def test_collect_state_keys_excludes_quiz_and_token_keys(populated_redis):
    r = await populated_redis()
    keys = await script._collect_state_keys(r, user_filter=None)
    raw_keys = [k for k, _u, _c in keys]
    assert not any(k.endswith(":quiz") for k in raw_keys)
    assert not any(k.startswith("user:") for k in raw_keys)


# --- make_all_due (end-to-end against fakeredis) ----------------------------

async def test_make_all_due_rewrites_next_review_to_now(populated_redis):
    r = await populated_redis()
    before_ts = int(time.time())
    n = await script.make_all_due(
        user_filter=None, dry_run=False, seconds_into_future=0
    )
    after_ts = int(time.time())

    assert n == 5

    # Every state key's next_review must now be in [before_ts, after_ts] (i.e. "now").
    keys = await script._collect_state_keys(r, user_filter=None)
    for state_key, _u, _c in keys:
        raw = await r.get(state_key)
        assert raw is not None, f"state key {state_key} vanished"
        state = json.loads(raw)
        assert before_ts <= state["next_review"] <= after_ts, (
            f"next_review for {state_key} = {state['next_review']} not in "
            f"[{before_ts}, {after_ts}]"
        )


async def test_make_all_due_updates_zset_scores(populated_redis):
    """ZSETs must be updated to match the new next_review so get_due_concepts
    returns the concepts after the rewrite."""
    from backend.services.redis_client import get_due_concepts
    r = await populated_redis()
    now_ts = int(time.time())

    # Before: user 99 has 2 concepts with next_review in the past → already due.
    # After: ALL concepts (both users) must be due.
    assert (await get_due_concepts("7")) == [], "user 7 should NOT be due before"
    assert len(await get_due_concepts("99")) == 2, "user 99 was already due"

    await script.make_all_due(user_filter=None, dry_run=False, seconds_into_future=0)

    due7 = await get_due_concepts("7")
    due99 = await get_due_concepts("99")
    assert len(due7) == 3, f"expected 3 due for user 7, got {len(due7)}"
    assert len(due99) == 2, f"expected 2 due for user 99, got {len(due99)}"

    # Every concept's ISO next_review must round-trip through datetime parsing
    # without raising (i.e. the script wrote a valid unix timestamp).
    from datetime import datetime
    for c in due7 + due99:
        # If parsing succeeds, the rewrite was structurally correct.
        datetime.fromisoformat(c["next_review"])


async def test_make_all_due_respects_user_filter(populated_redis):
    r = await populated_redis()
    n = await script.make_all_due(
        user_filter="7", dry_run=False, seconds_into_future=0
    )
    assert n == 3

    # User 7 should now be due, user 99 untouched (still only the 2 already-due).
    from backend.services.redis_client import get_due_concepts
    assert len(await get_due_concepts("7")) == 3
    assert len(await get_due_concepts("99")) == 2


async def test_make_all_due_seconds_into_future(populated_redis):
    r = await populated_redis()
    before = int(time.time())
    await script.make_all_due(
        user_filter=None, dry_run=False, seconds_into_future=300
    )
    after = int(time.time())
    keys = await script._collect_state_keys(r, user_filter=None)
    for state_key, _u, _c in keys:
        raw = await r.get(state_key)
        state = json.loads(raw)
        assert before + 300 <= state["next_review"] <= after + 300


async def test_make_all_due_dry_run_does_not_write(populated_redis):
    r = await populated_redis()
    # Capture state before.
    keys = await script._collect_state_keys(r, user_filter=None)
    before = {}
    for state_key, _u, _c in keys:
        before[state_key] = await r.get(state_key)

    n = await script.make_all_due(
        user_filter=None, dry_run=True, seconds_into_future=0
    )
    assert n == 5

    # State must be unchanged after a dry run.
    for state_key, _u, _c in keys:
        assert await r.get(state_key) == before[state_key], (
            f"dry-run mutated {state_key}"
        )


async def test_make_all_due_idempotent(populated_redis):
    """Running the script twice in a row is a safe no-op write."""
    r = await populated_redis()
    await script.make_all_due(user_filter=None, dry_run=False, seconds_into_future=0)
    keys_after_first = await script._collect_state_keys(r, user_filter=None)
    snapshot_after_first = {k: await r.get(k) for k, _u, _c in keys_after_first}

    # Second run, with a small delta between timestamps.
    await asyncio.sleep(0.01)
    await script.make_all_due(user_filter=None, dry_run=False, seconds_into_future=0)
    keys_after_second = await script._collect_state_keys(r, user_filter=None)
    snapshot_after_second = {k: await r.get(k) for k, _u, _c in keys_after_second}

    assert set(snapshot_after_first) == set(snapshot_after_second)
    # The structure (keys present, JSON shape) must match — exact ts may differ by ms.
    for k in snapshot_after_first:
        s1 = json.loads(snapshot_after_first[k])
        s2 = json.loads(snapshot_after_second[k])
        # next_review can shift by a few ms; everything else must be identical.
        assert s1["ease_factor"] == s2["ease_factor"]
        assert s1["interval"] == s2["interval"]
        assert s1["repetitions"] == s2["repetitions"]
        assert abs(s1["next_review"] - s2["next_review"]) <= 1
