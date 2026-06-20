# Repository Status

**Project:** VibeSchool (DiffLingo) — UC Berkeley AI Hackathon (Jun 20–21, 2026)
**Branch:** `main` (3 commits ahead of `origin/main`; 4 modified + 1 untracked, all docs)
**Last commit:** `82f2237` — fix(quiz): auth-gate /api/transcribe and wire frontend bearer token
**Verification:** `pytest` (56/56 pass, 86% backend coverage, 12 Sentry events leak per run)

> **This STATUS.md was rewritten from an audit run on 2026-06-20.** The previous version was significantly out of date (still referenced the deleted webhook path, listed implemented features as TODOs, claimed implementation was untracked). This file is now the source of truth for the repo state **and** the action list of issues to fix.

---

## Current State at a Glance

- **Backend:** FastAPI app with 5 routers under `/api`, all auth-gated except `/health`. Redis Cloud as the only persistent store (no SQL). Ingestion: GitHub OAuth polling (webhooks were removed in `8711303`) → Bear-2 → Claude concept extraction → Redis quiz cache. Quiz hot path: Deepgram STT → Claude grader → SM-2.
- **Frontend:** Next.js 14 App Router + NextAuth. Two user pages (`/dashboard`, `/quiz/[id]`), one auth route, single shared API client (`lib/api.ts`). Bearer token wired end-to-end via `session.accessToken` per commit `82f2237`.
- **Tests:** 56 backend tests pass (live Bear-2/Claude tests gated on real keys). **Zero frontend tests.** Backend coverage 86% overall but `grade_answer`, `schedule-review`, `enrich` paths are weak.
- **Deployment model:** Local-only — backend on `localhost:8000` (uvicorn), frontend on `localhost:3000` (`bun dev`), optional `cloudflared` tunnel for external demo. The earlier Vercel/Render plan was retired; **two files (`backend/main.py` CORS, `backend/render.yaml`) still reflect the old model and need cleanup.**

---

## TL;DR — Top 8 Things to Fix Before the Demo

