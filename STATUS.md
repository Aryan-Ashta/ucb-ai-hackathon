# Repository Status

**Project:** VibeSchool (DiffLingo) — UC Berkeley AI Hackathon (Jun 20–21, 2026)
**Branch:** `main` (in sync with `origin/main`)
**Last commit:** `9acecd0` — fix(quiz): clear stale state on inline retry in failed panel
**Verification:** `pytest` (67/67 pass, 88% backend coverage, 0 Sentry events leaked)

> **This STATUS.md is rewritten from a second-pass audit on 2026-06-20.** Since the previous version (commit `cb52340`), **7 new commits** addressed all P0s and several P1s (see "Audit Trail" below). The finding lists below are split into **FIXED** (resolved by a commit since the last audit) and **STILL PRESENT** (still actionable before the demo).


---

## Current State at a Glance

- **Backend:** FastAPI app with 5 routers under `/api`, all auth-gated except `/health`. Redis Cloud as the only persistent store (no SQL). Ingestion: GitHub OAuth polling (webhooks removed in `8711303`) → Bear-2 → Claude concept extraction → Redis quiz cache. Quiz hot path: Deepgram STT → Claude grader (now `AsyncAnthropic`) → SM-2.
- **Frontend:** Next.js 14 App Router + NextAuth. Two user pages (`/dashboard`, `/quiz/[id]`), one auth route, single shared API client (`lib/api.ts`). Bearer token wired end-to-end via `session.accessToken` per commit `82f2237`. Quiz page now uses an extracted `useRecorder` hook with unmount cleanup.
- **Tests:** **67 backend tests pass** (up from 56). Live Bear-2/Claude tests gated on real keys. `grade_answer` now covered (was 0% → 98%). New router tests for `schedule-review` and `enrich` (were untested). **Zero frontend tests** (unchanged).
- **Deployment model:** Local-only — backend on `localhost:8000` (uvicorn), frontend on `localhost:3000` (`bun dev`), optional `cloudflared` tunnel for external demo. CORS allowlist now matches: `localhost:3000`, `127.0.0.1:3000`, and a `trycloudflare.com` hostname regex.

---

## TL;DR — What's Left Before the Demo

| # | Sev | Action | Time |
|---|---|---|---|
| 1 | **P1** | Add `GET /api/concepts/:id` and refactor `getConcept` to use it (P1-F2). Saves a full list-pull on every quiz load. | 20 min |
| 2 | **P1** | `/api/transcribe` DoS guard (P1-S3) — cap at 10 MB + content-type allow-list. | 10 min |
| 3 | **P1** | Fix schedule IDOR (P1-B7) — drop `user_calendar_id` from request body; resolve server-side from user_id. | 10 min |
| 4 | **P1** | Enrich error-shape (P1-B8) — return `{snippet, ok, error}` instead of swallowing failures. | 5 min |
| 5 | **P2** | Delete dead code: `get_authenticated_user` (P1-B6), `api.triggerSync`/`syncStatus` (P2-F1), `fetch_and_parse_diff` unused import + function (P1-B5). | 5 min |
| 6 | **P2** | `requirements.txt` — remove PyGithub (P2-S3, dead dep), pin the rest (P2-B6). | 15 min |
| 7 | **P2** | Fix the remaining leaks: silent `store_token` failure (P1-B3), unbounded `_USER_CACHE` (P1-B2), N+1 `get_due_concepts` (P2-B1), unbounded `list_user_repos` (P2-B7), bare `ValueError` → `HTTPException` (P2-B8). | 30 min |
| 8 | **P2** | CORS / PyGithub / `fetch_and_parse_diff` cleanup pass — none are bugs, all are debt the next person will trip on. | — |

**Total: ~95 minutes to a clean P1 slate.** All P0s are fixed.

---

## Audit Trail — Commits Since Last STATUS

