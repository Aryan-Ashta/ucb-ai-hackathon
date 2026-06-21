# NEXT.md — Post-trace priorities for VibeSchool

> Generated 2026-06-21 from three subagent dataflow traces:
> - **Trace 1** (ingestion RAG pipeline): 13 issues (2H/7M/4L)
> - **Trace 2** (quiz hot path): 19 issues (4H/8M/7L)
> - **Trace 3** (dashboard render): 11 issues (2H/5M/4L)
>
> **Total: 43 issues** identified across 23 backend + frontend files.

## TL;DR — What's blocking the demo

If we shipped today with zero fixes:

1. **🔴 Calendar demo pillar silently broken.** `/api/schedule-review` works end-to-end (router, service, 7 tests passing) — but **the frontend never calls it.** Judges will watch the user finish a quiz and no calendar event appears.
2. **🟡 Roasts won't reference prior concepts.** The vector index writes are fire-and-forget per concept (100–500 Voyage POSTs per sync) and drift permanently out of sync on any failure. The whole RAG layer is "wired but not running reliably."
3. **🟡 User stranded on broken dashboard if their GitHub token expires mid-demo.** 401 returns the friendly "session expired" message but doesn't sign them out.

We can fix #1 in ~10 minutes. Fixing #2 properly is a 1-2 hour batch refactor. #3 is a 5-minute guard.

---

## Tier A — Fix before the demo (~30 min total)

These are small, high-leverage, and demo-visible. Do them in order.

| # | Issue | Where | Fix |
|---|---|---|---|
| **A1** | Quiz trace HIGH-1: `schedule-review` endpoint never called from frontend | `frontend/lib/api.ts` + `frontend/app/quiz/[id]/page.tsx:69-101` | Add `api.scheduleReview(token, {concept_id, transcript: ""})` and fire-and-forget after `setGrade(g)`. ~5 lines. |
| **A2** | Quiz trace HIGH-2: `runGrading` doesn't share the page-level AbortController | `frontend/app/quiz/[id]/page.tsx:69-101` | Lift `ctrl` to a `useRef`; abort it in the mount-effect cleanup; pass `signal` into `transcribeAudio`/`gradeAnswer`. ~10 lines. |
| **A3** | Dashboard trace HIGH-1: 401 doesn't sign the user out | `frontend/app/dashboard/page.tsx:104-107` + `frontend/lib/api-error.ts` | In the catch block, if `err instanceof ApiError && err.status === 401`, call `signOut({ callbackUrl: "/" })`. ~3 lines. |
| **A4** | Quiz trace HIGH-3: dead `user_id` field documents wrong trust boundary | `frontend/app/quiz/[id]/page.tsx:67,91` + `frontend/lib/api.ts:199-210` | Drop `userId` parse + the field from `GradeRequest`. Server already derives user_id from `get_current_user`. ~5 lines. |
| **A5** | Quiz trace MED-4: Claude grading has no timeout | `backend/services/claude.py:224-228` | Wrap in `asyncio.wait_for(coro, timeout=20)`. One stuck Claude call pins the single-worker deploy. ~5 lines. |

---

## Tier B — Fix before next iteration (~1-2 hours)

### B1. Ingestion RAG — convert per-concept to batch (HIGH-2 + M7 from Trace 1)
The vector index writes are fire-and-forget per concept (`redis_client.py:120-160`), one Voyage POST each. A 100-commit sync with 1-5 concepts each = 100-500 POSTs, parallel via `asyncio.create_task`, no semaphore. Burning Voyage rate limit → silent hash-fallback destruction (Trace 1 M5).

**Fix:** modify `extract_concepts_and_cache` (`claude.py:196`) to collect all extracted concepts into a list, then call `vector_store.index_concepts_batch(user_id, [...])` once per source item. Drop `_schedule_vector_index` entirely. Estimated time: **30 min**.

### B2. Ingestion RAG — persistent reindex queue (HIGH-1 from Trace 1)
Vector index permanently drifts on any index-side failure because:
- `cache_quiz_content` writes synchronously
- `_schedule_vector_index` is fire-and-forget
- `mark_pr_processed` runs after, so re-syncs skip the PR

**Fix:** write a `pending_index:<concept_id>` sentinel alongside the cache write. Add a small startup worker (`backend/services/reindex_worker.py`) that drains pending entries on boot, then deletes each sentinel after successful index. Estimated time: **45 min**.

