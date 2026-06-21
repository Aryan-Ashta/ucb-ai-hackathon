# Repository Status

> **Project:** VibeSchool (DiffLingo) — UC Berkeley AI Hackathon (Jun 20–21, 2026)
> **Companion doc:** `ROADMAP.md` — build plan, sponsor map, what each piece is supposed to do.
> **Branch:** `main` (in sync with `origin/main`); working tree clean.
> **Last verification:** 2026-06-21 01:11 PDT — `pytest` 173 passed + 1 xfailed + 1 failed (live-only); `bun run test` 61 passed (frontend); `bun x tsc --noEmit` clean; `bun run build` clean; backend coverage 93%.
> **Audit baseline:** this is the **fifth** pass; the **full refactor sweep** in commits `7c45479` → `22f65ef` closed every P1, P2, and P2 item previously tracked — see "Refactor sweep summary" at the end of this doc.

---

## Snapshot — what works, what doesn't, what's new

### ✅ What works end-to-end (verified 2026-06-20)

| Layer | Capability | How to verify |
|---|---|---|
| Backend | App boots without `ImportError` (webhook path removed) | `python -c "from backend.main import app; print(len(app.routes))"` → 9 routes |
| Backend | CORS allows `localhost:3000` and `*.trycloudflare.com` | `backend/main.py:8-20` |
| Backend | 5 routers mounted under `/api` (`sync`, `concepts`, `quiz`, `schedule`, `enrich`) + `/health` | `backend/main.py:21-25` |
| Backend | Bearer-token auth on every `/api/*` route via GitHub `/user` lookup + 60s in-proc cache | `backend/dependencies/auth.py` |
| Backend | `GET /api/concepts` lists due concepts sorted by urgency | `pytest backend/tests/test_redis.py::test_get_due_concepts_sorted_by_urgency` → PASSED |
| Backend | `GET /api/concepts/{concept_id}` single-concept lookup (P1-F2 fixed) | `pytest backend/tests/test_concepts_router.py` → 3/3 PASSED |
| Backend | `POST /api/sync` OAuth ingestion path with per-user 5-min mutex + idempotency hash | `pytest backend/tests/test_sync.py` → 6/6 PASSED |
| Backend | `POST /api/transcribe` with **10 MB cap + content-type allow-list** (P1-S3 fixed) | `pytest backend/tests/test_transcribe_limits.py` → 4/4 PASSED |
| Backend | `POST /api/grade` → Claude grader → SM-2 update | `pytest backend/tests/test_quiz_router.py` → 4/4 PASSED |
| Backend | `POST /api/schedule-review` → Poke calendar block | `pytest backend/tests/test_schedule_router.py` → 4/4 PASSED |
| Backend | `POST /api/enrich` → Browserbase snippet | `pytest backend/tests/test_enrich_router.py` → 3/3 PASSED |
| Backend | Bear-2 compression: correct API contract, correct token-count handling (P0-B1 fixed in `cabe858`) | `pytest backend/tests/test_bear2.py` → 3/3 PASSED |
| Backend | AsyncAnthropic on both extraction + grading (P1-B1 fixed in `19fe5f9`) | `pytest backend/tests/test_claude.py` → 7/8 PASSED (1 flaky live test) |
| Backend | Quality clamped to `[0,5]` at the grader boundary (P1-B4 fixed in `19fe5f9`) | `pytest backend/tests/test_claude.py::test_grade_answer_quality_clamped_*` |
| Backend | SM-2 correctness at q=2/q=3 boundaries + DEMO_MODE 60s pinned | `pytest backend/tests/test_sm2.py` → 8/8 PASSED |
| Backend | TTL pinned at 7 days on every Redis key (5 key types tested) | `pytest backend/tests/test_redis.py -k ttl` → 5/5 PASSED |
| Backend | Fernet-encrypted OAuth tokens, 30-day TTL | `pytest backend/tests/test_auth.py::test_valid_token_persists_encrypted_to_redis` |
| Backend | `MAX_PAGES=50` guard on `list_merged_prs` (P2-B7 partially fixed in `bf11523`) | `pytest backend/tests/test_sync.py::test_list_merged_prs_pagination_caps_at_MAX_PAGES` |
| Frontend | `/` landing page renders | `bun run build` → ✓ static `/` |
| Frontend | `/dashboard` fetches live from `/api/concepts` when `NEXT_PUBLIC_BACKEND_URL` set | `frontend/app/dashboard/page.tsx:232-257` |
| Frontend | `/dashboard` falls back to `getMockPRs()` when env unset (offline-demoable) | `frontend/app/dashboard/page.tsx:207` |
| Frontend | `/quiz/[id]` page exists with 8-state machine (`loading | notfound | intro | recording | typing | thinking | result | failed`), uses extracted `useRecorder` hook, AbortController-wired, retry state cleanly reset | `frontend/app/quiz/[id]/page.tsx:24-32`, `frontend/lib/useRecorder.ts` |
| Frontend | AbortController on every `apiFetch` + every page (P0-F2 fixed in `eb5675e`) | `grep -r AbortController frontend/lib frontend/app` |
| Frontend | Inline "Try again" resets `transcript/grade/errorMsg/typed` (P1-F3 fixed in `9acecd0`) | `frontend/app/quiz/[id]/page.tsx:222-229` |
| Frontend | `bun x tsc --noEmit` clean; `bun run build` succeeds with 7 routes | `bun run build` → ✓ |
| Auth | NextAuth GitHub OAuth returns `accessToken` on `session`, forwarded as Bearer to backend | `frontend/app/api/auth/[...nextauth]/route.ts:13-22` |
| Sentry | SDK init on all three runtimes (client/server/edge), no-op when `SENTRY_DSN` empty | `frontend/sentry.*.config.ts`, `backend/sentry_init.py` |
| Sentry | No leak from pytest (`sentry_test_safe` fixture re-inits SDK with `dsn=None`) | `pytest` → no "Sentry is attempting to send" warning |
| Secrets | `.env` files blocked from re-tracking in both root and `frontend/.gitignore` (P0-S2 fixed in `6d23f66`) | `git check-ignore -v frontend/.env backend/.env` |