| # | Sev | Action | Time |
|---|---|---|---|
| 1 | **P0** | **Rotate secrets** — `frontend/.env` was committed in `0fe1aae7` with real GitHub OAuth client secret, `NEXTAUTH_SECRET`, Anthropic key, Deepgram key, Token Company key, and Sentry tokens. They're in permanent git history. | 30 min |
| 2 | **P0** | Add bare `.env` to `frontend/.gitignore` (currently only `.env*.local` is ignored — that's how the leak happened). | 1 min |
| 3 | **P0** | Fix `backend/services/bear2.py:40-41` — `compressed_tokens = data.get("output_tokens") or compressed_tokens` raises `UnboundLocalError` (silently caught) → **silent loss of compression** every time the API omits `output_tokens`. | 5 min |
| 4 | **P0** | Wrap `backend/services/claude.py:144` in try/except AND add tests — `grade_answer` returns 500 on any malformed Claude output, and the entire function is **untested** (coverage gap on lines 121-144). | 30 min |
| 5 | **P0** | Fix CORS origins in `backend/main.py:10-14` — still allows `*.vercel.app` despite deployment going local-only. | 2 min |
| 6 | **P0** | Quiz `MediaRecorder` stream is leaked if user navigates away mid-recording (`frontend/app/quiz/[id]/page.tsx:53-71`). | 10 min |
| 7 | **P0** | Add `AbortController` to dashboard + quiz fetches — quiz navigations race stale responses. | 15 min |
| 8 | **P0** | Decide on `backend/render.yaml` (untracked, dead after local-only pivot). | 1 min |

**Total: ~90 minutes to a clean P0 slate.**

---

## Stack

### Backend
- **Python 3.11** (venv currently 3.14; render.yaml pins 3.11.11)
- **FastAPI** + **uvicorn** — `backend/main.py`, 5 routers under `/api`
- **redis.asyncio** — pool, TLS, health checks, retry-on-timeout (`backend/services/redis_client.py:28-35`)
- **Anthropic SDK** — `claude-sonnet-4-6` for extraction + grading (`backend/services/claude.py`)
- **Deepgram** — nova-2 STT (`backend/services/deepgram_stt.py`)
- **Token Company Bear-2** — diff compression (`backend/services/bear2.py`)
- **Sentry SDK** — no-op when `SENTRY_DSN` empty (`backend/sentry_init.py`)
- **fakeredis** — in-memory Redis for hermetic tests (`backend/tests/conftest.py`)
- **pytest-asyncio** — `asyncio_mode=auto` (`pytest.ini`)

### Frontend
- **Next.js 14.2.35** App Router — no `pages/`, no `components/`, no `hooks/`
- **NextAuth 4.24.14** with GitHub provider, scopes `read:user user:email repo`
- **React 18** + **TypeScript strict**
- **@sentry/nextjs 10.59.0** (peer range worth verifying against Next 14.2)
- **bun** (lockfile present)

### Integrations
| Service | Used for | File |
|---|---|---|
| GitHub OAuth | User identity + per-user API token (passed as bearer to backend) | `frontend/app/api/auth/[...nextauth]/route.ts`, `backend/dependencies/auth.py` |
| GitHub REST API | List user repos, list merged PRs, fetch diffs | `backend/services/github_oauth.py` |
| Claude | Concept extraction (ingestion), answer grading (quiz hot path) | `backend/services/claude.py` |
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
  models.py                     Pydantic: QuizConcept (ConceptList is dead)
  requirements.txt              11 deps, all unpinned
  .env.example                  Template
  render.yaml                   Untracked; dead after local-only pivot
  routers/
    sync.py                     POST /api/sync, GET /api/sync/status
    concepts.py                 GET  /api/concepts
    quiz.py                     POST /api/transcribe, /api/grade
    schedule.py                 POST /api/schedule-review (no tests)
    enrich.py                   POST /api/enrich (no tests)
  dependencies/
    auth.py                     get_current_user — validates GitHub bearer via /user
  services/
    redis_client.py             Connection pool + cache/quiz/SM-2 helpers
    token_store.py              Fernet-encrypted OAuth tokens at rest
    sync.py                     Orchestrator (Bear-2 → Claude → Redis)
    github_oauth.py             GitHub REST helpers
    claude.py                   extract_concepts_and_cache, grade_answer
    bear2.py                    compress_diff (P0 bug, see below)
    deepgram_stt.py             transcribe_audio
    poke.py                     schedule_review_block
    browserbase.py              enrich_concept
    diff_parser.py              clean_diff (fetch_and_parse_diff is dead)
    sm2.py                      SM-2 algorithm (DEMO_MODE flag, no env toggle)
  scripts/
    check_redis.py              Smoke test (0% coverage)
  tests/
    conftest.py                 Autouse fakeredis fixture
    test_auth.py                6 tests, 98% coverage
    test_redis.py               17 tests, 100% coverage
    test_sm2.py                 1 test, 94% coverage
    test_diff_parser.py         5 tests, 100% coverage
    test_bear2.py               3 tests, 85% coverage (live gated)
    test_claude.py              4 tests, 96% coverage (live gated)
    test_github_oauth.py        4 tests, 97% coverage
    test_quiz_router.py         4 tests, 100% coverage
    test_sync_router.py         5 tests, 100% coverage
    test_sync.py                5 tests, 94% coverage
    test_e2e.py                 2 tests, 98% coverage (live gated)
    fixtures/                   sample.diff, pr_payload.json

frontend/
  app/
    layout.tsx                  Root layout (Geist fonts bundled, ~130 kB)
    page.tsx                    Landing page (140 lines, client component)
    providers.tsx               SessionProvider
    global-error.tsx            No digest/message shown (P3 style)
    dashboard/page.tsx          Protected; concept grid + due sidebar
    quiz/[id]/page.tsx          6-state machine; MediaRecorder (P0 bugs here)
    api/auth/[...nextauth]/route.ts  NextAuth GitHub provider + callbacks
  lib/
    api.ts                      Single fetch wrapper; typed endpoints
  types/
    next-auth.d.ts              Module augmentation: accessToken on Session/JWT
  instrumentation.ts            Sentry server-side hook
  instrumentation-client.ts     Sentry client-side init
  sentry.{server,edge}.config.ts
  next.config.mjs               Sentry wrapper, no images.remotePatterns
  tailwind.config.ts            Stale `./pages/**` and `./components/**` globs
  .env                          ⚠️ TRACKED IN GIT (P0)
  .env.local.example            Template — also lists backend-only secrets (misleading)
  .gitignore                    Only ignores `.env*.local` (P0)

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
| GET | `/health` | `main.py:26` | none | Liveness probe only (no Redis ping) |
| POST | `/api/sync` | `routers/sync.py:13` | bearer | 5-min per-user lock; idempotent |
| GET | `/api/sync/status` | `routers/sync.py:27` | bearer | last_sync ts + ISO |
| GET | `/api/concepts` | `routers/concepts.py:9` | bearer | All due concepts (no single-quiz endpoint — see F-2) |
| POST | `/api/transcribe` | `routers/quiz.py:13` | bearer | Deepgram; auth-gated as of 82f2237 |
| POST | `/api/grade` | `routers/quiz.py:48` | bearer | Claude grades + SM-2 update |
| POST | `/api/schedule-review` | `routers/schedule.py:18` | bearer | Takes `user_calendar_id` from body (P1 IDOR) |
| POST | `/api/enrich` | `routers/enrich.py:16` | bearer | Browserbase; swallows failures |

---

## Findings (Unified)

### P0 — must fix before demo

| ID | Domain | Where | Issue |
|---|---|---|---|
| **P0-S1** | secrets | `frontend/.env` in commit `0fe1aae7` | Real GitHub OAuth client ID+secret, `NEXTAUTH_SECRET`, Anthropic key, Deepgram key, Token Company key, Sentry tokens in permanent git history. **Confirmed via `git show 0fe1aae7 -- frontend/.env`.** Action: rotate every secret listed, `git filter-repo --path frontend/.env --invert-paths`, force-push (or treat as permanently compromised if repo went public). |
| **P0-S2** | secrets | `frontend/.gitignore:29` | Only `.env*.local` is ignored; bare `.env` is NOT. This is why P0-S1 happened. Add `.env` to the local env files block. |
| **P0-B1** | backend | `services/bear2.py:40-41` | `compressed_tokens = data.get("output_tokens") or compressed_tokens` — `compressed_tokens` is first bound on line 51. If `data.get("output_tokens")` is falsy, `or compressed_tokens` raises `UnboundLocalError`, **caught by the broad `except Exception` on line 42**, which then falls back to the raw diff — silently discarding real compression. Not a crash; a cost regression that fires every time the API omits `output_tokens`. **Fix:** hoist the heuristic above the `try`, then only override if API count is present. |
| **P0-B2** | backend | `services/claude.py:138-144` | `grade_answer` returns `json.loads(_strip_fences(...))` with no try/except. Malformed Claude output → 500. **Same function is also completely untested** (coverage report marks lines 121-144 as missing). Fix the bug AND add tests in one commit. |
| **P0-B3** | backend | `backend/main.py:10-14` | CORS allowlist still includes `https://vibeschool.vercel.app` and `https://*.vercel.app` — but the modified `vibeschool_demo_readiness.md` flipped deployment to local-only. Tunnel demos via `*.trycloudflare.com` will CORS-fail. |
| **P0-B4** | backend | `backend/render.yaml` (untracked) | Either dead code (post local-only pivot) or needed. Currently could be lost on `git clean`. Delete. |
| **P0-F1** | frontend | `app/quiz/[id]/page.tsx:26,53-71` | `recorderRef` cleanup missing. If user clicks Stop then navigates away, OR navigates mid-recording, the mic indicator stays on, the recorder keeps firing `ondataavailable`, and `handleGrade` runs on the unmounted component (`setStage("done")` on dead instance). Privacy issue + React warning. |
| **P0-F2** | frontend | `app/dashboard/page.tsx:140-149`, `app/quiz/[id]/page.tsx:33-51` | No `AbortController` on fetches. (a) Navigating away mid-fetch → setState on unmounted component. (b) On the quiz page, navigating `/quiz/abc` → `/quiz/def` while both fetches are in flight lets the slower `abc` response land last and overwrite `concept` with the wrong data. |

### P1 — real risks

| ID | Where | Issue |
|---|---|---|
| **P1-B1** | `services/claude.py:12,62,138` | Sync `anthropic.Anthropic()` used in `async def extract_concepts_and_cache` and `async def grade_answer`. Each Claude call (2-10s) **blocks the entire event loop**. Swap to `anthropic.AsyncAnthropic` + `await client.messages.create(...)`. |
| **P1-B2** | `dependencies/auth.py:12,76` | `_USER_CACHE` grows unbounded — TTL only checked on read, never evicted. Convert to `cachetools.TTLCache(maxsize=10000, ttl=60)`. |
| **P1-B3** | `dependencies/auth.py:70-74` | `try: await store_token(...) except Exception: pass` — Redis blip silently fails token persistence. Capture to Sentry. |
| **P1-B4** | `services/claude.py:144` | Claude's `quality` not validated 0-5 before being passed to `sm2_next`. Out-of-range value breaks EF math / clamp. `q = max(0, min(5, int(result["quality"])))`. |
| **P1-B5** | `services/diff_parser.py:19-50` | `fetch_and_parse_diff` is dead code in the new OAuth path. Still references legacy `GITHUB_TOKEN` env-var fallback. Delete. |
| **P1-B6** | `services/github_oauth.py:48-51` | `get_authenticated_user` is dead code — `auth.py:48-60` calls GitHub inline instead. Either route through it (preferred, single seam) or delete. |
| **P1-B7** | `routers/schedule.py:12-15,19` | `user_calendar_id` comes from request body. Horizontal-privilege primitive. Look up server-side from `user_id`. |
| **P1-B8** | `routers/enrich.py:25` + `browserbase.py:68` | `enrich_concept` returns `""` on failure; router returns `{"snippet": ""}` with no error indicator. Frontend can't distinguish "MDN returned nothing" from "Browserbase key wrong". Return `{snippet, ok, error}`. |
| **P1-B9** | 5+ services | New `httpx.AsyncClient()` per request in `auth.py:48`, `bear2.py:23`, `deepgram_stt.py:21`, `poke.py:34`, `browserbase.py:27`, `github_oauth.py:42`, `diff_parser.py:34`. Module-level clients with sane limits. |
| **P1-F1** | `app/quiz/[id]/page.tsx:81,87` | `session!.accessToken!` non-null assertions in `handleGrade`. If `useSession` returns unauthenticated at click time, page crashes mid-recording. Refactor to take token explicitly. |
| **P1-F2** | `app/quiz/[id]/page.tsx:35-46` | Quiz page pulls the **entire** due-concept list to render one concept. If concept isn't in the due set, user sees "not found" even for concepts that exist. Add `GET /api/concepts/:id` to backend. |
| **P1-F3** | `app/quiz/[id]/page.tsx:127` | `onRetry={() => setStage("idle")}` doesn't reset `transcript`/`result`/`errorMsg`. Fragile — can flash previous attempt's content. |
| **P1-F4** | `lib/api.ts:6-7` | `NEXT_PUBLIC_BACKEND_URL` is captured at module load. If missing in prod, browser silently hits `localhost:8000` instead of failing loudly. Throw at startup if missing in production. |
| **P1-F5** | `app/dashboard/page.tsx:137`, `app/quiz/[id]/page.tsx:30` | `router.replace("/")` drops the callback URL. Use `router.replace(\`/?callbackUrl=${encodeURIComponent(pathname)}\`)`. |
| **P1-S1** | `backend/tests/` (missing `test_schedule_router.py`, `test_enrich_router.py`) | The two routers that handle client-controlled fields (`schedule-review`, `enrich`) are the two with the worst coverage (`routers/schedule.py:62%`, `routers/enrich.py:75%`) and **no router-level tests**. Same root cause as P1-B7 + P1-B8. |
| **P1-S2** | `pytest.ini`, `backend/sentry_init.py` | Test suite emits events to production Sentry (`"Sentry is attempting to send 12 pending events"` per `pytest` output). Add a fixture in `conftest.py` that re-inits Sentry with `dsn=None` for the test session. |
| **P1-S3** | `backend/routers/quiz.py:27,34` | `/api/transcribe` reads arbitrary-size audio into memory, no size cap, no content-type allow-list. DoS + cost vector on a Deepgram-billed endpoint. 10 MB cap (413), whitelist `audio/webm`, `audio/wav`, `audio/mpeg`, `audio/ogg`. |

### P2 — tech debt / hardening

| ID | Where | Issue |
|---|---|---|
| **P2-B1** | `services/redis_client.py:103-126` | `get_due_concepts` is N+1: `zrangebyscore` + 2N `r.get` calls. 30 due concepts = 61 round-trips. Pipeline. |
| **P2-B2** | `services/sm2.py:6` | `DEMO_MODE = True` is a module-level constant with no env toggle. Production deploys silently use minute-scale intervals. Env-flag toggle. |
| **P2-B3** | routers | Pydantic request models live inline in routers (`GradeRequest` in `quiz.py:43-45`, `ScheduleRequest` in `schedule.py:12-15`, `EnrichRequest` in `enrich.py:11-13`). `models.py:14-15` (`ConceptList`) is dead — never imported. |
| **P2-B4** | tests | Hardcoded token literals (`ghp_test`, `ghp_xyz`) in `test_auth.py`/`test_quiz_router.py`/`test_sync_router.py`. GitHub secret scanner may flag. Fixtures that generate random strings. |
| **P2-B5** | `auth.py:17,33`; `redis_client.py:142` | Imports inside function bodies (`hashlib`, `time`, `from backend.services.sm2 import sm2_next`). Move to module top. |
| **P2-B6** | `requirements.txt` | All deps unpinned. Reproducible builds impossible. Pin. |
| **P2-B7** | `services/github_oauth.py:62-76` | `list_user_repos` has no max-page bound. Org admin with 500+ repos → unbounded loop. `MAX_PAGES=50` guard. |
| **P2-B8** | `services/redis_client.py:148-150` | `update_sm2_state` raises bare `ValueError` for missing concept → 500. Use `HTTPException(404)`. |
| **P2-B9** | `services/diff_parser.py:69` | `pat.replace("*", "") in filename` is brittle. `fnmatch.fnmatch`. |
| **P2-B10** | `sentry_init.py:7-11` | `traces_sample_rate=1.0`, `profiles_sample_rate=1.0` — burns quota. Lower or env-driven. |
| **P2-F1** | `lib/api.ts:109-116` | `api.triggerSync` and `api.syncStatus` are dead code. Either wire a "Sync" button on dashboard or delete along with their types. |
| **P2-F2** | `lib/api.ts:25-49` | `apiFetch<T>` uses `as T` cast — schema drift won't be caught. Add Zod parse. |
| **P2-F3** | `app/quiz/[id]/page.tsx:57-58` | `MediaRecorder` constructed without `timeslice` — fine, but `chunksRef` (plural) suggests the author expected multiple chunks. |
| **P2-F4** | `app/quiz/[id]/page.tsx:59-63` | `onstop` closure recreated every render. Memoize or pass token explicitly. |
| **P2-F5** | `app/global-error.tsx:7-23` | Renders Next's stock error page with `statusCode={0}` and no message. Inline `error.digest` + Reload button. |
| **P2-F6** | `app/dashboard/page.tsx:147,213-214` | Dashboard shows raw backend error string in UI → leaks `ApiError.body`. Map status → user-friendly string, log body to Sentry only. |
| **P2-F7** | `frontend/.env.local.example:6-8,12-13` | Lists `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `REDIS_URL`, `TOKEN_COMPANY_API_KEY`, `POKE_API_KEY` — all backend-only, none used by frontend. Misleading. |
| **P2-F8** | `app/dashboard/page.tsx:151-157` | Redirect-on-unauthenticated race: if `useSession` returns `unauthenticated` for one render before cookie settles, redirect fires immediately. |
| **P2-F9** | `app/quiz/[id]/page.tsx` | No `<title>` / `generateMetadata`. Deep-linked quiz URLs all show the same generic title. |
| **P2-S1** | `backend/main.py:12` | `allow_origins=["https://*.vercel.app"]` is wildcard on a shared multi-tenant domain. Pin to exact origins. |
| **P2-S2** | `backend/main.py`, `backend/config.py` | No `logging.basicConfig` anywhere. If `SENTRY_DSN` is empty in prod, errors vanish silently. |
| **P2-S3** | `backend/requirements.txt:8` | `PyGithub` is imported nowhere (`grep` confirms zero hits). Dead dependency. Remove. |
| **P2-S4** | `frontend/` | Zero frontend tests. Quiz/audio flow entirely untested. Add Vitest + `@testing-library/react`. |

### P3 — style / nits

| ID | Where | Issue |
|---|---|---|
| **P3-B1** | `redis_client.py:80` | Magic `now + 60` → name `INITIAL_DUE_OFFSET_SECONDS`. |
| **P3-B2** | `auth.py:72-74` | Bare `except Exception` → use `except (redis.RedisError, ValueError)`. |
| **P3-B3** | routers | Pydantic models lack `Field(..., max_length=...)` constraints on user-supplied strings. |
| **P3-B4** | `pytest.ini` | Doesn't pin Python; venv is 3.14, render.yaml targets 3.11. |
| **P3-F1** | `tailwind.config.ts:5-6` | Lists `./pages/**/*` and `./components/**/*` globs that don't exist. |
| **P3-F2** | `tsconfig.json:6` | `strict` on, but `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`, `noFallthroughCasesInSwitch` are off — cheap upgrades. |
| **P3-F3** | `frontend/package.json:12` | `@sentry/nextjs ^10.59.0` next to `next 14.2.35` — peer range worth verifying. |
| **P3-F4** | `app/page.tsx:11-138` | 140 lines of marketing copy in a client component. Move static parts to a Server Component. |
| **P3-F5** | `lib/api.ts:46-48` | `204 No Content` returns `undefined as unknown as T`. Document or return discriminated union. |
| **P3-S1** | `sentry_init.py:9-10` | `traces_sample_rate=1.0` + `profiles_sample_rate=1.0` → costs money; could include PII in spans. |
| **P3-S2** | `frontend/app/api/auth/[...nextauth]/route.ts:9` | GitHub OAuth scope `repo` is over-scoped (backend only reads) → `read:user user:email public_repo`. |
| **P3-S3** | `services/deepgram_stt.py:45` | User transcripts (PII-adjacent) sent to Sentry as breadcrumb messages. |
| **P3-S4** | `lib/api.ts:34,135` | Token exposed in client JS memory; missing CSP header in `frontend/app/layout.tsx` means any XSS exfiltrates every user's GitHub OAuth token. |

---

## Coverage Report

```
TOTAL                                  1203   173   86%
```

| File | Stmts | Miss | Cover | Risk |
|---|---|---|---|---|
| `routers/sync.py` | 14 | 0 | 100% | ✅ |
| `services/redis_client.py` | 96 | 3 | 97% | ✅ |
| `services/sm2.py` | 22 | 0 | 100% | ✅ |
| `services/sync.py` | 57 | 8 | 86% | ⚠️ error paths untested |
| `services/claude.py` | 43 | 10 | 77% | ⚠️ **`grade_answer` (lines 121-144) is 0% — exactly the function with two P0 bugs** |
| `routers/concepts.py` | 8 | 2 | 75% | ⚠️ |
| `routers/quiz.py` | 28 | 7 | 75% | ⚠️ |
| `routers/enrich.py` | 12 | 3 | 75% | ⚠️ only happy path |
| `routers/schedule.py` | 16 | 6 | **62%** | ⚠️ **no router test exists** |
| `services/diff_parser.py` | 37 | 13 | 65% | ⚠️ |
| `services/github_oauth.py` | 50 | 13 | 74% | ⚠️ |
| `services/bear2.py` | 24 | 4 | 83% | ⚠️ line 42-49 (the bug region) untested |
| `services/token_store.py` | 30 | 6 | 80% | ⚠️ |
| `services/deepgram_stt.py` | 13 | 8 | **38%** | ⚠️ **no failure-mode tests** |
| `services/poke.py` | 14 | 8 | **43%** | ⚠️ **no failure-mode tests** |
| `services/browserbase.py` | 29 | 21 | **28%** | ⚠️ **no failure-mode tests** |
| `scripts/check_redis.py` | 39 | 39 | 0% | (standalone script, fine) |

**Frontend:** 0% — no test runner configured.

---

## Auth Flow Trace (verified end-to-end)

1. User clicks "Sign in" on `/` → `signIn("github")` (NextAuth client).
2. GitHub OAuth round-trip with scopes `read:user user:email repo`.
3. Callback hits `frontend/app/api/auth/[...nextauth]/route.ts` (the `jwt` callback, line 13-18): on first sign-in only, copies `account.access_token` onto the JWT cookie. NextAuth's built-in state generation/verification handles CSRF.
4. The `session` callback (line 19-22) exposes the JWT's access token as `session.accessToken`.
5. Client components (`dashboard/page.tsx:130`, `quiz/[id]/page.tsx:17`) read it via `useSession()`.
6. `lib/api.ts:33-35` (JSON calls) and `lib/api.ts:133-137` (multipart transcribe) attach `Authorization: Bearer <accessToken>`.
7. Backend `dependencies/auth.py:get_current_user` validates by hitting `GET {GITHUB_API_BASE}/user` with a 60-second in-process cache keyed by SHA-256 of the token.
8. On success, the token is Fernet-encrypted and persisted to Redis at `user:{user_id}:encrypted_token` (30-day TTL) via `services/token_store.py`.

The token never touches `localStorage` / `sessionStorage` / `document.cookie` — it lives entirely in NextAuth's HttpOnly JWT cookie. ✅ correct pattern.

---

## Cross-Cutting Observations

- **`grade_answer` is the highest-leverage fix.** Two bugs (no JSON error handling + sync Anthropic in async) AND it's the most untested function in the entire backend. Fixing it touches all three: bug fix + tests + AsyncAnthropic swap.
- **`claude.py` is sync, but called from everywhere async.** `services/claude.py:12` is the only `anthropic.Anthropic` instantiation, and it powers both `extract_concepts_and_cache` (called from `services/sync.py` during ingestion) and `grade_answer` (called from `routers/quiz.py` on every answer). Swap to `AsyncAnthropic` once, fix everywhere.
- **The `frontend/.env` leak is the only thing in this report that's truly unrecoverable without action.** Everything else is a code fix. The leak needs (a) rotation of every key, (b) `git filter-repo` to remove from history, (c) a fix to `.gitignore` to prevent recurrence.
- **The two routers that handle client-controlled fields (`schedule-review`, `enrich`) are the two with no router tests and the worst coverage.** Same root cause: P1-B7 + P1-B8 + P1-S1.
- **The deployment-model pivot (Vercel → local) is reflected in docs but not in code.** Three places: CORS origins (P0-B3), `backend/render.yaml` (P0-B4), frontend README references to Vercel.

---

## Recommended Execution Order (P0 → demo)

1. **Rotate + revoke the leaked secrets** (P0-S1) — 30 min — do this FIRST, before any other commit, because the next push widens the leak surface.
2. **Add `.env` to `frontend/.gitignore`** (P0-S2) — 1 min.
3. **Fix `bear2.py:40-41`** (P0-B1) — 5 min.
4. **Fix `claude.py:144` + add tests for `grade_answer` (lines 121-144) + swap to AsyncAnthropic + validate quality 0-5** (P0-B2 + P1-B1 + P1-B4) — 1 hr, one PR.
5. **Fix CORS origins** (P0-B3) — 2 min.
6. **Delete `backend/render.yaml`** (P0-B4) — 1 min.
7. **Fix MediaRecorder leak** (P0-F1) — 10 min.
8. **Add AbortController to dashboard + quiz fetches** (P0-F2) — 15 min.

**Total: ~2 hours to a clean P0 slate.**

---

## What is Explicitly NOT Needed

- Full rewrite of `claude.py` — just swap the client and add a try/except.
- New state management library (Redux/Zustand) — `useState` + `useRef` is fine for two pages.
- Database (Postgres etc.) — Redis-only is appropriate for the demo.
- New auth library — NextAuth + GitHub bearer is correct.
- Backend framework change — FastAPI is doing the job.
- New test framework on the backend — pytest + fakeredis is the right setup; just needs more tests for `grade_answer`, `schedule-review`, `enrich`, and the failure paths in `poke`/`browserbase`/`deepgram_stt`.

---

## Verification

```bash
# Backend tests + coverage
.venv/bin/python -m pytest --tb=short
.venv/bin/python -m pytest --cov=backend --cov-report=term-missing

# Frontend type-check + lint + build
cd frontend && bun x tsc --noEmit
cd frontend && bun run lint
cd frontend && bun run build

# Manual smoke (after fixing P0-B3)
curl -s http://localhost:8000/health
curl -s -H "Authorization: Bearer ghp_test" http://localhost:8000/api/sync/status

# Confirm secrets scrubbed from history
git log --all --oneline -- frontend/.env   # should be empty after filter-repo
```

---

## Implementation Completeness

| Task | Description | Status |
|---|---|---|
| A1 | Webhook + diff parser | **Superseded** — webhook removed in `8711303`; OAuth polling is the new ingestion path |
| A2 | Bear-2 compression | ✓ Complete (P0 bug in line 40-41) |
| A3 | Claude concept extraction + caching | ✓ Complete |
| A4 | SM-2 + Redis scheduler | ✓ Complete (P2 — `DEMO_MODE` no env toggle) |
| A5 | Deepgram STT + Claude grader | ✓ Complete (P0 — `grade_answer` no JSON error handling; P1 — sync client in async) |
| A6 | Poke calendar integration | ✓ Complete (P1 — IDOR via body-supplied calendar ID; no tests) |
| A7 | Browserbase enrichment (P1) | ✓ Complete (P1 — silent failure; 28% coverage) |
| A8 | Frontend landing + dashboard UI | ✓ Complete |
| — | Frontend ↔ backend integration | ✓ Complete (commit 82f2237) |
| — | Bearer token wiring | ✓ Complete (commit 82f2237) |
| — | Tests for `schedule-review` and `enrich` routers | ✗ Missing |
| — | Frontend tests | ✗ Missing |
| — | Secrets cleanup post-`0fe1aae7` | ✗ Pending rotation |

---

## Modified Files (working tree)

| File | What changed | Action |
|---|---|---|
| `.hermes/plans/2026-06-20_131518-oauth-sync-refactor.md` | 2 lines — wording | keep |
| `.hermes/plans/2026-06-20_142814-host-backend-locally-cloudflare.md` | 70 lines — local+tunnel rewrite | keep |
| `AGENTS/vibeschool_audit_issues.md` | 11 lines — updated P2-2 for local model | keep |
| `AGENTS/vibeschool_demo_readiness.md` | 167 lines — rewrote for local-only deployment | keep |
| `AGENTS/vibeschool_roadmap.md` | 2 lines — flipped deployment row | keep |
| `RENAME.md` | 28 lines — added local-only env section | keep |
| `frontend/README.md` | 26 lines — local dev instructions | keep |
| `backend/render.yaml` | **untracked** | **delete** (P0-B4) |
| `STATUS.md` | **this file** — rewritten from audit | commit |