### B3. Dashboard merged_at fix (HIGH-2 from Trace 3)
Backend already stores `merged_at` in `user:{u}:prs` HASH (`redis_client.py:331-336`). The frontend synthesizes a fake "2 days ago" because `_flatten_concept` doesn't read it back.

**Fix:** In `_load_concept_envelopes_bulk` (`redis_client.py:211`), pipeline one extra `HGETALL f"user:{user_id}:prs"` and build a `pr_to_merged_at` map. In `_flatten_concept`, add `merged_at` to the returned dict. Stop synthesizing it in `group-concepts.ts:37`. Estimated time: **15 min**.

### B4. Quiz trace HIGH-4: Soft IDOR on `/api/transcribe` and `/api/grade`
`get_quiz_content(user["id"], req.concept_id)` reads whatever's sent. Concept IDs are `<github_id>:<pr>:<slug>`, hard to enumerate but not impossible.

**Fix:** in `backend/routers/quiz.py:87` and `:39`, verify `req.concept_id.startswith(user["id"])`; return 403 otherwise. Reuse the existing `parse_concept_id` from `backend/services/concept_ids.py`. Estimated time: **10 min**.

### B5. Quiz trace MED-7: AbortError leaves "thinking" stuck
If `gradeAnswer` is aborted mid-call (A2 fix), `page.tsx:94-95` silently short-circuits — page sits on infinite spinner.

**Fix:** when AbortError is raised, transition to `intro` (or new `cancelled` state with retry). ~5 lines. Pairs with A2.

---

## Tier C — Tech debt to address when there's time

These don't break the demo but are real correctness/performance issues. Ordered by impact-to-effort ratio.

### High-impact

- **C1 (Trace 3 MED-5):** 401 from expired token produces BOTH `fetchError` banner AND `syncError` chip simultaneously. Visually noisy. Decide which wins (~5 min).
- **C2 (Trace 1 M3):** `exclude_concept_id` in `find_similar` is dead code AND its filter syntax is wrong (`@concept_id:{X}` is positive-inclusion, not exclusion). Either delete the parameter or fix the syntax + keep the Python-side skip (~10 min).
- **C3 (Trace 1 M2):** Index embeds `concept_name` only; query embeds `"topic: {diff}"`. Mismatched semantic shape — recall is weaker than it could be. Index `f"{name}: {roast[:200]}"` instead (~10 min).
- **C4 (Trace 3 MED-4):** Manual sync has no success indication. User clicks "sync", button text changes, no confirmation. Add a brief toast or summary chip (~15 min).
- **C5 (Trace 3 HIGH-2):** `merged_at` placeholder — covered by B3, but flagging the audit-cleanup follow-up: drop the `merged_at` synthesis in `group-concepts.ts` once the backend ships it.
- **C6 (Trace 1 M4):** `EMBEDDING_DIM` change silently corrupts the index. Compare existing-index `DIM` to `EMBEDDING_DIM` in `ensure_index`; refuse + log loudly or `FT.DROPINDEX` (~15 min).
- **C7 (Trace 1 M1):** RAG lookup is in the critical path. Add a memoize-by-`sha1(diff)[:16]` cache for the embedding call so repeated PRs don't pay the Voyage tax twice (~20 min).
- **C8 (Trace 3 MED-1):** `hasAutoSyncedRef` resets on remount → auto-sync can fire on `/dashboard` → `/` → `/dashboard` mid-sync. Move to `sessionStorage`, OR have `triggerSync` recognize `summary.status === "already_in_progress"` and skip the re-fetch (~15 min).

### Medium-impact

- **C9 (Trace 3 MED-2/3):** `triggerSync` POST + its re-fetch ignore `AbortController`. Trivial fix: thread `signal` through `api.triggerSync` and create a controller at the call site (~10 min).
- **C10 (Trace 2 M1):** No client-side pre-flight on audio size/MIME. Cap is enforced only at `quiz.py:48-52`. Check `blob.size > 10MB` in `useRecorder.ts:113` before posting (~10 min).
- **C11 (Trace 2 M3):** Deepgram timeout = 30s with no UI progress indicator. Show elapsed seconds in `ThinkingPanel` (~15 min).
- **C12 (Trace 2 M5):** SM-2 update is non-atomic (GET → mutate → SET pipeline). Wrap in Lua or `WATCH/MULTI`. Probably unreachable today (~20 min).
- **C13 (Trace 2 M6):** Double-tap of recording orb during `requesting` state creates two streams. Early-return in `start()` when `state ≠ "idle"` (~3 min).
- **C14 (Trace 2 M8):** Typed-answer double-submit window. Disable submit button when `phase !== "typing"` (~5 min).
- **C15 (Trace 1 M6):** `_index_ready` + `_warned_unavailable` are sticky module globals. TTL the flags (reset after 5 min or after N successes) (~15 min).