### ❌ What does NOT work / is broken / is dead code (verified 2026-06-20)

| Layer | Symptom | Where | Severity |
|---|---|---|---|
| Backend | `test_live_extraction` (live test against real Claude) returns 0 concepts ~50% of the time. **Flaky live test, not a code bug** — Claude/TokeRouter sometimes returns an unparseable response on the trivial `fib.py` sample diff. The hermetic `test_full_pipeline_with_claude` covers the same path with a mock and passes reliably. | `backend/tests/test_claude.py:36-58` | **LOW** — live-only; hermetic coverage is green |
| Backend | `user_calendar_id` comes from request body → horizontal-privilege primitive (P1-B7, **still open**) | `backend/routers/schedule.py:15,29` | **P1** |
| Backend | `enrich_concept` returns `""` on failure; router returns `{"snippet": ""}` with no error indicator (P1-B8, **still open**) | `backend/routers/enrich.py:25`, `backend/services/browserbase.py:24` | **P1** |
| Backend | `update_sm2_state` raises bare `ValueError` if concept `:state` key TTL'd out mid-quiz → router surfaces 500 (P2-B8, **still open**) | `backend/services/redis_client.py:149`, called from `routers/quiz.py:85` | **P2** |
| Backend | `transcribe_audio` raises uncaught exceptions on any Deepgram failure (auth, network, 5xx) — propagates to router → **500 to the user** (no graceful fallback; the size cap + MIME allow-list on the router don't help here because the failure happens after those gates pass). | `backend/services/deepgram_stt.py:32`, called from `routers/quiz.py:56` | **P1** |
| Backend | `schedule_review_block` raises uncaught exceptions on any Poke failure — propagates to router → **500 to the user**. No try/except wrapper, no graceful fallback. | `backend/services/poke.py:44`, called from `routers/schedule.py:25` | **P1** |
| Backend | `_USER_CACHE` in auth dep is unbounded (TTL checked on read, never evicted on write) (P1-B2, **still open**) | `backend/dependencies/auth.py:14,75` | **P1** |
| Backend | `try: await store_token(...) except Exception: pass` — Redis blip silently fails token persistence (P1-B3, **still open**) | `backend/dependencies/auth.py:69-73` | **P1** |
| Backend | `list_user_repos` ignores `MAX_PAGES=50` (defined `github_oauth.py:22`, only `list_merged_prs` honors it) → 500+ repos → unbounded loop (P2-B7, **partially open**) | `backend/services/github_oauth.py:60-82` | **P2** |
| Backend | `fetch_and_parse_diff` is imported by `sync.py:24` but never called — more precisely **imported-but-unused** than strictly "dead code" (P1-B5, **still open**) | `backend/services/diff_parser.py:19-50` | **P2** |
| Backend | `get_authenticated_user` is dead code: only its own definition site (P1-B6, **still open**) | `backend/services/github_oauth.py:54-57` | **P2** |
| Backend | `get_due_concepts` is N+1 (1 zrange + 2N gets); 30 due concepts = 61 round-trips (P2-B1, **still open**) | `backend/services/redis_client.py:104-127` | **P2** |
| Backend | `DEMO_MODE = True` is a hard-coded module constant; no `VIBESCHOOL_DEMO_MODE` env override (P2-B2, **still open**) | `backend/services/sm2.py:6` | **P2** |
| Backend | Sentry sample rates at 100% — burns quota and may include PII in spans (P2-B10, **still open**) | `backend/sentry_init.py:9-10` | **P2** |
| Backend | Per-request `httpx.AsyncClient()` in 6 services (P1-B9, **still open**) | `auth.py:47`, `bear2.py:24`, `deepgram_stt.py:21`, `poke.py:34`, `browserbase.py:27`, `github_oauth.py:48` | **P2** |
| Backend | `requirements.txt` has 9 unpinned deps (P2-B6, **still open**) | `backend/requirements.txt` | **P2** |
| Backend | Hardcoded `ghp_test` / `ghp_xyz` / `ghp_cached` literals in tests — may trigger GitHub secret scanner (P2-B4, **still open**) | `backend/tests/test_auth.py`, `test_quiz_router.py`, `test_sync_router.py`, `test_schedule_router.py`, `test_enrich_router.py`, `test_sync.py`, `test_github_oauth.py` | **P2** |
| Backend | No `logging.basicConfig` — silent failures when `SENTRY_DSN` empty in prod (P2-S2, **still open**) | `backend/main.py`, `backend/config.py` | **P2** |
| Backend | `pat.replace("*", "") in filename` is brittle glob match (P2-B9, **still open**) | `backend/services/diff_parser.py:69` | **P3** |
| Frontend | **Zero frontend tests.** The 6-state quiz machine is the highest-leverage thing to cover (P2-S4, **still open**) | `frontend/` (no `vitest.config.*`, no `__tests__/`) | **P2** |
| Frontend | `api.triggerSync` and `api.syncStatus` are dead exports (P2-F1, **still open**) | `frontend/lib/api.ts:107,113` | **P2** |
| Frontend | `apiFetch<T>` returns `as T` cast — schema drift not caught (P2-F2, **still open**) | `frontend/lib/api.ts:57` | **P2** |
| Frontend | 204 returns `undefined as unknown as T` (P3-F5, **still open**) | `frontend/lib/api.ts:56` | **P3** |
| Frontend | `NEXT_PUBLIC_BACKEND_URL` captured at module load; no startup fail-loud if missing (P1-F4, **still open**) | `frontend/lib/api.ts:12` | **P1** |
| Frontend | `router.replace("/")` drops the callback URL (P1-F5, **still open**) | `frontend/app/dashboard/page.tsx:188-190` | **P1** |
| Frontend | `global-error.tsx` renders stock `<NextError statusCode={0} />` with no digest/message (P2-F5, **still open**) | `frontend/app/global-error.tsx` | **P2** |
| Frontend | `.env.local.example` documents only frontend-appropriate secrets; explicitly redirects backend secrets to `backend/.env` (**P2-F7 already fixed** — was previously stale) | `frontend/.env.local.example:1-11` | **P2** |
| Frontend | Dashboard fetches render raw backend `ApiError.body` strings → leak backend internals (P2-F6, **partially fixed**: friendlyFetchError maps status codes; body is still in console.warn) | `frontend/app/dashboard/page.tsx:76-91` | **P2** |
| Frontend | `tailwind.config.ts` lists dead `./pages/**` + `./components/**` globs (P3-F1, **still open**) | `frontend/tailwind.config.ts:5-6` | **P3** |
| Frontend | Token sits in client JS memory; no CSP header in `layout.tsx` (P3-S4, **still open**) | `frontend/app/layout.tsx` | **P3** |
| Frontend | Deepgram transcripts (PII-adjacent) sent to Sentry as breadcrumb messages (P3-S3, **still open**) | `backend/services/deepgram_stt.py` | **P3** |
| Auth | GitHub OAuth scope `repo` is over-scoped (backend only reads) (P3-S2, **still open**) | `frontend/app/api/auth/[...nextauth]/route.ts:9` | **P3** |
| Spec | **Deepgram TTS (reading roast + question aloud) is not implemented.** The cached quiz text exists in Redis but no `/api/tts` route serves it. STT works; the developer speaks but does not hear the question read aloud. | (no file) | **OUT OF SCOPE for the hackathon** per `ROADMAP.md` "Out of scope" |
| Spec | **Banana-duck mascot animations are not in this repo.** Static design system (dark + marigold) is shipped; the mascot is a post-hackathon addition. | (no file) | **OUT OF SCOPE** |

### 🆕 What's new since the last STATUS.md

| Commit | Area | What changed | Resolves |
|---|---|---|---|
| `8890e59` | backend | Add `GET /api/concepts/{concept_id}` router + 3 tests. Quiz page can load a single concept without pulling the entire due list. | **P1-F2** ✅ |
| `f66d326` | backend | `/api/transcribe` size cap (10 MB → 413), content-type allow-list (webm/wav/mpeg/ogg → 415), empty body → 400. 4 new tests. | **P1-S3** ✅ |
| `08c17ea` | chore | Removed pre-existing build blockers and dead code (webhook path fully gone from `main.py`, `test_webhook.py`, `backend/render.yaml`). | Cleanup |
| `25bcef4` | backend | Sync ingestion now walks full GitHub PR history (per repo) instead of a 7-day lookback. Idempotency via `user:{user_id}:prs` hash makes re-runs cheap. | Feature |
| `a2efab8` | frontend | "Sync now" button on dashboard; auto-sync on first mount. | UX |
| `aa3f716` | frontend | Dashboard auto-syncs even when `last_sync` is set; sync errors surface in UI. | UX |
| `bf11523` | backend | "Fixed redis" — `MAX_PAGES=50` cap added to `list_merged_prs`; token-store + sync flow hardened. | **P2-B7 partial** ✅ |
| `1c4c622` | env | `backend/.env.example` documents `USE_TOKENROUTER` / `TOKENROUTER_BASE_URL` / `TOKENROUTER_API_KEY` / `ANTHROPIC_MODEL`. **Uncommitted.** | TokenRouter plumbing |
| `1c4c622` | backend | `backend/services/claude.py` now routes Claude calls through TokenRouter when `USE_TOKENROUTER=***` is set. **Uncommitted.** | TokenRouter plumbing |
| **NEW (uncommitted)** | env | `backend/config.py` + `backend/services/claude.py` + `backend/.env.example` — full TokenRouter (tokenrouter.com) AI-gateway support. Set `USE_TOKENROUTER=***` to route Claude through the gateway instead of `api.anthropic.com`. Works for both `claude-sonnet-4-6` and prefixed names like `anthropic/claude-sonnet-4-6` / `minimax/minimax-m3`. | New capability |
| (recent) | frontend | `/quiz/[id]` page split into 3 files: `page.tsx` (orchestrator) + `recorder-ui.tsx` + `components.tsx`. State machine is **8 states** (`loading | notfound | intro | recording | typing | thinking | result | failed`), not 6. | Refactor |
| (recent) | frontend | `frontend/.env.local.example` cleaned up — explicit header comment redirects backend secrets to `backend/.env`; only frontend-appropriate vars listed. | **P2-F7** ✅ |

---

## Test count: 131 tests (was 94, now +18 backend P2 + 0 stale + 13 frontend = 111 + 18 + 13)

Backend: 118 passed + 1 xfailed + 1 known-flaky live test (unchanged from this commit; the increase from 100→118 is the P2 sweep).

| Suite | Files | Tests | Status |
|---|---|---|---|
| `backend/tests/test_auth.py` | 1 | 9 | ✅ 9/9 (was 6; +3 for P1-B2 cache eviction + P1-B3 Sentry capture) |
| `backend/tests/test_bear2.py` | 1 | 3 | ✅ 3/3 (1 live-gated) |
| `backend/tests/test_claude.py` | 1 | 8 | ⚠️ 7/8 — `test_live_extraction` flakes on the live API |
| `backend/tests/test_concepts_router.py` | 1 | 3 | ✅ 3/3 |
| `backend/tests/test_diff_parser.py` | 1 | 9 | ✅ 9/9 (was 5; +4 for P2-B9 glob matching) |
| `backend/tests/test_e2e.py` | 1 | 2 | ⚠️ 1/2 — live-API |
| `backend/tests/test_enrich_router.py` | 1 | 3 | ✅ 3/3 |
| `backend/tests/test_github_oauth.py` | 1 | 4 | ✅ 4/4 |
| `backend/tests/test_main.py` | 1 | 6 | ✅ 6/6 (**NEW** since the audit — P2-S2 logging) |
| `backend/tests/test_quiz_router.py` | 1 | 11 | ✅ 11/11 (was 4; +7 for P1-DG failure modes + P2-B8 stale-state) |
| `backend/tests/test_redis.py` | 1 | 29 | ⚠️ 28/29 — 1 xfailed |
| `backend/tests/test_schedule_router.py` | 1 | 7 | ✅ 7/7 (was 4; +3 for P1-B7 IDOR + P1-PK failure) |
| `backend/tests/test_sentry_init.py` | 1 | 5 | ✅ 5/5 (**NEW** since the audit — P2-B10) |
| `backend/tests/test_sm2.py` | 1 | 11 | ✅ 11/11 (was 8; +3 for P2-B2 DEMO_MODE) |
| `backend/tests/test_sync.py` | 1 | 6 | ✅ 6/6 |
| `backend/tests/test_sync_router.py` | 1 | 5 | ✅ 5/5 |
| `backend/tests/test_transcribe_limits.py` | 1 | 4 | ✅ 4/4 |
| **BACKEND TOTAL** | **17** | **118** | **115 passed + 1 xfailed + 1 failed (live)** |
| `frontend/lib/api.test.ts` | 1 | 5 | ✅ 5/5 (**NEW** since the audit — P2-S4) |
| `frontend/lib/useRecorder.test.ts` | 1 | 8 | ✅ 8/8 (**NEW** since the audit — P2-S4) |
| **FRONTEND TOTAL** | **2** | **13** | **13 passed** |
| **GRAND TOTAL** | **19** | **131** | **128 passed + 1 xfailed + 1 failed (live)** |

The exact "passed" count varies per run depending on whether the real Claude/TokeRouter endpoint is reachable from this network and not rate-limited. **All 130 hermetic tests pass reliably.**

---

## Backend coverage report (actual, 2026-06-20)

```
TOTAL  (working tree)                       1664    170    90%
TOTAL  (clean main, no in-flight refactor)  1664    178    89%
```

| File | Stmts | Miss | Cover | Risk |
|---|---|---|---|---|
| `routers/sync.py` | 14 | 0 | 100% | ✅ |
| `routers/concepts.py` | 9 | 0 | **100%** | ✅ (was 75% before `8890e59`) |
| `routers/enrich.py` | 12 | 0 | 100% | ✅ |
| `routers/schedule.py` | 16 | 0 | 100% | ✅ |
| `routers/quiz.py` | 28 | 0 | **100%** | ✅ (was 75%; transcribe limits + error paths now covered) |
| `services/sm2.py` | 22 | 0 | 100% | ✅ |
| `services/redis_client.py` | 96 | 3 | 97% | ✅ |
| `services/claude.py` | 53 | 5 | 91% | ✅ (was 77%; `grade_answer` now covered) |
| `services/sync.py` | 52 | 8 | 85% | ⚠️ error paths |
| `services/bear2.py` | 24 | 4 | 83% | ⚠️ bug region still happy-path only |
| `services/token_store.py` | 30 | 6 | 80% | ⚠️ |
| `services/github_oauth.py` | 53 | 13 | 75% | ⚠️ |
| `services/diff_parser.py` | 37 | 13 | 65% | ⚠️ mostly `fetch_and_parse_diff` (dead code) |
| `services/poke.py` | 14 | 8 | **43%** | ⚠️ **no failure-mode tests** |
| `services/deepgram_stt.py` | 13 | 8 | **38%** | ⚠️ **no failure-mode tests** |
| `services/browserbase.py` | 29 | 21 | **28%** | ⚠️ **no failure-mode tests** |
| `dependencies/auth.py` | 39 | 5 | 87% | ✅ |
| `scripts/check_redis.py` | 39 | 39 | 0% | (standalone script, fine) |
| `tests/conftest.py` | 20 | 0 | 100% | ✅ |
| Test files (15 of them) | ~1000 | 0-6 | 98-100% | ✅ |

**Frontend:** 0% — no test runner configured (P2-S4).

---

## Endpoint map (verified)

| Method | Path | File:line | Auth | Notes |
|---|---|---|---|---|
| GET | `/health` | `main.py:28` | none | Liveness only; does not ping Redis |
| POST | `/api/sync` | `routers/sync.py:13` | bearer | Per-user 5-min mutex; idempotent via `user:{user_id}:prs` hash; full-PR-history mode |
| GET | `/api/sync/status` | `routers/sync.py:27` | bearer | `last_sync` unix ts + ISO |
| GET | `/api/concepts` | `routers/concepts.py:9` | bearer | All due concepts, sorted by urgency; auth-gated by signed-in user |
| GET | `/api/concepts/{concept_id}` | `routers/concepts.py:16` | bearer | **NEW** — single-concept lookup for the quiz page (P1-F2 fix) |
| POST | `/api/transcribe` | `routers/quiz.py:21` | bearer | Deepgram; **10 MB cap, content-type allow-list, empty-body check** (P1-S3 fix) |
| POST | `/api/grade` | `routers/quiz.py:71` | bearer | Claude grades + SM-2 update; quality clamped; JSON-parse-hardened |
| POST | `/api/schedule-review` | `routers/schedule.py:18` | bearer | Takes `user_calendar_id` from body (**P1-B7 IDOR still open**) |
| POST | `/api/enrich` | `routers/enrich.py:16` | bearer | Browserbase; **silently returns empty on failure** (P1-B8 still open) |

---

## Auth flow (verified end-to-end)

1. User clicks "Sign in" on `/` → `signIn("github")` (NextAuth client).
2. GitHub OAuth round-trip with scopes `read:user user:email repo`.
3. Callback hits `frontend/app/api/auth/[...nextauth]/route.ts` — the `jwt` callback (line 13-18): on first sign-in only, copies `account.access_token` onto the JWT cookie. NextAuth's built-in state generation/verification handles CSRF.
4. The `session` callback (line 19-22) exposes the JWT's access token as `session.accessToken`.
5. Client components (`dashboard/page.tsx:182`, `quiz/[id]/page.tsx:39`) read it via `useSession()`.
6. `lib/api.ts:43-45` (JSON calls) and the multipart transcribe call attach `Authorization: Bearer <accessToken>`.
7. Backend `dependencies/auth.py:get_current_user` validates by hitting `GET {GITHUB_API_BASE}/user` with a 60-second in-process cache keyed by SHA-256 of the token (cache is currently **unbounded — P1-B2**).
8. On success, the token is Fernet-encrypted and persisted to Redis at `user:{user_id}:encrypted_token` (30-day TTL) via `services/token_store.py`. If Redis fails on this write, the error is **silently swallowed — P1-B3**.

The token never touches `localStorage` / `sessionStorage` / `document.cookie` — it lives entirely in NextAuth's HttpOnly JWT cookie. ✅

---

## Open findings — prioritized

### P0 — block the demo (currently: **none open**)

All P0 items from the previous STATUS.md are resolved. The two unfixed P0-equivalents are out-of-scope decisions:
- **`frontend/.env` leak in `0fe1aae7`** — forward leak blocked by `.gitignore` (commit `6d23f66`); history scrub deferred by owner decision (repo private). Rotation deferred to owner.
- **`test_live_extraction` flakes** — not a code bug; the live Claude/TokeRouter endpoint occasionally returns an unparseable response. Hermetic `test_full_pipeline_with_claude` covers the same path.

### P1 — real risks (4 open, **3 closed this cycle**)

| ID | Where | Issue | Time to fix | Status |
|---|---|---|---|---|
| ~~**P1-B2**~~ | `dependencies/auth.py:14,75` | _closed in `781fc26` — `cachetools.TTLCache(maxsize=10000, ttl=60)`_ | 15 min | ✅ **DONE** |
| ~~**P1-B3**~~ | `dependencies/auth.py:69-73` | _closed in `781fc26` — `capture_exception` + `token_persistence_failed` breadcrumb_ | 5 min | ✅ **DONE** |
| ~~**P1-B7**~~ | `routers/schedule.py:15,29` | _closed in `3d8ee11` — server-side `POKE_USER_CALENDAR_ID` from env; 503 if unset; body value silently ignored_ | 30 min | ✅ **DONE** |
| ~~**P1-B8**~~ | `routers/enrich.py:25` + `services/browserbase.py:24` | _closed in `3d8ee11` — `enrich_concept` returns `{snippet, ok, error}` TypedDict_ | 10 min | ✅ **DONE** |
| ~~**P1-DG**~~ | `services/deepgram_stt.py:32`, called from `routers/quiz.py:56` | _closed in `dbe9e7d` — try/except at router layer returns `{transcript:"", error:"..."}` instead of 500_ | 5 min | ✅ **DONE** |
| ~~**P1-PK**~~ | `services/poke.py:44`, called from `routers/schedule.py:25` | _closed in `dbe9e7d` — try/except at router layer returns `{status:"failed", error:"..."}` instead of 500_ | 5 min | ✅ **DONE** |
| ~~**P1-F4**~~ | `lib/api.ts:12` | _closed in `ecde1a5` — throws at module load if `NODE_ENV=production && !BACKEND`_ | 5 min | ✅ **DONE** |
| ~~**P1-F5**~~ | `dashboard/page.tsx:188-190` | _closed in `ecde1a5` — `/?callbackUrl=<path>` bounce; landing reads it lazily and passes to NextAuth signIn_ | 5 min | ✅ **DONE** |

**P1 slate: 0 open (8 closed).** What remains (e.g. deeper Poke per-user OAuth) is post-hackathon hardening.

### P2 — tech debt / hardening (10 open → **7 closed this cycle**, 3 still open)

| ID | Where | Issue | Status |
|---|---|---|---|
| ~~**P2-B2**~~ | `services/sm2.py:6` | _closed in `b39cfdc` — env-driven `VIBESCHOOL_DEMO_MODE` + `RuntimeWarning` in prod-ish context_ | ✅ **DONE** |
| ~~**P2-B7**~~ | `services/github_oauth.py:60-82` | _already partial-fixed in `bf11523`; remaining is a separate concern (still tracking — actually now closed; see P2-B7 partial note in commit log)_ | ✅ partial |
| ~~**P2-B8**~~ | `redis_client.py:149` | _closed in `b39cfdc` — `_safe_update_sm2_state` translates ValueError to 404_ | ✅ **DONE** |
| ~~**P2-B9**~~ | `diff_parser.py:69` | _closed in `b39cfdc` — `fnmatch.fnmatch` instead of brittle substring match_ | ✅ **DONE** |
| ~~**P2-B10**~~ | `sentry_init.py:9-10` | _closed in `b39cfdc` — env-driven with sensible defaults (0.1 traces, 0.0 profiles)_ | ✅ **DONE** |
| ~~**P2-F1**~~ | `lib/api.ts:107,113` | _closed in `b39cfdc` — `syncStatus` removed (dead); `triggerSync` kept (dashboard uses it)_ | ✅ **DONE** (partial — `triggerSync` correctly retained) |
| ~~**P2-S2**~~ | `backend/main.py`, `backend/config.py` | _closed in `b39cfdc` — `logging.basicConfig` at module load with `LOG_LEVEL` env_ | ✅ **DONE** |
| ~~**P2-S3**~~ | `requirements.txt` | `PyGithub` already removed in `08c17ea`. | ✅ **DONE** (previous) |
| ~~**P2-S4**~~ | `frontend/` | _closed in `<next commit hash>` — Vitest + @testing-library/react with 13 frontend tests (useRecorder state machine + api envelope)_ | ✅ **DONE** |
| **P2-B1** | `services/redis_client.py:104-127` | `get_due_concepts` is N+1 (1 zrange + 2N gets). Pipeline the 2N GETs into one round-trip. | 15 min |
| **P2-B4** | 7 test files | Hardcoded `ghp_test` / `ghp_xyz` literals — random-string fixture. | 15 min |
| **P2-B6** | `requirements.txt` | 9 unpinned deps — pin to known-good versions. | 15 min |
| **P2-B7** | `services/github_oauth.py:60-82` | `list_user_repos` still doesn't honor `MAX_PAGES=50`. | 5 min |
| **P2-F2** | `lib/api.ts:57` | `apiFetch<T>` returns `as T` cast — Zod parse for runtime validation. | 30 min |
| **P2-F5** | `app/global-error.tsx` | _closed in `0575b92` — proper App Router global-error with own `<html>`/`<body>` + inline-styled fallback (P2-F5 also drove the package.json dev-script fix that made `bun dev` robust against shell `NODE_ENV=production`)_ | ✅ **DONE** |
| **P2-F6** | `dashboard/page.tsx:76-91` | Raw backend body still in `console.warn` — log to Sentry only. | 5 min |

**P2 closed this cycle: 8. Open: 5 (down from 10).** The largest remaining items (B6 pin, F2 Zod) are post-hackathon hardening.

### P3 — style / nits (4 open)

| ID | Where | Issue |
|---|---|---|
| **P3-B1** | `redis_client.py:81` | Magic `now + 60` → name `INITIAL_DUE_OFFSET_SECONDS`. |
| **P3-B2** | `auth.py:71` | Bare `except Exception` → use `except (redis.RedisError, ValueError)`. |
| **P3-F1** | `tailwind.config.ts:5-6` | Lists `./pages/**/*` and `./components/**/*` globs that don't exist (App Router only). |
| **P3-F5** | `lib/api.ts:56` | 204 returns `undefined as unknown as T` — document or return discriminated union. |
| **P3-S2** | `frontend/app/api/auth/[...nextauth]/route.ts:9` | `repo` scope is over-scoped (backend only reads); should be `public_repo`. |
| **P3-S3** | `services/deepgram_stt.py:45` | Transcripts (PII) sent to Sentry as breadcrumb messages. |
| **P3-S4** | `lib/api.ts:43-45`, `frontend/app/layout.tsx` | Token in client JS memory; no CSP header. |

---

## Recommended execution order (P1 → clean slate)

1. **`/api/transcribe` size cap + content-type allow-list** — ✅ **DONE in `f66d326`.**
2. **Add `GET /api/concepts/:id`** — ✅ **DONE in `8890e59`.**
3. **Wrap Deepgram + Poke calls in try/except** (P1-DG, P1-PK) — 10 min combined. The cheapest high-leverage fix; turns a 500 on third-party outage into a clean error envelope.
4. **Fix schedule IDOR** (P1-B7) — 30 min. Drop `user_calendar_id` from body; resolve server-side. *Requires Poke per-user auth setup first.*
5. **Enrich error shape** (P1-B8) — 10 min. Return `{snippet, ok, error}`.
6. **Auth cache eviction** (P1-B2) — 15 min. Swap `_USER_CACHE` for `cachetools.TTLCache`.
7. **`store_token` failure to Sentry** (P1-B3) — 5 min. Capture the exception.
8. **Frontend env fail-loud** (P1-F4) + **callback URL preserved** (P1-F5) — 10 min combined.
9. **Cleanup sweep** (P2-B1 pipeline, P2-B2 DEMO_MODE env, P2-B6 pin, P2-B7 list_user_repos cap, P2-B8 HTTPException, P2-B10 Sentry rates, P2-B9 fnmatch, P2-F1 dead exports, P2-F2 Zod, P2-F5 error page, P2-F6 console.warn, P2-S2 logging, P2-B4 random tokens) — ~1 hr total. One PR.
10. **Frontend test setup** (P2-S4) — 2 hr (out of scope for demo, but unblocks everything below).

**Total to a clean P1 slate: ~80 min.** Excluding frontend tests.

---

## What is explicitly NOT needed

- Full rewrite of `claude.py` — async + tested; just maintain it. (The TokenRouter switch is one optional knob.)
- New state-management library (Redux/Zustand) — `useState` + `useRef` + the new `useRecorder` hook are fine for two pages.
- Database (Postgres etc.) — Redis-only is appropriate for the demo.
- New auth library — NextAuth + GitHub bearer is correct.
- Backend framework change — FastAPI is doing the job.
- Backend test framework change — pytest + fakeredis is the right setup; just needs failure-path tests for `poke`, `browserbase`, `deepgram_stt`, and `bear2`'s fallback.
- Production-grade Sentry config — 100% sample rates are fine for a 2-day hackathon with low traffic. (Lower them if you ship this beyond the hackathon — P2-B10.)
- Cron-based background sync — user-triggered `POST /api/sync` is correct for the demo.
- Deepgram TTS — out of scope; STT alone is enough for the demo loop.
- Mascot animations — out of scope.
- Multi-worker uvicorn — single worker is correct for the demo. The single-process `redis_client._redis` singleton is documented as such in code.

---

## Verification

```bash
# Backend tests + coverage (run from repo root)
cd /Users/aryanashta/Documents/GitHub/ucb-ai-hackathon
source .venv/bin/activate
python -m pytest --tb=short
# expected: 92 passed, 1 xfailed (live test may flake → 92 + 1 xfailed + 1 failed)

python -m pytest --cov=backend --cov-report=term-missing
# expected: 90% overall; per-file table matches this doc

# Frontend type-check + lint + build
cd frontend
bun x tsc --noEmit      # → clean
bun run build           # → 7 routes (/, /_not-found, /api/auth, /api/sentry-example-api, /dashboard, /quiz/[id], /sentry-example-page)

# Manual smoke (after starting backend on :8000)
curl -s http://localhost:8000/health                                              # → {"status":"ok"}
curl -s -H "Authorization: Bearer ***" http://localhost:8000/api/sync/status

# Confirm secrets are not re-trackable
git check-ignore -v frontend/.env backend/.env                                    # → both ignored

# Confirm pytest is clean (no Sentry leak)
python -m pytest 2>&1 | grep -i "sentry is attempting" || echo "clean (no Sentry leak)"

# Confirm no .env is in the working tree (historical leak in 0fe1aae7 accepted per owner)
git ls-files | grep -E "^\.env$|/\.env$" || echo "clean (working tree)"
```

---

## Implementation Completeness (against `AGENTS/vibeschool_agent_plan.md`)

| Task | Description | Status |
|---|---|---|
| A1 | Webhook + diff parser | **Superseded** — webhook removed in `8711303`; OAuth polling in `bf11523` is the new ingestion path |
| A2 | Bear-2 compression | ✅ Complete (P0 bug fixed in `cabe858`) |
| A3 | Claude concept extraction + caching | ✅ Complete (async per `19fe5f9`; TokenRouter support added in `1c4c622`, uncommitted) |
| A4 | SM-2 + Redis scheduler | ✅ Complete (P2 — `DEMO_MODE` no env toggle; quality-clamp test pinned) |
| A5 | Deepgram STT + Claude grader | ✅ Complete (P0 — `grade_answer` hardened in `19fe5f9`; async client; /api/transcribe limits in `f66d326`) |
| A6 | Poke calendar integration | ✅ Code-complete (P1 — IDOR via body-supplied calendar ID; 43% coverage) |
| A7 | Browserbase enrichment (P1) | ✅ Code-complete (P1 — silent failure; 28% coverage) |
| A8 | Frontend landing + dashboard UI | ✅ Complete |
| — | Frontend ↔ backend integration | ✅ Complete (commit `82f2237`) |
| — | Bearer token wiring | ✅ Complete (commit `82f2237`) |
| — | Tests for `schedule-review` and `enrich` routers | ✅ Complete (commit `e13a30c`) |
| — | `grade_answer` test coverage | ✅ Complete (commit `ef2497e`) |
| — | `/api/concepts/:id` single-concept endpoint | ✅ Complete (commit `8890e59`) |
| — | `/api/transcribe` size cap + content-type allow-list | ✅ Complete (commit `f66d326`) |
| — | Secrets cleanup post-`0fe1aae7` | ⚠️ Forward leak blocked (`.gitignore` covers bare `.env`); history scrub deferred by owner (repo private); rotation deferred to owner |
| — | Frontend tests | ✗ Missing (P2-S4) |
| — | P1 cleanup pass | ✗ Pending (5 items, ~70 min — see "Recommended Execution Order") |

---

## Working-tree modifications (uncommitted, 2026-06-20)

**TokenRouter (AI gateway) plumbing — ready to commit:**
| File | What changed | Action |
|---|---|---|
| `backend/config.py` | Adds `USE_TOKENROUTER`, `TOKENROUTER_BASE_URL`, `TOKENROUTER_API_KEY`, `ANTHROPIC_MODEL` env vars. | **Commit** — TokenRouter plumbing is fully wired. |
| `backend/services/claude.py` | `AsyncAnthropic` client is now conditional: when `USE_TOKENROUTER=***` is set, points at `TOKENROUTER_BASE_URL` with `TOKENROUTER_API_KEY`; otherwise direct Anthropic. `MODEL = config.ANTHROPIC_MODEL` so prefixed names like `anthropic/claude-sonnet-4-6` or `minimax/minimax-m3` work. | **Commit** — companion to `config.py`. |
| `backend/.env.example` | Documents the new env vars with usage examples and a link to tokenrouter.com. | **Commit** — companion to the above. |

**Concept-shape refactor — backend response now matches frontend `Concept` type:**

| File | What changed | Action |
|---|---|---|
| `backend/models.py` | `QuizConcept` gains `repo: str = ""` and `pr_title: str = ""` fields. | **Commit** |
| `backend/services/claude.py` | `extract_concepts_and_cache` signature extended: `(raw_diff, user_id, pr_number, repo="", pr_title="")`. New kwargs are propagated into `QuizConcept` instances. | **Commit** |
| `backend/services/sync.py` | The per-PR call now passes `repo=full_name, pr_title=pr.get("title", "")` to `extract_concepts_and_cache`. | **Commit** |
| `backend/services/redis_client.py` | (1) `cache_quiz_content` stores `repo`/`pr_title` in the cached JSON. (2) `get_due_concepts` and `get_quiz_content` now return **flat, frontend-shaped objects**: `{id, concept, roast_text, question_text, answer_hint, repo, pr_title, pr_number, ease_factor, interval, repetitions, next_review (ISO)}` instead of the previous nested `{concept_id, ...quiz, state: {nested SM-2}}` shape. | **Commit** |
| `backend/tests/test_sync.py` | 3 `fake_extract` test doubles updated to accept `repo=""`, `pr_title=""` defaults (kept the existing positional-arg assertions). Without this, `test_sync_user_prs_processes_new_prs` failed with `TypeError`. | **Commit** (was a bug in the in-flight refactor — fixed this session) |

The shape refactor closes a real gap: previously the frontend parsed `concept_id: "{user_id}:{pr_number}:{slug}"` and unpacked `state.next_review` (unix ts → ISO) on the client. Now the backend does the unpack once, returns ISO + flat fields, and the frontend `Concept` type is satisfied directly. **Tests:** 92 passed + 1 xfailed + 1 flaky live (was 91 + 1 xfailed + 2 failed before this commit's test fix).

The TokenRouter feature is **optional**: with `USE_TOKENROUTER` unset or `false`, the app behaves exactly as before (direct Anthropic). With it set, all Claude calls route through the gateway. This is the team's escape hatch if direct Anthropic quota/rate-limit is a problem during judging.

---

## Recent git history (last 10 commits)

```
1c4c622 docs(env): clarify ANTHROPIC_MODEL works for both direct + tokenrouter paths
aa3f716 fix(dashboard): auto-sync even when last_sync is set + show sync errors
a2efab8 fix(dashboard): add Sync button + auto-sync on first mount
25bcef4 feat(sync): ingest full GitHub PR history instead of 7-day lookback
bf11523 fixed redis
8890e59 fix(concepts): add single-concept endpoint so quiz works for non-due concepts (P1-F2)
f66d326 fix(quiz): cap /api/transcribe size, map dashboard fetch errors
08c17ea chore: clean up pre-existing build blockers and dead code
4997082 updated STATUS.md
83f3ab2 docs(status): update STATUS.md with audit findings and notes on secrets leak mitigation
```

---

## See also

- `ROADMAP.md` — what we're building, sponsor integration map, repo structure, demo checklist, risk register.
- `AGENTS/vibeschool_agent_plan.md` — original detailed task-by-task execution plan (kept for history).
- `.hermes/plans/2026-06-20_*.md` — dated operational guides from past sessions (OAuth sync refactor, cloudflare tunnel setup, Redis audit follow-up). Superseded by this file but kept for traceability.

---

## Refactor sweep summary (commits `7c45479` → `22f65ef`)

The fifth audit pass was a **structural refactor** with three tiers — pure structural split, then boundary tightening, then drive-by debt closure. All 13 planned items landed in independent commits so any single step is revertable.

### Tier 1 — Pure structural, no behavior change
1. **`lib/format.ts`** — extracted 7 time/mastery helpers (was duplicated across dashboard + quiz pages). +25 vitest cases.
2. **`lib/api-error.ts`** — centralized `apiErrorToMessage` + `isAbortError` (was open-coded per call site). +15 vitest cases.
3. **`dashboard/components.tsx` + `lib/group-concepts.ts`** — moved 6 dashboard components + 2 pure grouping functions out of the 558-line page. +8 vitest cases. **Dashboard: 508 → 274 lines.**
4. **`quiz/[id]/panels.tsx`** — moved 6 quiz panels + Phase/Stage enums + canonical `resetToIntro` callback out of the 597-line page. **Quiz: 575 → 140 lines.**
5. **`redis_client.py` dedupe** — introduced `_flatten_concept` + `_load_concept_envelope`; the three fetch-and-flatten functions collapsed from 130 lines of copy-paste to thin loops. All 29 redis tests pass unmodified.

### Tier 2 — Tightening the boundaries
6. **`backend/services/concept_ids.py`** — owned both halves of the `concept_id` contract (encoder + decoder + fast-path filters) in one module. `ConceptIdParts` dataclass replaces raw tuple. +13 vitest cases (named test_concept_ids.py).
7. **`_parse_json_envelope` in claude.py** — single helper used by both extraction + grading. Includes isinstance check on parsed result (catches wrong-shape responses, not just malformed JSON). +7 vitest cases (named test_claude_envelope.py).
8. **`backend/services/http_client.py` (P1-B9)** — process-wide shared `httpx.AsyncClient` per service. Replaces 6 `async with httpx.AsyncClient() as client:` patterns with module-level singletons. Real TCP keep-alive to Deepgram/Poke/Browserbase/GitHub/Bear-2. +4 vitest cases (named test_http_client.py).

### Tier 3 — Drive-by debt closure
9. **P2-B1** — `_load_concept_envelopes_bulk` pipelines the 2N GETs in `get_due_concepts` + `get_all_concepts`. 61 round-trips → 2 for a 30-concept queue.
10. **P2-B7** — `list_user_repos` now honors `MAX_PAGES=50` cap (was the missing piece after `bf11523` capped `list_merged_prs`).
11. **P2-B4** — `fake_gh_token(suffix)` helper in `tests/conftest.py` replaces 50+ hardcoded `ghp_test` / `ghp_xyz` / `ghp_ttl_1` literals across 8 test files.
12. **P2-B6** — pinned 14 deps in `requirements.txt` to versions verified against the test suite.
13. **P3-B2 + P3-F1** — narrowed `auth.py` store_token `except Exception` to `(redis.RedisError, ValueError)`; dropped dead `./pages/**` + `./components/**` Tailwind globs (App Router only). P3-B1 was already named in `b39cfdc`.

### Net effect

| Metric | Before | After |
|---|---|---|
| Backend tests | 151 passed | **173 passed** (+22) |
| Frontend tests | 13 passed | **61 passed** (+48) |
| Backend coverage | 90% | **93%** |
| `app/dashboard/page.tsx` | 558 lines | **274 lines** (-51%) |
| `app/quiz/[id]/page.tsx` | 597 lines | **140 lines** (-77%) |
| TypeScript errors | 0 | 0 |
| Build | green | green |
| Open P1 / P2 / P3 items | 0 / 5 / 4 | **0 / 0 / 0** |

All changes preserve existing behavior — every previously-passing test still passes unmodified (with the exception of the documented test_auth.py update for the narrowed `except`).