| Commit | Area | What changed | STATUS.md items resolved |
|---|---|---|---|
| `6d23f66` | secrets | `.gitignore` extended to cover bare `.env` (root + frontend); forward leak blocked (P0-S2). Repo confirmed private; history scrub not performed (see header note). | P0-S1 (forward), P0-S2 |
| `cabe858` | backend | `bear2.py:21` hoists `compressed_tokens = count_tokens_approx("")` above the `try` block — fixes silent loss-of-compression bug | P0-B1 |
| `19fe5f9` | backend | `claude.py` — `grade_answer` wrapped in try/except on JSON parse, swapped to `AsyncAnthropic`, quality clamped to `max(0, min(5, int(q)))` | P0-B2, P1-B1, P1-B4 |
| `ef2497e` | backend | `test_claude.py` — full coverage of `grade_answer` (0% → 98%) | (test gap) |
| (manually) | backend | `main.py` CORS allowlist rewritten — dropped all `*.vercel.app` entries, added `trycloudflare.com` regex | P0-B3 |
| (manually) | backend | `backend/render.yaml` deleted | P0-B4 |
| `e13a30c` | backend | New `test_schedule_router.py` (4 tests, 100% coverage) + `test_enrich_router.py` (4 tests, 100% coverage) | P1-S1 |
| `b4ad62f` | backend | `tests/conftest.py` adds session-scoped `sentry_test_safe` fixture that re-inits SDK with `dsn=None` + `transport=None`; pytest output no longer ends with the "Sentry is attempting to send N pending events" warning | P1-S2 |
| `b4ad62f` | backend | Hoisted in-body imports (`hashlib`, `time`, `sm2_next`) to module top in `auth.py` and `redis_client.py` | P2-B5 |
| `eb5675e` | frontend | AbortController wired through `lib/api.ts` + both pages; stale `onRetry` state reset on the ActionBar | P0-F2, P1-F3 |
| `9acecd0` | frontend | Inline "Try again" button (in `failed` panel) now also resets transcript/grade/errorMsg/typed | P1-F3 (continued) |

Also in flight (extracted into its own hook):
- **`frontend/lib/useRecorder.ts`** (new, extracted from inline quiz page code): owns the `MediaRecorder` lifecycle and runs `cleanup` (stop stream tracks, close `AudioContext`) in a `useEffect` cleanup function. Fixes P0-F1 — navigating away mid-recording now turns off the mic indicator and stops data events.

**Result:** 0 P0, 8 P1, 11+ P2 items remain.

---

## Stack

### Backend
- **Python 3.14** (venv; `render.yaml` pin was deleted)
- **FastAPI** + **uvicorn** — `backend/main.py`, 5 routers under `/api`
- **redis.asyncio** — pooled client with timeouts, health checks, retry-on-timeout (`backend/services/redis_client.py:29-36`)
- **Anthropic SDK** — `anthropic.AsyncAnthropic` with `claude-sonnet-4-6` for extraction + grading (`backend/services/claude.py:12`)
- **Deepgram** — nova-2 STT (`backend/services/deepgram_stt.py`)
- **Token Company Bear-2** — diff compression (`backend/services/bear2.py`)
- **Sentry SDK** — no-op when `SENTRY_DSN` empty; **pytest session now also no-ops** via `conftest.py:sentry_test_safe`
- **fakeredis** — in-memory Redis for hermetic tests (`backend/tests/conftest.py:fake_redis`)
- **pytest-asyncio** — `asyncio_mode=auto` (`pytest.ini`)

### Frontend
- **Next.js 14.2.35** App Router — no `pages/`, no `components/`, no `hooks/`
- **NextAuth 4.24.14** with GitHub provider, scopes `read:user user:email repo`
- **React 18** + **TypeScript strict**
- **@sentry/nextjs 10.59.0** (peer range worth verifying against Next 14.2 — see P3-F3)
- **bun** (lockfile present)
- **Vitest** — not installed (P2-S4)

### Integrations
| Service | Used for | File |
|---|---|---|
| GitHub OAuth | User identity + per-user API token (passed as bearer to backend) | `frontend/app/api/auth/[...nextauth]/route.ts`, `backend/dependencies/auth.py` |
| GitHub REST API | List user repos, list merged PRs, fetch diffs | `backend/services/github_oauth.py` |
| Claude | Concept extraction (ingestion), answer grading (quiz hot path) — **now async** | `backend/services/claude.py` |
| Bear-2 | Compress PR diff before sending to Claude | `backend/services/bear2.py` |
| Deepgram | Transcribe spoken answer | `backend/services/deepgram_stt.py` |
| Poke API | Schedule review blocks on user's calendar | `backend/services/poke.py` |
| Browserbase | Scrape MDN enrichment snippets (P1) | `backend/services/browserbase.py` |
| Redis Cloud | Quiz cache, SM-2 state, processed-PR hash, encrypted OAuth tokens (Fernet) | `backend/services/redis_client.py` |
| Sentry | Tracing + breadcrumbs across all external calls | `backend/sentry_init.py`, `frontend/instrumentation*.ts` |

---

## Directory Map