### Low-impact / cosmetic

- **C16 (Trace 3 LOW-1):** `commit_sha` `localeCompare` is alphabetical, not chronological. Either drop the sort or sort by `next_review` ascending (~5 min).
- **C17 (Trace 3 LOW-2):** Legacy data without `source_type` renders `${repo}#0`. One-line guard in `DueCard` provenance (~5 min).
- **C18 (Trace 3 LOW-3):** `triggerSync` swallows "no new concepts" silently. Show "you're up to date" toast when summary.processed counts are 0 (~10 min).
- **C19 (Trace 1 L1):** Cap-leak accounting in `_ingest_commit` — `commits_seen != commits_processed + commits_skipped` when the cap fires. Fix accounting (~10 min).
- **C20 (Trace 1 L2):** `_schedule_vector_index` swallows `RuntimeError` silently. Add a Sentry breadcrumb (~3 min).
- **C21 (Trace 1 L3):** `_PRIOR_EXAMPLES_SUFFIX` has no prompt-size guard. Truncate total to N KB (~5 min).
- **C22 (Trace 2 L2):** Mock-mode transcribe (1.1s) + grade (1.3s) delays feel laggy. Tighten to ~600ms each (~3 min).

---

## Recommended execution order

| Step | Time | What |
|---|---|---|
| **0** | now | Tier A (A1-A5): all 5 fixes, ~30 min. **This unblocks the demo.** |
| **1** | +30 min | Tier B (B1-B5): ~1.5 hours. The RAG layer actually works reliably + quiz is correct. |
| **2** | +2 hours | Tier C high-impact (C1-C8): ~2 hours. Polish + real tech debt. |
| **3** | +4 hours | Tier C medium (C9-C15): ~1.5 hours. |
| **4** | +5.5 hours | Tier C low (C16-C22): ~45 min. Cosmetic. |

**Total to demo-ready + RAG-correct: ~2 hours.**
**Total to demo-ready + RAG-correct + all polish: ~6 hours.**

---

## What's already solid (per the three traces)

The traces also surfaced what NOT to touch. These were called out as working correctly:

- **Per-user Redis sync lock** (`acquire_sync_lock`, 5-min NX-EX TTL) prevents Claude double-billing on concurrent syncs.
- **Idempotency hash** (`mark_pr_processed` / `mark_commit_processed`) cleanly disambiguates PRs vs commits via `c-` prefix.
- **Graceful degradation everywhere**: every external API (Voyage, Bear-2, Claude, Deepgram, Poke) has a Sentry-captured failure path that never bubbles to the user.
- **Shared httpx client** (Tier 2.8 of the prior refactor) — proper TCP keep-alive.
- **Bulk Redis pipeline** (`_load_concept_envelopes_bulk` from P2-B1) collapses 2N round-trips to 1.
- **`concept_ids.py`** is a single source of truth for the encoder/decoder contract.
- **Auth cache** is properly bounded (`TTLCache(maxsize=10_000, ttl=60)`).
- **`_safe_update_sm2_state`** correctly translates `ValueError` → 404.
- **`isAbortError`** handles both DOMException shapes cleanly.
- **TokenRouter plumbing** (`USE_TOKENROUTER`) is wired but defaults to direct Anthropic — no surprise behavior.
- **Mock / live parity** in `lib/api.ts:160-210` keeps UI identical across modes.
- **114 frontend tests + 195 backend tests** all green; coverage at 93%.

---

## Related artifacts

- `/tmp/trace_1_ingestion.md` — full ingestion RAG trace (200 lines)
- `/tmp/trace_2_quiz.md` — full quiz hot-path trace (68 lines)
- `/tmp/trace_3_dashboard.md` — full dashboard render trace (101 lines)
- `STATUS.md` — current test + coverage snapshot
- ROADMAP.md — original build plan (all P1/P2/P3 marked closed)
