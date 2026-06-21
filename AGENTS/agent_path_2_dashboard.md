# Agent Path 2 — Dashboard Render + 401 Auth Flow Fixes

**Owner scope:** Frontend `app/dashboard/`, `frontend/lib/api-error.ts`, `frontend/lib/group-concepts.ts`, `frontend/lib/format.ts` (read-only), `frontend/lib/api.ts` (only the 401-handling wrapper), `backend/dependencies/auth.py`, `backend/services/redis_client.py:_load_concept_envelopes_bulk + _flatten_concept` (the merged_at addition only).
**Do NOT touch:** anything in `app/quiz/[id]/` (Path 1's territory), `services/sync.py`, `services/vector_store.py`, `services/embeddings.py`, `services/redis_client.py:_schedule_vector_index` (Path 3's territory).
**Estimated total:** ~1.5 hours across 10 fixes.
**Goal:** Make the dashboard resilient to expired tokens + show real `merged_at` values + clean up UX rough edges.

## Background

Three subagent dataflow traces (2026-06-21) surfaced 11 issues in the dashboard render path. Two are HIGH and demo-impacting:
1. **401 from expired token shows a friendly message but never signs the user out** — they get stranded on a broken dashboard.
2. **`merged_at` placeholder is fixable for ~10 lines** — backend already stores it; we just don't read it back through the flat `/api/concepts` response.

Source trace: `/tmp/trace_3_dashboard.md` (101 lines). Source doc: `NEXT.md`.

## Files you own

```
frontend/app/dashboard/page.tsx                — orchestrator
frontend/app/dashboard/components.tsx           — leave as-is (covered by 11 component tests)
frontend/lib/group-concepts.ts                  — drop the merged_at synthesis after backend lands it
frontend/lib/api-error.ts                       — the friendly mapper (already centralized)
frontend/lib/api.ts                             — only the apiFetch / 401 detection surface
backend/dependencies/auth.py                    — leave cache TTL alone; just confirm 401 path
backend/services/redis_client.py                — ONLY _load_concept_envelopes_bulk + _flatten_concept (merged_at)
backend/services/concept_ids.py                 — read-only (uses existing extract_user_id, parse_concept_id)
```

**Read these before starting:**
- `/tmp/trace_3_dashboard.md` — the 101-line trace report
- `backend/services/concept_ids.py:24-50` — `parse_concept_id` returns `(pr_number, commit_sha, source_type)`

## Fixes (ordered by demo-impact)

### 1. [HIGH] Sign user out on 401 (Trace 3 H1)
**Where:** `frontend/app/dashboard/page.tsx:104-107` (the fetch catch block).
**What:** When `err instanceof ApiError && err.status === 401`, call `signOut({ callbackUrl: "/" })`. Currently the user sees "Your session expired" in a banner but the page stays broken — clicking sign-out manually in the header is the only recovery.
**Verify:** Mock `useSession` to return null + mock the api module to return 401; assert `signOut` was called. Add a test in `frontend/app/dashboard/page.test.tsx`.
**Time:** 10 min.

### 2. [HIGH] Surface real `merged_at` (Trace 3 H2)
**Where:** `backend/services/redis_client.py:211-253` (`_load_concept_envelopes_bulk`) + `:158-189` (`_flatten_concept`), then `frontend/lib/group-concepts.ts:34-37` (drop synthesis), `frontend/lib/types.ts` (add `merged_at?: string` to `Concept`).
**What:**
1. In `_load_concept_envelopes_bulk`, add an extra `pipe.hgetall(f"user:{user_id}:prs")` call and build `pr_to_merged_at: dict[int, str]` keyed on `pr_number`.
2. In `_flatten_concept`, accept an optional `pr_to_merged_at` argument (or pass through `_load_concept_envelopes_bulk`); if `parts.source_type == "pr"`, set `merged_at = pr_to_merged_at.get(parts.pr_number)`.
3. Thread the map through `get_due_concepts` and `get_all_concepts` — signature change.
4. Add `merged_at?: string` to the `Concept` interface in `frontend/lib/types.ts`.
5. Drop the `merged_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()` synthesis at `group-concepts.ts:37`; use `pr.concepts[0].merged_at ?? fallback`.

**Verify:** Existing 29 `test_redis` cases should pass; add one new test that ingests 2 PRs with known `merged_at` and asserts the round-tripped envelope has the right value.
**Time:** 25 min.

