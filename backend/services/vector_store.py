"""Vector store backed by Redis RediSearch.

Architecture:
  - One global index `vibeschool_concepts` keyed by user_id (TAG filter).
  - HNSW vector field with COSINE distance, dim=EMBEDDING_DIM.
  - Metadata fields for hit-list rendering + provenance.

Graceful degradation:
  - RediSearch must be enabled on the Redis server (Redis Stack or
    Redis Cloud with the Search module). `ensure_index()` runs at first
    use and flips the internal `_index_ready` flag based on whether
    `FT.CREATE` succeeded.
  - When RediSearch is unavailable, every public function returns a
    benign empty result + logs a one-shot warning. The rest of the app
    (roast / quiz / grade) keeps working — just without retrieval.

Why this matters: the demo environment may not have RediSearch on
day 1. We want code that doesn't crash on a Redis that lacks the
search module, while still doing the right thing on production.
"""
import logging
import time
from typing import TypedDict

import sentry_sdk

from backend.config import EMBEDDING_DIM
from backend.services.embeddings import embed_concept, embed_concepts_batch
from backend.services.redis_client import get_redis

logger = logging.getLogger(__name__)

INDEX_NAME = "vibeschool_concepts"

# Internal state — once flipped to True the index is ready for queries.
# Reads/writes become no-ops when False (so callers don't crash on a
# Redis that lacks RediSearch).
_index_ready: bool = False
_warned_unavailable: bool = False


class SimilarConcept(TypedDict):
    """Top-K hit from a vector search. Returned to the LLM as a
    retrieval-augmented few-shot example."""
    concept_id: str
    concept_name: str
    roast_text: str
    question_text: str
    source_type: str  # "pr" | "commit"
    pr_number_or_sha: str
    repo: str
    score: float  # cosine similarity, 0..1


def _warn_once(msg: str) -> None:
    global _warned_unavailable
    if not _warned_unavailable:
        logger.warning(msg)
        _warned_unavailable = True


async def ensure_index() -> bool:
    """Create the RediSearch index if it doesn't exist.

    Returns True on success (or already-exists), False if RediSearch
    isn't available — in which case all subsequent calls are no-ops.
    """
    global _index_ready
    if _index_ready:
        return True

    r = await get_redis()
    try:
        # FT.CREATE — only create if it doesn't exist. fakeredis + the
        # real RediSearch both accept `IF NOT EXISTS` via FT.INFO check;
        # we do the cheap check first to avoid command-not-supported
        # errors on servers without the module.
        try:
            await r.execute_command("FT.INFO", INDEX_NAME)
            _index_ready = True
            return True
        except Exception:
            pass  # index doesn't exist — create it

        await r.execute_command(
            "FT.CREATE", INDEX_NAME,
            "ON", "HASH",
            "PREFIX", "1", "vsc:",
            "SCHEMA",
            "user_id", "TAG",
            "concept_id", "TAG",
            "concept_name", "TEXT",
            "roast_text", "TEXT",
            "question_text", "TEXT",
            "source_type", "TAG",
            "pr_number_or_sha", "TAG",
            "repo", "TAG",
            "created_at", "NUMERIC", "SORTABLE",
            "embedding", "VECTOR", "HNSW", "6",
                "TYPE", "FLOAT32",
                "DIM", str(EMBEDDING_DIM),
                "DISTANCE_METRIC", "COSINE",
        )
        _index_ready = True
        return True
    except Exception as e:
        # RediSearch likely missing — log once, mark unavailable.
        err = type(e).__name__
        if "unknown command" in str(e).lower() or "FT" in str(e) or "module" in str(e).lower():
            _warn_once(
                f"RediSearch not available on this Redis ({err}); "
                "vector_store functions will be no-ops. "
                "Enable RediSearch / Redis Stack to activate retrieval."
            )
        else:
            _warn_once(f"vector_store.ensure_index failed: {err}")
            sentry_sdk.capture_exception(e)
        _index_ready = False
        return False


async def index_concept(
    user_id: str,
    concept_id: str,
    concept_name: str,
    roast_text: str,
    question_text: str = "",
    source_type: str = "pr",
    pr_number_or_sha: str = "",
    repo: str = "",
) -> None:
    """Embed a concept and write it to the vector index.

    The embedding covers "{name}" — short and stable. Roast + question
    text is stored as metadata (TAG / TEXT) for hit-list rendering and
    for retrieval injection, but NOT used in the embedding itself
    (would create circular similarity).

    Fire-and-forget: callers don't await this in the hot path; a failure
    is captured to Sentry and logged, never raised.
    """
    try:
        if not await ensure_index():
            return
        embedding = await embed_concept(concept_name)
        r = await get_redis()
        key = f"vsc:{user_id}:{concept_id}"
        # HSET is O(1) on a single key. Float32 vector is packed as bytes.
        import struct
        vec_bytes = struct.pack(f"<{len(embedding)}f", *embedding)
        await r.hset(
            key,
            mapping={
                "user_id": user_id,
                "concept_id": concept_id,
                "concept_name": concept_name,
                "roast_text": (roast_text or "")[:500],
                "question_text": (question_text or "")[:500],
                "source_type": source_type,
                "pr_number_or_sha": pr_number_or_sha,
                "repo": repo,
                "created_at": int(time.time()),
                "embedding": vec_bytes,
            },
        )
    except Exception as e:
        sentry_sdk.capture_exception(e)
        # Fire-and-forget: never block the caller's flow.
        return


