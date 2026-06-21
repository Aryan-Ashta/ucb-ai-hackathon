# Agent Path 3 — Ingestion RAG Pipeline Fixes

**Owner scope:** Backend `services/sync.py`, `services/vector_store.py`, `services/embeddings.py`, `services/redis_client.py:_schedule_vector_index + cache_quiz_content` (only the index-scheduling parts), `services/claude.py:extract_concepts_and_cache + _PRIOR_EXAMPLES_SUFFIX` (only the extraction + prompt-size parts).
**Do NOT touch:** `app/dashboard/`, `app/quiz/[id]/`, `routers/quiz.py:grade_answer`, `dependencies/auth.py`, `services/sm2.py`, anything in `_load_concept_envelopes_bulk` (Path 2 owns that file region).
**Estimated total:** ~2 hours across 9 fixes.
**Goal:** Make the vector index writes reliable + batched + idempotent + dimension-safe.

## Background

Three subagent dataflow traces (2026-06-21) surfaced 13 issues in the ingestion RAG pipeline. The RAG layer is wired end-to-end but is not production-safe:

1. **Vector index drifts permanently out of sync** when any index-side write fails (fire-and-forget + no retry + `mark_pr_processed` runs after, so re-syncs skip the PR).
2. **Per-concept Voyage POSTs** when a batch API is already implemented but unused — burns Voyage rate limit on a 100-commit sync.

Source trace: `/tmp/trace_1_ingestion.md` (200 lines). Source doc: `NEXT.md`.

## Files you own

```
backend/services/sync.py                  — orchestrator; _ingest_pr / _ingest_commit / _retrieve_prior_examples / _topic_query
backend/services/vector_store.py           — ensure_index / index_concept / find_similar / _index_ready / _warned_unavailable
backend/services/embeddings.py            — embed_concept / embed_concepts_batch / _hash_embedding
backend/services/redis_client.py          — ONLY cache_quiz_content + _schedule_vector_index + concept_id_user (was renamed extract_user_id)
backend/services/claude.py                 — ONLY extract_concepts_and_cache + _PRIOR_EXAMPLES_SUFFIX + _format_prior_examples
```

**Read these before starting:**
- `/tmp/trace_1_ingestion.md` — the full 200-line trace report
- `backend/services/http_client.py` — the shared httpx singleton pattern (for batch concurrency)
- `backend/services/redis_client.py:_flatten_concept` — how the concept payload is stored (you must extend it if you change the index shape)

## Fixes (ordered by demo-impact)

### 1. [HIGH] Convert per-concept to batch indexing (Trace 1 H2)
**Where:** `backend/services/redis_client.py:118-160` (`_schedule_vector_index`, the per-concept path) + `backend/services/claude.py:extract_concepts_and_cache` (the source of the concept list).
**What:**
1. In `extract_concepts_and_cache`, collect extracted concepts into a list (`concepts`); after the loop, call `await vector_store.index_concepts_batch(user_id, [{"concept_id": ..., "concept_name": ..., "roast_text": ..., "question_text": ..., "source_type": ..., "pr_number_or_sha": ..., "repo": ...}, ...])` once.
2. Delete `_schedule_vector_index` and the `asyncio.create_task` indirection — the call site already knows the full list.
3. Use `http_client.shared_client("voyage")` (already exists) so the batch HTTP call reuses the connection pool.

**Verify:** Existing `test_redis.py` + `test_embeddings.py` + `test_vector_store.py` should pass; add a test in `test_sync.py` that ingests a PR with multiple concepts and asserts `index_concepts_batch` was called once with the full list.
**Time:** 30 min.

### 2. [HIGH] Persistent reindex queue (Trace 1 H1)
**Where:** `backend/services/redis_client.py:cache_quiz_content` + a new `backend/services/reindex_worker.py`.
**What:**
1. In `cache_quiz_content`, after the SET pipeline, do `pipe.sadd(f"pending_index:{user_id}", concept_id)` (also TTL the set, maybe 7 days).
2. Create `backend/services/reindex_worker.py` exposing `async def drain_pending_index(user_id) -> int` that reads the pending set, calls `vector_store.index_concept` for each, then `srem`s successful ones.
3. Wire `drain_pending_index` into `cache_quiz_content` itself (small chance of double-write is acceptable — the index HSET is idempotent).
4. Add `srem` cleanup of the pending set on success.

**Verify:** Add a test in `test_redis.py` that simulates a Voyage failure (mock `_client.post` to raise), then call `drain_pending_index` and assert the concept ended up in the index.
**Time:** 45 min.

