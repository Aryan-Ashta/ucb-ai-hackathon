"""Tests for vector_store.py.

The RediSearch module is not guaranteed to be available — these tests
exercise the graceful-degradation paths (no-op when RediSearch is
absent) plus the search-result parser, which is pure and easy to unit-
test. The actual FT.CREATE / FT.SEARCH commands are not exercised in
CI; they require a real Redis Stack instance.
"""
import pytest

from backend.services import vector_store


def test_parse_knn_response_empty():
    assert vector_store._parse_knn_response([], "") == []
    assert vector_store._parse_knn_response([0], "") == []


def test_parse_knn_response_basic():
    raw = [
        2,
        b"vsc:u:1:caching", [
            b"concept_id", b"u:1:caching",
            b"concept_name", b"Caching",
            b"roast_text", b"you wrote O(n)",
            b"question_text", b"what's O(1)?",
            b"source_type", b"pr",
            b"pr_number_or_sha", b"42",
            b"repo", b"octo/cat",
            b"score", b"0.1",  # distance
        ],
        b"vsc:u:1:recursion", [
            b"concept_id", b"u:1:recursion",
            b"concept_name", b"Recursion",
            b"roast_text", b"stack overflow incoming",
            b"question_text", b"what's the fix?",
            b"source_type", b"commit",
            b"pr_number_or_sha", b"abc1234",
            b"repo", b"octo/cat",
            b"score", b"0.5",
        ],
    ]
    out = vector_store._parse_knn_response(raw, "")
    assert len(out) == 2
    # COSINE distance → similarity = 1 - distance
    assert out[0]["concept_name"] == "Caching"
    assert out[0]["score"] == pytest.approx(0.9)
    assert out[0]["repo"] == "octo/cat"
    assert out[1]["score"] == pytest.approx(0.5)


def test_parse_knn_response_excludes_self():
    raw = [
        1,
        b"vsc:u:1:self", [
            b"concept_id", b"u:1:self",
            b"concept_name", b"Self",
            b"score", b"0.0",
        ],
    ]
    out = vector_store._parse_knn_response(raw, "u:1:self")
    assert out == []


def test_parse_knn_response_clamps_score():
    raw = [
        1,
        b"vsc:u:1:x", [
            b"concept_id", b"u:1:x",
            b"concept_name", b"X",
            # Negative distance should clamp to similarity 1.0
            b"score", b"-0.5",
        ],
    ]
    out = vector_store._parse_knn_response(raw, "")
    assert out[0]["score"] == 1.0


def test_parse_knn_response_handles_missing_score():
    raw = [
        1,
        b"vsc:u:1:x", [
            b"concept_id", b"u:1:x",
            b"concept_name", b"X",
            # No score field — should default to 0 (worst match).
        ],
    ]
    out = vector_store._parse_knn_response(raw, "")
    assert out[0]["score"] == 0.0


async def test_find_similar_returns_empty_when_no_redis():
    """Without a working redis client, find_similar degrades to []."""
    # We don't have a real RediSearch; ensure_index flips _index_ready
    # to False after a connection error. find_similar then returns [].
    out = await vector_store.find_similar("u_1", "memoization")
    assert out == []


async def test_index_concept_swallows_errors(monkeypatch):
    """Fire-and-forget: a failed index never raises."""
    # Force ensure_index to fail by making get_redis raise.
    from backend.services import redis_client as rc

    async def boom():
        raise RuntimeError("redis down")
    monkeypatch.setattr(rc, "get_redis", boom)
    # Re-import to pick up the patched module.
    import importlib
    importlib.reload(vector_store)
    # Should not raise.
    await vector_store.index_concept(
        user_id="u_1",
        concept_id="u_1:42:caching",
        concept_name="Caching",
        roast_text="roast",
    )


async def test_health_check_shape():
    h = await vector_store.health_check()
    assert set(h.keys()) == {"index_ready", "index_name", "embedding_dim", "warned_unavailable"}
    assert h["index_name"] == "vibeschool_concepts"
    assert isinstance(h["index_ready"], bool)
    assert isinstance(h["embedding_dim"], int)
    assert isinstance(h["warned_unavailable"], bool)