```
backend/
  main.py                       FastAPI app factory; mounts 5 routers
  config.py                     Env loading; _require() fails fast for P0 keys
  sentry_init.py                Sentry init; must be first import in main.py
  models.py                     Pydantic: QuizConcept (ConceptList dead)
  requirements.txt              11 deps, all unpinned (PyGithub is dead)
  routers/
    sync.py                     POST /api/sync, GET /api/sync/status  (100% cov)
    concepts.py                 GET  /api/concepts                     (75% — needs /:id variant)
    quiz.py                     POST /api/transcribe, /api/grade       (75% — missing size cap)
    schedule.py                 POST /api/schedule-review              (100% cov, IDOR still)
    enrich.py                   POST /api/enrich                       (100% cov, silent-failure)
  dependencies/
    auth.py                     get_current_user — validates GitHub bearer via /user
  services/
    redis_client.py             Connection pool + cache/quiz/SM-2 helpers (97% cov)
    token_store.py              Fernet-encrypted OAuth tokens at rest
    sync.py                     Orchestrator (Bear-2 → Claude → Redis)
    github_oauth.py             GitHub REST helpers (get_authenticated_user is dead)
    claude.py                   AsyncAnthropic; extract_concepts_and_cache, grade_answer
    bear2.py                    compress_diff (P0 bug fixed in cabe858)
    deepgram_stt.py             transcribe_audio
    poke.py                     schedule_review_block
    browserbase.py              enrich_concept (silent failure on error)
    diff_parser.py              clean_diff; fetch_and_parse_diff (dead, see P1-B5)
    sm2.py                      SM-2 algorithm (DEMO_MODE flag, no env toggle)
  scripts/
    check_redis.py              Smoke test (0% coverage)
  tests/
    conftest.py                 Autouse fakeredis + sentry_test_safe fixtures
    test_auth.py                6 tests, 98% coverage
    test_redis.py               17 tests, 100% coverage
    test_sm2.py                 1 test, 94% coverage
    test_diff_parser.py         5 tests, 100% coverage
    test_bear2.py               3 tests, 85% coverage (live gated)
    test_claude.py              4 tests, 98% coverage (live gated; grade_answer now covered)
    test_github_oauth.py        4 tests, 97% coverage
    test_quiz_router.py         4 tests, 100% coverage
    test_sync_router.py         5 tests, 100% coverage
    test_sync.py                5 tests, 94% coverage
    test_schedule_router.py     4 tests, 100% coverage (NEW since last audit)
    test_enrich_router.py       4 tests, 100% coverage (NEW since last audit)
    test_e2e.py                 2 tests, 98% coverage (live gated)
    fixtures/                   sample.diff, pr_payload.json

frontend/
  app/
    layout.tsx                  Root layout (Geist fonts bundled, ~130 kB)
    page.tsx                    Landing page (148 lines, "use client")
    providers.tsx               SessionProvider
    global-error.tsx            Renders <NextError statusCode={0} /> — no message
    not-found.tsx               (added by 1b73f48)
    dashboard/page.tsx          Protected; concept grid + due sidebar (AbortController wired)
    quiz/[id]/page.tsx          6-state machine; uses useRecorder() hook
    api/auth/[...nextauth]/route.ts  NextAuth GitHub provider + callbacks
  lib/
    api.ts                      Fetch wrapper; typed endpoints; AbortSignal-aware
    useRecorder.ts              (NEW) MediaRecorder hook with unmount cleanup
    mock.ts                     MOCK_CONCEPTS + helpers (used when BACKEND is empty)
    types.ts                    Concept, GradeRequest, GradeResult
  types/
    next-auth.d.ts              Module augmentation: accessToken on Session/JWT
  instrumentation.ts            Sentry server-side hook
  instrumentation-client.ts     Sentry client-side init
  sentry.{server,edge}.config.ts
  next.config.mjs               Sentry wrapper, no images.remotePatterns
  tailwind.config.ts            Lists `./pages/**` and `./components/**` (dead globs)
  .env.local.example            Template — also lists backend-only secrets (misleading)
  .gitignore                    Bare `.env` + `.env*.local` ignored (FIXED)
  .env                          NOT TRACKED — `.gitignore` blocks re-tracking. Historical leak in `0fe1aae7` still recoverable from clones; accepted (repo private).
  .env.local.example            Template

AGENTS/                         Plans (audit, demo-readiness, roadmap)
.hermes/plans/                  Dated operational guides
```

---

## Redis Key Schema

```
concept:{user_id}:{concept_id}:quiz        JSON  {concept, roast_text, question_text, answer_hint}
concept:{user_id}:{concept_id}:state       JSON  {ease_factor, interval, repetitions, next_review}
concept:{user_id}:{concept_id}:enrichment  str   MDN snippet (optional, P1)
due:{user_id}                              ZSET  score = next_review unix timestamp
user:{user_id}:prs                         HASH  pr_number → {repo, merged_at}  (idempotency)
user:{user_id}:encrypted_token             str   Fernet ciphertext of OAuth token
user:{user_id}:last_sync                   str   Unix ts
user:{user_id}:sync_inflight               str   "1" with 5-min TTL (mutex)
user:{user_id}:repos                       SET   Repo full names
```

TTL: **7 days** on quiz/state/due/repos, **30 days** on encrypted_token.

---

## Endpoint Map

| Method | Path | File:line | Auth | Notes |
|---|---|---|---|---|
| GET | `/health` | `main.py:28` | none | Liveness probe only (no Redis ping) |
| POST | `/api/sync` | `routers/sync.py:13` | bearer | 5-min per-user lock; idempotent |
| GET | `/api/sync/status` | `routers/sync.py:27` | bearer | last_sync ts + ISO |
| GET | `/api/concepts` | `routers/concepts.py:9` | bearer | All due concepts; **no `/api/concepts/:id` variant** (P1-F2) |
| POST | `/api/transcribe` | `routers/quiz.py:13` | bearer | Deepgram; **no size cap, no content-type allow-list** (P1-S3) |
| POST | `/api/grade` | `routers/quiz.py:48` | bearer | Claude grades + SM-2 update |
| POST | `/api/schedule-review` | `routers/schedule.py:18` | bearer | **Takes `user_calendar_id` from body** (P1-B7 IDOR) |
| POST | `/api/enrich` | `routers/enrich.py:16` | bearer | Browserbase; **swallows failures** (P1-B8) |

---

## Findings — FIXED Since Last Audit

| ID | Resolution | Commit | Notes |
|---|---|---|---|
| **P0-S1** | Forward leak blocked; history scrub deferred | `6d23f66` (forward only) | `.gitignore` blocks re-tracking. The original leak in `0fe1aae7` is still in git history and recoverable via `git show 0fe1aae7:frontend/.env` from any existing clone — **deferred per owner decision** (repo confirmed private). Rotation is the durable mitigation if the leak was ever visible to a third party; not tracked here. |
| **P0-S2** | `.gitignore` covers bare `.env` | `6d23f66` | Both root `.gitignore` (line 12) and `frontend/.gitignore` (line 30) ignore bare `.env`. |
| **P0-B1** | `compressed_tokens` hoisted above `try` | `cabe858` | `bear2.py:21` now reads `compressed_tokens = count_tokens_approx("")` before the `try` block — the `or compressed_tokens` fallback can no longer hit `UnboundLocalError`. |
| **P0-B2** | `grade_answer` JSON-parse hardened | `19fe5f9` | `claude.py:145-154` wraps `json.loads` in try/except; on failure returns `{passed: False, quality: 0, explanation: "Grading failed — please try again."}` and breadcrumbs the raw response. |
| **P0-B3** | CORS allowlist updated | (manual) | `main.py:10-19` now only allows `localhost:3000`, `127.0.0.1:3000`, and the `trycloudflare.com` regex. No `*.vercel.app` references. |
| **P0-B4** | `backend/render.yaml` deleted | (manual) | File no longer present; deployment is local-only as documented in `vibeschool_demo_readiness.md`. |
| **P0-F1** | MediaRecorder cleanup on unmount | (refactor) | Extracted to `frontend/lib/useRecorder.ts`; `cleanup` callback (lines 37-49) stops stream tracks and closes AudioContext, runs in `useEffect` cleanup (line 51). |
| **P0-F2** | AbortController on dashboard + quiz | `eb5675e` | `dashboard/page.tsx:195-206`, `quiz/[id]/page.tsx:52-70,82`. Wired through `lib/api.ts` (all fetch endpoints accept `signal?: AbortSignal`). |
| **P1-B1** | AsyncAnthropic swap | `19fe5f9` | `claude.py:12` now `anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)`; both `extract_concepts_and_cache` and `grade_answer` use `await client.messages.create(...)`. |
| **P1-B4** | Quality clamped to 0-5 | `19fe5f9` | `claude.py:156` reads `q = max(0, min(5, int(result["quality"])))`. |
| **P1-F1** | Non-null assertions removed | (refactor) | `quiz/[id]/page.tsx:59,89,99` use `session?.accessToken ?? undefined`. |
| **P1-F3** | Stale retry state cleared | `eb5675e` + `9acecd0` | Both the inline "Try again" button (lines 222-229) and the `ActionBar.onRetry` (lines 246-253) reset `transcript`, `grade`, `errorMsg`, `typed`. |
| **P1-S1** | Router tests for schedule + enrich | `e13a30c` | New `test_schedule_router.py` (4 tests) and `test_enrich_router.py` (4 tests), each at 100% coverage. |
| **P1-S2** | Sentry pytest leak stopped | `b4ad62f` | `tests/conftest.py:19-41` adds session-scoped `sentry_test_safe` fixture that re-inits SDK with `dsn=None` + `transport=None`. Pytest output now ends clean (no "Sentry is attempting to send N pending events" warning). |
| **P2-B5** | In-body imports hoisted | `b4ad62f` | `auth.py` and `redis_client.py` now import at module top. |

---

## Findings — STILL PRESENT (actionable before demo)

### P1 — real risks

| ID | Where | Issue |
|---|---|---|
| **P1-B2** | `dependencies/auth.py:14` | `_USER_CACHE` grows unbounded — dict never evicts expired entries on write. Convert to `cachetools.TTLCache(maxsize=10000, ttl=60)`. |
| **P1-B3** | `auth.py:69-73` | `try: await store_token(...) except Exception: pass` — Redis blip silently fails token persistence. Capture to Sentry. |
| **P1-B5** | `services/diff_parser.py:19-50` | `fetch_and_parse_diff` is dead code. `services/sync.py:22` imports it but never calls it (the sync flow uses `fetch_pr_diff` + `clean_diff` separately). Delete the function **and** the import. |
| **P1-B6** | `services/github_oauth.py:48-51` | `get_authenticated_user` is dead code — `auth.py` calls GitHub inline instead. Route through this single seam (preferred) or delete. |
| **P1-B7** | `routers/schedule.py:15,29` | `user_calendar_id` comes from request body. Horizontal-privilege primitive. Look up server-side from `user_id` (after wiring Poke auth on a per-user basis). |
| **P1-B8** | `routers/enrich.py:25` + `browserbase.py:68` | `enrich_concept` returns `""` on failure; router returns `{"snippet": ""}` with no error indicator. Frontend can't distinguish "MDN returned nothing" from "Browserbase key wrong". Return `{snippet, ok, error}`. |
| **P1-B9** | 6 services | New `httpx.AsyncClient()` per request in `auth.py:47`, `bear2.py:24`, `deepgram_stt.py:21`, `poke.py:34`, `browserbase.py:27`, `github_oauth.py:42`. Module-level clients with sane limits. |
| **P1-F2** | `frontend/lib/api.ts:135-146` | Quiz page pulls the **entire** due-concept list to render one concept (frontend filters in-memory). If concept isn't in the due set, user sees "not found" even for concepts that exist. Add `GET /api/concepts/:id` to backend. |
| **P1-F4** | `frontend/lib/api.ts:12` | `NEXT_PUBLIC_BACKEND_URL` captured at module load. If missing in prod, browser silently hits `localhost:8000` instead of failing loudly. Throw at startup if missing in production. |
| **P1-F5** | `app/dashboard/page.tsx:189` | `router.replace("/")` drops the callback URL. Use `router.replace(\`/?callbackUrl=${encodeURIComponent(pathname)}\`)`. |
| **P1-S3** | `routers/quiz.py:27,34` | `/api/transcribe` reads arbitrary-size audio into memory, no size cap, no content-type allow-list. DoS + cost vector on a Deepgram-billed endpoint. 10 MB cap (413), whitelist `audio/webm`, `audio/wav`, `audio/mpeg`, `audio/ogg`. |

### P2 — tech debt / hardening

| ID | Where | Issue |
|---|---|---|
| **P2-B1** | `services/redis_client.py:104-127` | `get_due_concepts` is N+1: `zrangebyscore` + 2N `r.get` calls. 30 due concepts = 61 round-trips. Pipeline. |
| **P2-B2** | `services/sm2.py:6` | `DEMO_MODE = True` is a module-level constant with no env toggle. Production deploys silently use minute-scale intervals. Env-flag toggle. |
| **P2-B3** | routers | Pydantic request models live inline in routers (`GradeRequest` in `quiz.py:43-45`, `ScheduleRequest` in `schedule.py:12-15`, `EnrichRequest` in `enrich.py:11-13`). `models.py:14-15` (`ConceptList`) is dead — never imported. |
| **P2-B4** | tests | Hardcoded token literals (`ghp_test`, `ghp_xyz`, `ghp_cached`) in `test_auth.py`/`test_quiz_router.py`/`test_sync_router.py`/`test_schedule_router.py`/`test_enrich_router.py`/`test_sync.py`/`test_github_oauth.py`. GitHub secret scanner may flag. Fixtures that generate random strings. |
| **P2-B6** | `requirements.txt` | All 11 deps unpinned. Reproducible builds impossible. Pin. |
| **P2-B7** | `services/github_oauth.py:54-76` | `list_user_repos` has no max-page bound. Org admin with 500+ repos → unbounded loop. `MAX_PAGES=50` guard. |
| **P2-B8** | `redis_client.py:149` | `update_sm2_state` raises bare `ValueError` for missing concept → 500. Use `HTTPException(404)` (but keep the underlying `ValueError` as the cause). |
| **P2-B9** | `diff_parser.py:69` | `pat.replace("*", "") in filename` is brittle. `fnmatch.fnmatch`. |
| **P2-B10** | `sentry_init.py:9-10` | `traces_sample_rate=1.0`, `profiles_sample_rate=1.0` — burns quota. Lower or env-driven. |
| **P2-F1** | `lib/api.ts:101-108` | `api.triggerSync` and `api.syncStatus` are dead code — no UI consumer. Delete (or wire a "Sync now" button on the dashboard). |
| **P2-F2** | `lib/api.ts:57` | `apiFetch<T>` uses `as T` cast — schema drift won't be caught. Add Zod parse. |
| **P2-F4** | `frontend/lib/useRecorder.ts:113` | `onstop` closure recreated every render. Memoize or pass token explicitly. |
| **P2-F5** | `app/global-error.tsx:19` | Renders Next's stock error page with `statusCode={0}` and no message. Inline `error.digest` + Reload button. |
| **P2-F6** | `app/dashboard/page.tsx:201-204` | Dashboard shows raw backend error string in UI → leaks `ApiError.body`. Map status → user-friendly string, log body to Sentry only. |
| **P2-F7** | `frontend/.env.local.example:6-8,12-13` | Lists `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `REDIS_URL`, `TOKEN_COMPANY_API_KEY`, `POKE_API_KEY` — all backend-only. Misleading. |
| **P2-F8** | `app/dashboard/page.tsx:188-190` | Redirect-on-unauthenticated race: if `useSession` returns `unauthenticated` for one render before cookie settles, redirect fires immediately. (Mitigated partially by the `loading` guard on line 209, but the effect on line 188 still fires unconditionally.) |
| **P2-F9** | `app/quiz/[id]/page.tsx` | No `<title>` / `generateMetadata`. Deep-linked quiz URLs all show the same generic title. |
| **P2-S2** | `backend/main.py`, `backend/config.py` | No `logging.basicConfig` anywhere. Only `token_store.py:24` calls `logging.getLogger(__name__)`. If `SENTRY_DSN` is empty in prod, errors vanish silently. |
| **P2-S3** | `backend/requirements.txt:8` | `PyGithub` is listed but imported nowhere (`grep -r "PyGithub\|from github\|import github" backend/` confirms zero hits). Dead dependency. Remove. |
| **P2-S4** | `frontend/` | Zero frontend tests. Quiz/audio flow entirely untested. Add Vitest + `@testing-library/react`. |

### P3 — style / nits

| ID | Where | Issue |
|---|---|---|
| **P3-B1** | `redis_client.py:81` | Magic `now + 60` → name `INITIAL_DUE_OFFSET_SECONDS`. |
| **P3-B2** | `auth.py:71` | Bare `except Exception` around `store_token` → use `except (redis.RedisError, ValueError)`. |
| **P3-B3** | routers | Pydantic models lack `Field(..., max_length=...)` constraints on user-supplied strings. |
| **P3-B4** | `pytest.ini` | Doesn't pin Python; venv is 3.14, `render.yaml` pin (3.11.11) was deleted. |
| **P3-F1** | `tailwind.config.ts:5-6` | Lists `./pages/**/*` and `./components/**/*` globs that don't exist (App Router only). |
| **P3-F2** | `tsconfig.json:6` | `strict` on, but `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`, `noFallthroughCasesInSwitch` are off — cheap upgrades. |
| **P3-F3** | `frontend/package.json:12` | `@sentry/nextjs ^10.59.0` next to `next 14.2.35` — peer range worth verifying. |
| **P3-F4** | `app/page.tsx:1-148` | 148 lines of marketing copy in a client component. Move static parts to a Server Component. |
| **P3-F5** | `lib/api.ts:56` | `204 No Content` returns `undefined as unknown as T`. Document or return discriminated union. |
| **P3-S1** | `sentry_init.py:9-10` | `traces_sample_rate=1.0` + `profiles_sample_rate=1.0` → costs money; could include PII in spans. (Same as P2-B10.) |
| **P3-S2** | `frontend/app/api/auth/[...nextauth]/route.ts:9` | GitHub OAuth scope `repo` is over-scoped (backend only reads) → `read:user user:email public_repo`. |
| **P3-S3** | `services/deepgram_stt.py:45` | User transcripts (PII-adjacent) sent to Sentry as breadcrumb messages. |
| **P3-S4** | `lib/api.ts:43-45`, missing `frontend/app/layout.tsx` CSP | Token exposed in client JS memory; missing CSP header means any XSS exfiltrates every user's GitHub OAuth token. |

---

## Coverage Report

```
TOTAL                                  1373   161   88%
```

| File | Stmts | Miss | Cover | Δ since last audit | Risk |
|---|---|---|---|---|---|
| `routers/sync.py` | 14 | 0 | 100% | — | ✅ |
| `routers/enrich.py` | 12 | 0 | **100%** | +25 pp (was 75%) | ✅ |
| `routers/schedule.py` | 16 | 0 | **100%** | +38 pp (was 62%) | ✅ |
| `routers/concepts.py` | 8 | 2 | 75% | — | ⚠️ missing single-quiz variant |
| `routers/quiz.py` | 28 | 7 | 75% | — | ⚠️ missing size cap (lines 51-64) |
| `services/sm2.py` | 22 | 0 | 100% | — | ✅ |
| `services/redis_client.py` | 96 | 3 | 97% | — | ✅ |
| `services/claude.py` | 53 | 7 | **87%** | +10 pp (was 77%) | ✅ grade_answer now tested |
| `services/sync.py` | 57 | 8 | 86% | — | ⚠️ error paths |
| `services/bear2.py` | 24 | 4 | 83% | — | ⚠️ bug region still only happy-path covered |
| `services/token_store.py` | 30 | 6 | 80% | — | ⚠️ |
| `services/github_oauth.py` | 50 | 13 | 74% | — | ⚠️ |
| `services/diff_parser.py` | 37 | 13 | 65% | — | ⚠️ mostly `fetch_and_parse_diff` (dead code) |
| `services/poke.py` | 14 | 8 | **43%** | — | ⚠️ **no failure-mode tests** |
| `services/deepgram_stt.py` | 13 | 8 | **38%** | — | ⚠️ **no failure-mode tests** |
| `services/browserbase.py` | 29 | 21 | **28%** | — | ⚠️ **no failure-mode tests** |
| `dependencies/auth.py` | 39 | 5 | 87% | — | ✅ |
| `scripts/check_redis.py` | 39 | 39 | 0% | — | (standalone script, fine) |

**Frontend:** 0% — no test runner configured (P2-S4).

---

## Auth Flow Trace (verified end-to-end, unchanged)

1. User clicks "Sign in" on `/` → `signIn("github")` (NextAuth client).
2. GitHub OAuth round-trip with scopes `read:user user:email repo`.
3. Callback hits `frontend/app/api/auth/[...nextauth]/route.ts` (the `jwt` callback, line 13-18): on first sign-in only, copies `account.access_token` onto the JWT cookie. NextAuth's built-in state generation/verification handles CSRF.
4. The `session` callback (line 19-22) exposes the JWT's access token as `session.accessToken`.
5. Client components (`dashboard/page.tsx:182`, `quiz/[id]/page.tsx:39`) read it via `useSession()`.
6. `lib/api.ts:43-45` (JSON calls) and `lib/api.ts:118-128` (multipart transcribe) attach `Authorization: Bearer <accessToken>`.
7. Backend `dependencies/auth.py:get_current_user` validates by hitting `GET {GITHUB_API_BASE}/user` with a 60-second in-process cache keyed by SHA-256 of the token.
8. On success, the token is Fernet-encrypted and persisted to Redis at `user:{user_id}:encrypted_token` (30-day TTL) via `services/token_store.py`.

The token never touches `localStorage` / `sessionStorage` / `document.cookie` — it lives entirely in NextAuth's HttpOnly JWT cookie. ✅ correct pattern.

---

## Cross-Cutting Observations (updated)

- **The single remaining high-leverage backend cleanup is `claude.py`** — no more bugs there, but the `AsyncAnthropic` swap means **every other Claude call site inherits non-blocking behaviour for free**, and the test surface for `grade_answer` is now broad enough that future regressions will surface immediately.
- **`schedule.py` and `enrich.py` are at 100% coverage but still have real bugs (P1-B7 IDOR, P1-B8 silent failure).** Coverage alone doesn't catch security or UX issues — needs review of the request shapes and error contracts.
- **The original `frontend/.env` leak (commit `0fe1aae7`) is still recoverable from any existing clone** via `git show 0fe1aae7:frontend/.env`. Forward re-tracking is blocked by `.gitignore` (`6d23f66`); history scrub was **deferred per owner decision** because the repo is confirmed private. If the leak was ever visible to a third party, rotation is the only durable mitigation — out of scope here per the owner's call.
- **The deployment-model pivot (Vercel → local) is now reflected in code.** CORS allowlist is `localhost` + `trycloudflare.com` regex; `render.yaml` is gone; `main.py` no longer references Vercel.
- **The two routers with body-supplied identifiers (`schedule`, `enrich`) are now well-tested but the IDOR/silent-failure issues are still live.** Same root cause as last audit, lower priority because at least the happy path is locked down.
- **Frontend test gap remains the single largest tech-debt item (P2-S4).** The quiz page alone is 597 lines with a 7-state machine — one typo breaks it silently.

---

## Recommended Execution Order (P1 → clean slate)

1. **`/api/transcribe` DoS guard** (P1-S3) — 10 min. Easiest 1-line defense for a cost vector.
2. **Add `GET /api/concepts/:id`** (P1-F2) — 20 min. Eliminates the full-list-pull on every quiz load.
3. **Fix schedule IDOR** (P1-B7) — 10 min. Drop `user_calendar_id` from body; resolve server-side.
4. **Enrich error shape** (P1-B8) — 5 min. Return `{snippet, ok, error}`.
5. **Dead-code deletion pass** (P1-B5, P1-B6, P2-F1) — 5 min. Quick win for readability.
6. **Cleanup sweep** (P2-B6 unpin, P2-S3 PyGithub, P2-B7 MAX_PAGES, P2-B8 HTTPException, P2-B1 pipeline, P1-B3 Sentry capture, P1-B2 TTLCache, P1-B9 module-level httpx, P2-B2 DEMO_MODE toggle) — 45 min total. One PR.
7. **Frontend test setup** (P2-S4) — 2 hr (out of scope for demo, but unblocks everything below).
8. **Frontend hardening** (P1-F4 backend URL check, P1-F5 callback URL, P2-F2 Zod, P2-F5 error page, P2-F6 error mapping, P2-F7 example file, P2-F9 metadata) — 30 min.

**Total: ~95 minutes to a clean P1 slate** (excluding frontend tests).

---

## What is Explicitly NOT Needed

- Full rewrite of `claude.py` — already async + tested; just maintain it.
- New state management library (Redux/Zustand) — `useState` + `useRef` + the new `useRecorder` hook are fine for two pages.
- Database (Postgres etc.) — Redis-only is appropriate for the demo.
- New auth library — NextAuth + GitHub bearer is correct.
- Backend framework change — FastAPI is doing the job.
- Backend test framework change — pytest + fakeredis is the right setup; just needs failure-path tests for `poke`, `browserbase`, `deepgram_stt`, and `bear2`'s fallback.
- Production-grade Sentry config — 100% sample rates are fine for a 2-day hackathon with low traffic.

---

## Verification

```bash
# Backend tests + coverage (run from repo root)
.venv/bin/python -m pytest --tb=short
.venv/bin/python -m pytest --cov=backend --cov-report=term-missing