### 3. [MED] `exclude_concept_id` dead code + buggy syntax (Trace 1 M3)
**Where:** `backend/services/vector_store.py:221, 248, 287-289`.
**What:** The parameter is never passed by any caller (`grep exclude_concept_id backend/` returns only the definition site). When used, its filter syntax is positive-inclusion (`@concept_id:{X}`) instead of exclusion (`@concept_id:{-X}`).
- **Option A (cheapest):** Delete the parameter entirely. `find_similar`'s callers don't pass it.
- **Option B (correct):** Fix the syntax to `@concept_id:{-X}` AND keep the Python-side skip (defense in depth).

Pick Option A — fewer code paths, fewer tests, and no caller is asking for this feature.
**Time:** 10 min.

### 4. [MED] Index embed shape mismatch (Trace 1 M2)
**Where:** `backend/services/vector_store.py:145` (index_concept passes `concept_name` only).
**What:** Currently embeds `concept_name` (short, no context). Query embeds `"topic: {diff}"` (long, contextual). Switch to embed `f"{concept_name}: {(roast_text or '')[:200]}"` so the vector representation includes both concept + the user's actual code context. Update both `index_concept` and `find_similar`'s `_topic_query` if needed (or add a new shape constant).
**Verify:** Update the assertion in `test_embeddings.py` if the shape changes the deterministic hash output. Likely a behavior-only change.
**Time:** 10 min.

### 5. [MED] `EMBEDDING_DIM` validation (Trace 1 M4)
**Where:** `backend/services/vector_store.py:79-104` (`ensure_index`).
**What:** When `FT.INFO` returns a hit, parse the existing index's `attributes[0].DIM` and compare to current `EMBEDDING_DIM`. If they differ, log loudly + Sentry capture + set `_index_ready = False` (so subsequent writes go to no-op). Optional: `FT.DROPINDEX` if the operator wants to reset (off by default — destructive).
**Verify:** Add a test that mocks FT.INFO returning a mismatched DIM.
**Time:** 15 min.

### 6. [MED] TTL the sticky module globals (Trace 1 M6)
**Where:** `backend/services/vector_store.py:36-39, 78-110`.
**What:** `_index_ready` and `_warned_unavailable` are sticky — once flipped, never reset. Replace with timestamp-based TTLs (e.g. reset after 5 min or after N successes). The fix is mostly mechanical: store `_last_check_ts` and re-check on next call.
**Time:** 15 min.

### 7. [MED] Memoize RAG lookup by diff hash (Trace 1 M1)
**Where:** `backend/services/sync.py:_retrieve_prior_examples` (around line 70).
**What:** Embedding a diff slice is expensive. Cache the embedding vector keyed on `hashlib.sha1(diff_text.encode()).hexdigest()[:16]` for 24h. Use a simple Redis cache: `f"embed_cache:{key}"` → JSON-serialized vector, TTL 86400.
**Verify:** Add a test that calls `_retrieve_prior_examples` twice with the same diff and asserts Voyage was called once.
**Time:** 20 min.

### 8. [LOW] Cap-leak accounting (Trace 1 L1)
**Where:** `backend/services/sync.py:154` (in `_ingest_commit`).
**What:** When `summary["commits_seen"] > max_commits`, the function returns silently but doesn't increment `commits_skipped`. Fix the accounting so `commits_seen == commits_processed + commits_skipped`.
**Time:** 10 min.

### 9. [LOW] Prompt-size guard (Trace 1 L3)
**Where:** `backend/services/claude.py:_format_prior_examples`.
**What:** Today the suffix adds ~1KB at k=5. Add a hard cap (e.g. 4KB total) and truncate `roast_text` per example to stay within budget. Log a Sentry breadcrumb if the cap fires.
**Time:** 10 min.

## Optional (only if time allows)

- **C20 (Trace 1 L2):** `_schedule_vector_index` swallows `RuntimeError` silently. Add a Sentry breadcrumb so the operator knows about indexing failures.
- **C21 (Trace 1 L3):** Already in #9 above.

## Verification (run before committing each fix)

```bash
cd /Users/aryanashta/Documents/GitHub/ucb-ai-hackathon
source .venv/bin/activate

# Backend tests
python -m pytest backend/tests/test_sync.py backend/tests/test_redis.py backend/tests/test_vector_store.py backend/tests/test_embeddings.py backend/tests/test_sync_router.py -q

# Full suite (catch anything that broke elsewhere)
python -m pytest -q
```

## Commit conventions

- One commit per fix, prefixed `feat(rag):` or `fix(rag):` or `perf(rag):`.
- For #1 and #2 (the HIGH items), include the test in the same commit.
- Reference the trace issue code in the commit body.

## Sign-off (what "done" looks like)

- All 7 HIGH/MED items above committed.
- Backend `pytest` green.
- A demo sync with multiple concepts in one PR produces ONE batch Voyage call, not N.
- If Voyage 429s, the failing concepts end up in `pending_index:{u}` and get drained on the next cache write.
- Changing `EMBEDDING_DIM` in `.env` causes a loud error, not silent corruption.