### 3. [MED] Auto-sync remount guard (Trace 3 M1)
**Where:** `frontend/app/dashboard/page.tsx:41` (ref definition) + `:99-102` (auto-trigger).
**What:** `hasAutoSyncedRef` resets on unmount → navigating `/dashboard` → `/` → `/dashboard` mid-sync fires a second auto-sync. Two options:
- **(a) Move to `sessionStorage`:** persist the flag across remounts.
- **(b) Recognize `already_in_progress`:** in `triggerSync`, inspect `api.triggerSync` response; if `summary.status === "already_in_progress"`, skip the re-fetch.

Pick (a) — it's one line and doesn't depend on backend response shape.
**Time:** 10 min.

### 4. [MED] `triggerSync` AbortController (Trace 3 M2 + M3)
**Where:** `frontend/app/dashboard/page.tsx:57-79` (`triggerSync` body) + `frontend/lib/api.ts:130-134` (`api.triggerSync` signature).
**What:** Add optional `signal?: AbortSignal` to `api.triggerSync`. In `page.tsx`, create a `useRef<AbortController>` for the sync operation, pass its signal into both `api.triggerSync` and the post-sync re-fetch. Abort on unmount.
**Time:** 10 min.

### 5. [MED] Manual sync success indicator (Trace 3 M4)
**Where:** `frontend/app/dashboard/page.tsx:147-163` (the sync header).
**What:** Add a brief "synced ✓" pill or a `syncSummary` line that shows for ~3s after a successful sync. Currently the user sees the button text flip "syncing…" → "sync" with no confirmation.
**Time:** 15 min.

### 6. [MED] Single 401 banner (Trace 3 M5)
**Where:** `frontend/app/dashboard/page.tsx:147-156` (sync error chip) + `:206-211` (fetch error banner).
**What:** Decide which wins. If fetch failed, hide the sync chip (they're related — a 401 means the sync can't work either). Add a check at line 156: `{!fetchError && syncError && (...)}`.
**Time:** 5 min.

### 7. [LOW] `commit_sha` sort (Trace 3 L1)
**Where:** `frontend/lib/group-concepts.ts:55-58`.
**What:** Either drop the `localeCompare` sort (let input order win — it's already deterministic from `zrange`) or sort by `next_review` ascending. Comment promises "most-recent commit first" but delivers alphabetical noise.
**Update:** `frontend/lib/group-concepts.test.ts:74` to match whichever you pick.
**Time:** 5 min.

### 8. [LOW] Legacy `source_type` guard (Trace 3 L2)
**Where:** `frontend/app/dashboard/components.tsx:17-21` (DueCard provenance line).
**What:** `concept.source_type === "commit" || concept.id.includes(":c-")` — defensive against pre-P2-commit-migration data.
**Time:** 5 min.

### 9. [LOW] "No new concepts" feedback (Trace 3 L3)
**Where:** `frontend/app/dashboard/page.tsx:62-78` (triggerSync catch + success).
**What:** When `summary.prs_processed === 0 && summary.commits_processed === 0 && summary.errors.length === 0`, show a brief "you're up to date" toast.
**Time:** 10 min.

### 10. [LOW] `merged_at` audit cleanup (Trace 3 L4 / also Path 2 step 2)
**Where:** `frontend/lib/group-concepts.ts:34-37`.
**What:** After #2 lands, drop the synthesis entirely. The placeholder only existed because the backend wasn't returning the field.
**Time:** Trivial — included in #2.

## Verification (run before committing each fix)

```bash
cd /Users/aryanashta/Documents/GitHub/ucb-ai-hackathon
source .venv/bin/activate

# Backend
python -m pytest backend/tests/test_redis.py backend/tests/test_dashboard* backend/tests/test_concepts_router.py -q

# Frontend
cd frontend && bun run test && bun x tsc --noEmit && bun run build
```

## Commit conventions

- One commit per fix, prefixed `fix(dashboard):` or `feat(dashboard):`.
- For #2 (merged_at), the change is across 4 files — keep it in one commit with a clear body.
- Reference the trace issue code in the commit body.

## Sign-off (what "done" looks like)

- All 10 fixes above committed.
- Backend `pytest` green.
- Frontend `bun run test` green.
- A real sync now shows actual `merged 3h ago / yesterday / 2d ago` instead of the constant `2d ago` placeholder.
- An expired-token demo path lands the user back on `/` instead of stranding them.
