# Agent Path 1 — Quiz Hot Path Fixes

**Owner scope:** Frontend `app/quiz/[id]/`, backend `routers/quiz.py`, `services/claude.py:grade_answer`, `services/sm2.py`, frontend `lib/api.ts` (transcribe/grade/schedule wrappers).
**Do NOT touch:** anything in `app/dashboard/`, `services/sync.py`, `services/vector_store.py`, `services/embeddings.py`, `services/redis_client.py:_schedule_vector_index` (Path 3's territory).
**Estimated total:** ~2 hours across 10 fixes.
**Goal:** Make the quiz hot path demo-ready (calendar event appears) + secure (no soft IDOR) + resilient (no zombie fetches).

## Background

Three subagent dataflow traces (2026-06-21) surfaced 19 issues in the quiz path. The biggest single blocker: **`/api/schedule-review` is fully implemented and tested on the backend but the frontend never calls it** — the Poke calendar demo pillar is silently dropped on every quiz.

Source trace: `/tmp/trace_2_quiz.md` (full detail). Source doc: `NEXT.md` (project-wide priorities).

## Files you own

```
frontend/app/quiz/[id]/page.tsx         — orchestrator
frontend/app/quiz/[id]/panels.tsx      — leave as-is (already covered by 23 panel tests)
frontend/lib/api.ts                    — add scheduleReview() wrapper, drop user_id from gradeAnswer
backend/routers/quiz.py                — IDOR check, already has the cap+MIME
backend/routers/concepts.py            — co-located; only if you need a /api/concepts/related endpoint
backend/services/claude.py             — grade_answer() only (do NOT touch extract_concepts_and_cache)
backend/services/sm2.py                — only if doing the atomicity fix (C12)
```

**Read these before starting:**
- `/tmp/trace_2_quiz.md` — the 68-line trace report with file:line citations for every issue
- `frontend/lib/api-error.ts` — the `isAbortError` helper already exists; reuse it
- `backend/services/concept_ids.py` — has `parse_concept_id` for the IDOR check

## Fixes (ordered by demo-impact)

### 1. [HIGH] Wire `schedule-review` call from frontend (Trace 2 H1)
**Where:** `frontend/lib/api.ts` (add `api.scheduleReview()`), `frontend/app/quiz/[id]/page.tsx:69-101` (call it).
**What:** After `setGrade(g)` at `page.tsx:92`, fire-and-forget `api.scheduleReview(session?.accessToken, { concept_id: concept.id, transcript: "" })`. The backend already does the right thing — it pulls `user_calendar_id` from the env-supplied `POKE_USER_CALENDAR_ID`. The frontend just needs to make the call.
**Verify:** quiz on a real concept → calendar event appears. Existing `test_schedule_router.py` covers the backend.
**Time:** 5 min.

### 2. [HIGH] AbortController on grading path (Trace 2 H2)
**Where:** `frontend/app/quiz/[id]/page.tsx:69-101`.
**What:** Lift `ctrl` to a `useRef<AbortController | null>` so the mount-effect cleanup (line 70) can abort it. Pass `ctrl.signal` into `transcribeAudio` and `gradeAnswer`. Currently `runGrading` creates a fresh local controller that's never cancelled — wasted API quota on navigation, plus React "setState on unmounted component" warnings.
**Verify:** Existing tests should still pass; add one new test in `frontend/app/quiz/[id]/page.test.tsx` that asserts the abort signal is fired on unmount mid-grading.
**Time:** 15 min.

### 3. [HIGH] Drop dead `user_id` field from GradeRequest (Trace 2 H3)
**Where:** `frontend/app/quiz/[id]/page.tsx:67,91` (parse + send), `frontend/lib/api.ts:199-210` (mock path sends it), `backend/routers/quiz.py:79-81` (Pydantic model).
**What:** Server already derives user_id from `get_current_user` (see `quiz.py:87,98`). Delete `userId = id.split(":")[0]` and the `user_id` field from the request. Update `mockGrade` in `lib/mock.ts` accordingly.
**Why:** Documented wrong trust boundary for future readers. Dead code is misleading.
**Time:** 10 min.

### 4. [HIGH] Soft IDOR on `/api/transcribe` and `/api/grade` (Trace 2 H4)
**Where:** `backend/routers/quiz.py:39` (transcribe), `:87` (grade).
**What:** Concept IDs are `<github_id>:<pr>:<slug>`. Today `get_quiz_content(user["id"], req.concept_id)` happily reads whatever's sent. Add a guard: `if not req.concept_id.startswith(user["id"]): raise HTTPException(403, "concept does not belong to this user")`. Reuse `parse_concept_id` from `backend/services/concept_ids.py` for a stricter check (validate `parts.user_id == user["id"]`).
**Verify:** Add 2 tests in `backend/tests/test_quiz_router.py` — one valid, one IDOR attempt returns 403.
**Time:** 10 min.

### 5. [HIGH→MED once #1 is in] Claude grading timeout (Trace 2 M4)
**Where:** `backend/services/claude.py:grade_answer`.
**What:** Wrap the Claude call in `asyncio.wait_for(coro, timeout=20)`. Single-worker deploy means one stuck Claude call pins the entire app. Catch `TimeoutError` and return `{"passed": False, "quality": 0, "explanation": "Grading timed out — please try again."}`.
**Verify:** Add a test in `backend/tests/test_claude.py` mocking a slow call that exceeds 20s.
**Time:** 10 min.

### 6. [MED] AbortError leaves "thinking" stuck (Trace 2 M7)
**Where:** `frontend/app/quiz/[id]/page.tsx:94-95`.
**What:** When `isAbortError(err)` is true, transition to `intro` (or a new `cancelled` phase). Currently AbortError is silently swallowed and the spinner hangs forever. The fix pairs with #2.
**Time:** 5 min.

### 7. [MED] Client-side audio size pre-flight (Trace 2 M1)
**Where:** `frontend/lib/useRecorder.ts:113` (after `stop()`), or `frontend/app/quiz/[id]/page.tsx` before calling `runGrading`.
**What:** If `blob.size > 10 * 1024 * 1024`, set `errorMsg` + `phase = "failed"` and return. Same for MIME if you can detect it (browsers usually produce `audio/webm`).
**Verify:** Add a test in `useRecorder.test.ts` or new file.
**Time:** 10 min.

### 8. [MED] Double-tap recording guard (Trace 2 M6)
**Where:** `frontend/lib/useRecorder.ts:53` (`start()`).
**What:** Early-return if `state !== "idle"`. Currently double-tapping the orb during `requesting` state creates two MediaStreams.
**Verify:** Add a test in `useRecorder.test.ts`.
**Time:** 5 min.

### 9. [MED] Typed-answer double-submit window (Trace 2 M8)
**Where:** `frontend/app/quiz/[id]/panels.tsx` `TypingPanel`.
**What:** Disable submit button when `phase !== "typing"`. Currently Cmd+Enter can fire twice in the gap between click and state update.
**Time:** 5 min.

### 10. [MED] Deepgram progress indicator (Trace 2 M3) — DEFER if short on time
**Where:** `frontend/app/quiz/[id]/panels.tsx:200-217` `ThinkingPanel`.
**What:** Show elapsed seconds. Pass `seconds` prop from `useRecorder` (already exists). Don't tackle Deepgram `interim_results` streaming — bigger change.
**Time:** 15 min.

## Optional (only if time allows)

- **C12 (Trace 2 M5):** SM-2 non-atomic update. Wrap in Lua or `WATCH/MULTI`. Probably unreachable today.
- **C22 (Trace 2 L2):** Tighten mock-mode delays (1.1s transcribe → 600ms, 1.3s grade → 600ms).

## Verification (run before committing each fix)

```bash
cd /Users/aryanashta/Documents/GitHub/ucb-ai-hackathon
source .venv/bin/activate

# Backend tests
python -m pytest backend/tests/test_quiz_router.py backend/tests/test_claude.py backend/tests/test_claude_envelope.py -q

# Frontend tests
cd frontend && bun run test && bun x tsc --noEmit && bun run build
```

## Commit conventions

- One commit per fix, prefixed `fix(quiz):` or `feat(quiz):`.
- Always include both the source change AND the test in the same commit.
- Reference the trace issue code in the commit body, e.g. `(Trace 2 H1)`.

## Sign-off (what "done" looks like)

- All 7 HIGH/MED items above committed.
- Backend `pytest` green (195 → ~200 with the new tests).
- Frontend `bun run test` green (114 → ~118).
- `bun run build` green, TypeScript clean.
- A demo run on a real concept produces a real calendar event via Poke.
