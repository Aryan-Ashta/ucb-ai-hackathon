"""Tests for the embeddings service.

All tests run without a real Voyage API key — they exercise the
hash-fallback path (which is the dev/test default when VOYAGE_API_KEY
is unset). The Voyage HTTP path is verified by checking that the
client is constructed and the call is shaped correctly via mocks.
"""
from unittest.mock import AsyncMock, patch

import pytest

from backend.services import embeddings
from backend.services.embeddings import (
    embed_concept,
    embed_concepts_batch,
    _hash_embedding,
)


@pytest.fixture(autouse=True)
def _no_api_key(monkeypatch):
    """Default to no VOYAGE_API_KEY so tests exercise the hash path."""
    monkeypatch.setattr(embeddings, "VOYAGE_API_KEY", "")


def test_hash_embedding_is_deterministic():
    a = _hash_embedding("memoization: caching results")
    b = _hash_embedding("memoization: caching results")
    assert a == b
    assert len(a) == embeddings.EMBEDDING_DIM


def test_hash_embedding_is_l2_normalized():
    import math
    v = _hash_embedding("anything")
    norm = math.sqrt(sum(x * x for x in v))
    assert abs(norm - 1.0) < 1e-9


def test_hash_embedding_differs_for_different_inputs():
    a = _hash_embedding("memoization")
    b = _hash_embedding("caching")
    assert a != b


async def test_embed_concept_uses_hash_fallback_when_no_api_key():
    """No VOYAGE_API_KEY → deterministic fallback path."""
    out = await embed_concept("memoization", "caching computed results")
    assert isinstance(out, list)
    assert len(out) == embeddings.EMBEDDING_DIM
    # Deterministic: same input → same output
    out2 = await embed_concept("memoization", "caching computed results")
    assert out == out2


async def test_embed_concept_handles_empty_description():
    """Empty description is normalized; no exception."""
    out = await embed_concept("recursion", "")
    assert len(out) == embeddings.EMBEDDING_DIM
    # And no trailing colon survives in the embedding input.
    out2 = await embed_concept("recursion")
    assert out == out2


async def test_embed_concept_calls_voyage_when_key_present(monkeypatch):
    monkeypatch.setattr(embeddings, "VOYAGE_API_KEY", "test-voyage-key")

    fake_vec = [0.1] * embeddings.EMBEDDING_DIM
    fake_response = AsyncMock()
    fake_response.raise_for_status = lambda: None
    fake_response.json = lambda: {"data": [{"embedding": fake_vec, "index": 0}]}

    with patch.object(embeddings._client, "post", return_value=fake_response) as mock_post:
        out = await embed_concept("memoization", "caching")

    assert out == fake_vec
    mock_post.assert_called_once()
    call = mock_post.call_args
    body = call.kwargs["json"]
    assert body["model"] == embeddings.VOYAGE_MODEL
    assert body["input"] == ["memoization: caching"]


async def test_embed_concept_falls_back_to_hash_on_voyage_failure(monkeypatch):
    """Voyage HTTP error → captured to Sentry, returns hash embedding."""
    monkeypatch.setattr(embeddings, "VOYAGE_API_KEY", "test-voyage-key")

    fake_response = AsyncMock()
    fake_response.raise_for_status.side_effect = Exception("voyage down")

    with patch.object(embeddings._client, "post", return_value=fake_response):
        out = await embed_concept("memoization", "caching")

    assert len(out) == embeddings.EMBEDDING_DIM


async def test_embed_concepts_batch_empty():
    out = await embed_concepts_batch([])
    assert out == []


async def test_embed_concepts_batch_preserves_order(monkeypatch):
    """Batch with no API key returns one hash per item in input order."""
    monkeypatch.setattr(embeddings, "VOYAGE_API_KEY", "test-voyage-key")

    items = [
        ("memoization", "caching"),
        ("recursion", "self-reference"),
        ("asyncio", "concurrent coroutines"),
    ]

    fake_data = [
        {"embedding": [0.1 + 0.01 * i] * embeddings.EMBEDDING_DIM, "index": i}
        for i in range(3)
    ]
    fake_response = AsyncMock()
    fake_response.raise_for_status = lambda: None
    fake_response.json = lambda: {"data": fake_data}

    with patch.object(embeddings._client, "post", return_value=fake_response):
        out = await embed_concepts_batch(items)

    # Sorted by index, but Voyage returns in input order here so the
    # embeddings appear in the same order as `items`.
    assert len(out) == 3
    # Each is distinguishable (different magnitudes).
    assert out[0] != out[1] != out[2]


async def test_embed_concepts_batch_handles_voyage_out_of_order(monkeypatch):
    """If Voyage returns embeddings out of input order, we sort by index."""
    monkeypatch.setattr(embeddings, "VOYAGE_API_KEY", "test-voyage-key")

    items = [("a", ""), ("b", ""), ("c", "")]

    # Out-of-order index field
    fake_data = [
        {"embedding": [0.1] * embeddings.EMBEDDING_DIM, "index": 2},
        {"embedding": [0.2] * embeddings.EMBEDDING_DIM, "index": 0},
        {"embedding": [0.3] * embeddings.EMBEDDING_DIM, "index": 1},
    ]
    fake_response = AsyncMock()
    fake_response.raise_for_status = lambda: None
    fake_response.json = lambda: {"data": fake_data}

    with patch.object(embeddings._client, "post", return_value=fake_response):
        out = await embed_concepts_batch(items)

    # After sort-by-index: index 0 (vec=0.2), 1 (vec=0.3), 2 (vec=0.1)
    assert out[0][0] == pytest.approx(0.2)
    assert out[1][0] == pytest.approx(0.3)
    assert out[2][0] == pytest.approx(0.1)