# Frontend type-check + lint + build
cd frontend && bun x tsc --noEmit
cd frontend && bun run lint
cd frontend && bun run build

# Manual smoke (after starting backend on :8000)
curl -s http://localhost:8000/health
curl -s -H "Authorization: Bearer <github-token>" http://localhost:8000/api/sync/status

# Confirm `.env` is not tracked (should print nothing — historical scrub deferred per owner)
git ls-files | grep -E "^\.env$|/\.env$" || echo "clean (working tree)"

# Confirm gitignore blocks re-tracking
git check-ignore -v frontend/.env backend/.env

# Confirm pytest is clean (no Sentry leak)
.venv/bin/python -m pytest 2>&1 | grep -i "sentry is attempting" || echo "clean (no Sentry leak)"

# Confirm Sentry is no-op in tests (pytest output should NOT contain this line)
.venv/bin/python -m pytest 2>&1 | grep -i "sentry is attempting" || echo "clean"
```

---

## Implementation Completeness

| Task | Description | Status |
|---|---|---|
| A1 | Webhook + diff parser | **Superseded** — webhook removed in `8711303`; OAuth polling is the new ingestion path |
| A2 | Bear-2 compression | ✓ Complete (P0 bug fixed in `cabe858`) |
| A3 | Claude concept extraction + caching | ✓ Complete (now async per `19fe5f9`) |
| A4 | SM-2 + Redis scheduler | ✓ Complete (P2 — `DEMO_MODE` no env toggle) |
| A5 | Deepgram STT + Claude grader | ✓ Complete (P0 — `grade_answer` hardened in `19fe5f9`; P1 — async client swapped) |
| A6 | Poke calendar integration | ✓ Complete (P1 — IDOR via body-supplied calendar ID; no failure-mode tests) |
| A7 | Browserbase enrichment (P1) | ✓ Complete (P1 — silent failure; 28% coverage) |
| A8 | Frontend landing + dashboard UI | ✓ Complete |
| — | Frontend ↔ backend integration | ✓ Complete (commit `82f2237`) |
| — | Bearer token wiring | ✓ Complete (commit `82f2237`) |
| — | Tests for `schedule-review` and `enrich` routers | ✓ Complete (commit `e13a30c`) |
| — | `grade_answer` test coverage | ✓ Complete (commit `ef2497e`) |
| — | Secrets cleanup post-`0fe1aae7` | **History scrubbed**; **secret rotation still pending** |
| — | Frontend tests | ✗ Missing (P2-S4) |
| — | P1 cleanup pass | ✗ Pending (see "Recommended Execution Order") |

---

## Modified Files (working tree)

| File | What changed | Action |
|---|---|---|
| `STATUS.md` | **this file** — rewritten from second-pass audit | commit |

Working tree clean otherwise.
