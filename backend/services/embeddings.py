"""Embedding service for the vector-store RAG layer.

Wraps the Voyage AI HTTP API. Two key behaviors:

  1. **Real embeddings** when `VOYAGE_API_KEY` is set — POSTs the input
     list to `https://api.voyageai.com/v1/embeddings`, returns a list of
     float vectors of length `EMBEDDING_DIM`.

  2. **Deterministic fallback** when the key is missing (tests + dev
     without a key). Uses a SHA-256-seeded RNG to produce a stable
     `EMBEDDING_DIM`-length float vector in roughly the same magnitude
     range as Voyage's outputs (L2-normalized to unit length, then
     scaled so dot-product similarity stays bounded). This keeps the
     rest of the vector pipeline testable without burning API quota.

The fallback is NOT useful for actual semantic recall — two
semantically similar concepts will not necessarily have nearby vectors.
That's acceptable: when the real key is set, the live path is used;
when it isn't, indexing still happens (so the schema is exercised
end-to-end) but search results are noisy.
"""
import hashlib
import math

import httpx
import sentry_sdk

from backend.config import (
    EMBEDDING_DIM,
    VOYAGE_API_KEY,
    VOYAGE_BASE_URL,
    VOYAGE_MODEL,
)
from backend.services.http_client import shared_client

_client = shared_client("voyage")


async def embed_concept(name: str, description: str = "") -> list[float]:
    """Embed a concept representation for the vector index.

    The input is "{name}: {description}" — short (20-50 tokens), not
    the full roast/question (those would create circular similarity).
    """
    text = f"{name}: {description}".strip(": ").strip()
    if not text:
        text = name or "(unnamed concept)"

    if not VOYAGE_API_KEY:
        # Dev/test path. Stable, L2-normalized, unit-length.
        return _hash_embedding(text)

    try:
        response = await _client.post(
            f"{VOYAGE_BASE_URL}/v1/embeddings",
            headers={
                "Authorization": f"Bearer {VOYAGE_API_KEY}",
                "Content-Type": "application/json",
            },
            json={"model": VOYAGE_MODEL, "input": [text]},
            timeout=10.0,
        )
        response.raise_for_status()
        data = response.json()
        # Voyage returns {"data": [{"embedding": [...], "index": 0}, ...]}
        return list(data["data"][0]["embedding"])
    except Exception as e:
        sentry_sdk.capture_exception(e)
        sentry_sdk.add_breadcrumb(
            category="embeddings",
            message=f"voyage_embed_failed falling_back_to_hash: {type(e).__name__}",
            level="warning",
            data={"text_preview": text[:60]},
        )
        return _hash_embedding(text)


async def embed_concepts_batch(items: list[tuple[str, str]]) -> list[list[float]]:
    """Batch embed many concepts in one HTTP call.

    `items` is a list of (name, description). Falls back to per-item
    hash embedding on the batch failure path.
    """
    if not items:
        return []
    texts = [f"{n}: {d}".strip(": ").strip() or n or "(unnamed)" for n, d in items]

    if not VOYAGE_API_KEY:
        return [_hash_embedding(t) for t in texts]

    try:
        response = await _client.post(
            f"{VOYAGE_BASE_URL}/v1/embeddings",
            headers={
                "Authorization": f"Bearer {VOYAGE_API_KEY}",
                "Content-Type": "application/json",
            },
            json={"model": VOYAGE_MODEL, "input": texts},
            timeout=15.0,
        )
        response.raise_for_status()
        data = response.json()
        # Sort by `index` field so the response order matches the input
        # order — Voyage already returns it in input order but we don't
        # want to depend on that.
        ordered = sorted(data["data"], key=lambda d: d["index"])
        return [list(d["embedding"]) for d in ordered]
    except Exception as e:
        sentry_sdk.capture_exception(e)
        return [_hash_embedding(t) for t in texts]


def _hash_embedding(text: str) -> list[float]:
    """Deterministic L2-normalized pseudo-embedding.

    Used when VOYAGE_API_KEY is unset (dev/test). Not semantically
    meaningful — the goal is to exercise the vector-store schema
    path, not to deliver real recall.
    """
    seed = hashlib.sha256(text.encode("utf-8")).digest()
    # Stretch the 32-byte seed into EMBEDDING_DIM floats via a small
    # counter-based PRNG (linear congruential with the SHA as seed).
    out: list[float] = []
    state = int.from_bytes(seed[:8], "big") | 1
    for _ in range(EMBEDDING_DIM):
        state = (state * 6364136223846793005 + 1442695040888963407) & 0xFFFFFFFFFFFFFFFF
        # Map to [-1, 1]
        out.append(((state >> 11) & 0xFFFF) / 32767.5 - 1.0)
    # L2-normalize so dot-product similarity is bounded.
    norm = math.sqrt(sum(x * x for x in out)) or 1.0
    return [x / norm for x in out]