async def index_concepts_batch(
    user_id: str,
    items: list[dict],
) -> None:
    """Bulk-index multiple concepts in a single embedding call.

    `items` is a list of dicts with keys: concept_id, concept_name,
    roast_text, question_text, source_type, pr_number_or_sha, repo.
    Faster than calling index_concept per item (one HTTP round-trip
    to Voyage instead of N).
    """
    if not items:
        return
    try:
        if not await ensure_index():
            return
        texts = [(it["concept_name"], "") for it in items]
        embeddings = await embed_concepts_batch(texts)
        r = await get_redis()
        pipe = r.pipeline()
        import struct
        for it, vec in zip(items, embeddings):
            key = f"vsc:{user_id}:{it['concept_id']}"
            vec_bytes = struct.pack(f"<{len(vec)}f", *vec)
            pipe.hset(
                key,
                mapping={
                    "user_id": user_id,
                    "concept_id": it["concept_id"],
                    "concept_name": it["concept_name"],
                    "roast_text": (it.get("roast_text") or "")[:500],
                    "question_text": (it.get("question_text") or "")[:500],
                    "source_type": it.get("source_type", "pr"),
                    "pr_number_or_sha": it.get("pr_number_or_sha", ""),
                    "repo": it.get("repo", ""),
                    "created_at": int(time.time()),
                    "embedding": vec_bytes,
                },
            )
        await pipe.execute()
    except Exception as e:
        sentry_sdk.capture_exception(e)
        return


async def find_similar(
    user_id: str,
    query_text: str,
    k: int = 5,
    exclude_concept_id: str = "",
) -> list[SimilarConcept]:
    """Return the top-K most similar concepts for `query_text`, scoped
    to this user. Used as RAG context for Claude's extraction prompt.

    If `exclude_concept_id` is set, the matched concept itself is
    filtered out (useful when re-ingesting an existing concept).
    """
    try:
        if not await ensure_index():
            return []
        embedding = await embed_concept(query_text)
        r = await get_redis()
        import struct
        vec_bytes = struct.pack(f"<{len(embedding)}f", *embedding)
        # FT.SEARCH <idx> "*=>[KNN k @embedding $vec]" PARAMS 2 vec <bytes>
        # FILTER (exclude self if provided) SORTBY __embedding_score
        args = [
            "FT.SEARCH", INDEX_NAME,
            f"*=>[KNN {k} @embedding $vec AS score]",
            "PARAMS", "2", "vec", vec_bytes,
            "FILTER", f"@user_id:{{{user_id}}}",
            "SORTBY", "score", "ASC",  # COSINE distance: smaller = closer
            "LIMIT", "0", str(k + (1 if exclude_concept_id else 0)),
            "DIALECT", "2",
        ]
        if exclude_concept_id:
            args.insert(-2, f"@concept_id:{{{exclude_concept_id}}}")  # negative filter
        raw = await r.execute_command(*args)
        return _parse_knn_response(raw, exclude_concept_id)
    except Exception as e:
        sentry_sdk.capture_exception(e)
        return []


def _decode(v) -> str:
    """Decode a FT.SEARCH field value that may arrive as bytes or str."""
    if isinstance(v, bytes):
        return v.decode("utf-8", errors="replace")
    return str(v)


def _parse_knn_response(raw, exclude_concept_id: str) -> list[SimilarConcept]:
    """FT.SEARCH returns [count, key1, [field, value, ...], ...].

    KNN with COSINE returns the distance as the score field; similarity
    is `1 - distance` (clamped to [0, 1]).
    """
    if not raw or not isinstance(raw, list) or len(raw) < 2:
        return []
    count = raw[0]
    if not isinstance(count, int) or count == 0:
        return []
    out: list[SimilarConcept] = []
    # raw[1:] alternates: [key, [field, value, ...]]
    i = 1
    while i + 1 < len(raw):
        key = _decode(raw[i])
        fields = raw[i + 1]
        if not isinstance(fields, list):
            i += 2
            continue
        d: dict[str, str] = {}
        for j in range(0, len(fields) - 1, 2):
            d[_decode(fields[j])] = _decode(fields[j + 1])
        cid = d.get("concept_id", "")
        if exclude_concept_id and cid == exclude_concept_id:
            i += 2
            continue
        try:
            score = float(d.get("score", "1"))
        except (TypeError, ValueError):
            score = 1.0
        out.append(SimilarConcept(
            concept_id=cid,
            concept_name=d.get("concept_name", ""),
            roast_text=d.get("roast_text", ""),
            question_text=d.get("question_text", ""),
            source_type=d.get("source_type", "pr"),
            pr_number_or_sha=d.get("pr_number_or_sha", ""),
            repo=d.get("repo", ""),
            score=max(0.0, min(1.0, 1.0 - score)),
        ))
        i += 2
    return out


async def delete_user_concepts(user_id: str) -> int:
    """Drop every vector-indexed concept for `user_id`. Used by the
    demo reset script so a re-sync starts with a clean index."""
    try:
        if not await ensure_index():
            return 0
        r = await get_redis()
        keys = []
        async for k in r.scan_iter(match=f"vsc:{user_id}:*"):
            keys.append(k)
        if not keys:
            return 0
        await r.delete(*keys)
        return len(keys)
    except Exception as e:
        sentry_sdk.capture_exception(e)
        return 0


async def health_check() -> dict:
    """Return a small dict describing vector_store state.

    Useful for the /health endpoint and for the Sentry startup probe.
    """
    return {
        "index_ready": _index_ready,
        "index_name": INDEX_NAME,
        "embedding_dim": EMBEDDING_DIM,
        "warned_unavailable": _warned_unavailable,
    }
