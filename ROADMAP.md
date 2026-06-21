# VibeSchool — Roadmap & Build Plan

> **Project:** VibeSchool (also: DiffLingo) — a spaced-repetition developer learning tool that turns merged GitHub PRs into active voice quizzes.
> **Event:** UC Berkeley AI Hackathon 2026 (June 20–21)
> **Team:** Aryan Ashta (backend/ML) + Samuel (fullstack)
> **Branch:** `main` → `origin/main` (in sync at session start; `backend/config.py` + `backend/services/claude.py` modified — TokenRouter support, uncommitted)
> **Last audit:** 2026-06-20 21:00 PDT
> **Companion doc:** `STATUS.md` — current verified state of every component, with P0/P1/P2 fix list and verification commands.

This file is the **build plan** (what we're building, why, for whom). For "is this thing actually working right now, and what's broken," read `STATUS.md`.

---

## TL;DR — One-sentence pitch

GitHub merged PR → Bear-2 compresses diff → Claude extracts the CS concept + writes a roast → quiz is pre-cached in Redis with SM-2 scheduling → Deepgram STT transcribes the developer's spoken answer → Claude grades it → SM-2 updates → Poke schedules the next review on their calendar. **Voice is the delivery mechanism, not a feature.** Removing voice removes the product.

---

## Sponsor integration map

Every sponsor named below is wired into the actual running code path. The "where" column points at the file that issues the network call; the "demo proof" column names what a judge can click to see it work.

| Sponsor | Integration point | Demo proof (judge sees) | Service-level tests | Track criteria fit | Priority |
|---|---|---|---|---|---|
| **Anthropic** | `backend/services/claude.py` — `extract_concepts_and_cache` (ingestion) + `grade_answer` (hot path). AsyncAnthropic client, JSON-only system prompt, fenced-output stripper, defensive quality clamp. | Open a merged PR → roast + quiz question appears in the dashboard. Speak an answer → grade result + SM-2 `next_review` updates. | 4 hermetic tests for `grade_answer` (happy path, malformed JSON, quality clamp high/low); only live test for `extract_concepts_and_cache` (no mocked JSON-parse test). | "Built with Claude Code; meaningful domain impact" | P0 |
| **Token Company (Bear-2)** | `backend/services/bear2.py` — `compress_diff` runs before every Claude ingestion call. API body is `{"model":"bear-2","input":raw_diff}`, response reads `output` + `output_tokens`. Falls back to raw diff on failure (no blocking). | Sentry breadcrumb fires after every successful compression: `"Bear-2 compression: X → Y tokens (Z% reduction)"`. | Fallback test ✅; live compression test ✅; token-count heuristic test ✅. No test for response-shape mismatch (missing `output` key would throw `KeyError`). | "Depth + ingenuity" | P0 |
| **Deepgram** | `backend/services/deepgram_stt.py` — `transcribe_audio` powers `/api/transcribe`. Nova-2 REST model, `audio/webm` from MediaRecorder. 10 MB cap + content-type allow-list on the router to bound the cost vector. | Hit 🎤 on any concept → speak → transcript appears in the UI. | **0 service-level tests.** Router tests in `test_quiz_router.py` + `test_transcribe_limits.py` mock `transcribe_audio` away. The actual Deepgram call path is never exercised in tests. Failure raises uncaught → 500 (P1-DG). | "Voice essential to experience" | P0 |
| **Redis Cloud** | `backend/services/redis_client.py` — single source of truth. SM-2 state per concept, pre-cached quiz content, due-queue ZSET, idempotency hash for processed PRs, Fernet-encrypted OAuth tokens (30-day TTL via `services/token_store.py`). 7-day TTL on everything else. | After grading, `due:{user_id}` ZSET advances; `/api/concepts` re-orders by urgency. | 29 tests, 100% coverage. TTL pinned on every key type. `update_sm2_state_quality_clamps_via_caller` is xfail (documents a real missing clamp). | "Core infra" | P0 |
| **Interaction Co (Poke)** | `backend/services/poke.py` + `backend/routers/schedule.py` — `POST /api/schedule-review` schedules a 10-min "VibeSchool: review [concept]" block at the SM-2 next-review timestamp. | Submit a graded quiz → calendar event appears in the user's calendar. | **0 service-level tests.** Router test in `test_schedule_router.py` mocks `schedule_review_block` away. Failure raises uncaught → 500 (P1-PK). IDOR via body-supplied `user_calendar_id` (P1-B7). | "Tool integration depth" | P0 |
| **Sentry** | `backend/sentry_init.py` + `frontend/instrumentation*.ts` — instrumented from hour one. Breadcrumbs on every Bear-2 call (token delta), every Claude call (concept count), every GitHub page (chars), every Redis write (state delta). `dsn=None` ⇒ no-op SDK. | Open Sentry dashboard → see real Bear-2 + Claude + GitHub breadcrumbs from the demo session. | `tests/conftest.py:sentry_test_safe` re-inits SDK with `dsn=None, traces_sample_rate=0, transport=None` — no pytest leak. 100% sample rates on the live SDK (cost concern, P2-B10). | "Reliability from day one; team execution" | P0 |
| **Browserbase** | `backend/services/browserbase.py` + `backend/routers/enrich.py` — `POST /api/enrich` scrapes MDN/docs.python.org/wikipedia for the extracted concept and appends a snippet. | Trigger `/api/enrich` for a concept → first paragraph from MDN appears as "further reading". | **0 service-level tests.** Router test in `test_enrich_router.py` mocks `enrich_concept` away. Silent failure → returns `""` (P1-B8). 28% coverage on the service file. | "Any agent using the web powered by Browserbase" | **P1** — only attempt if all P0s are stable |

**Out of integration scope:** no Postgres, no SQL, no Vercel, no Render, no Vector DB. Redis is the only persistent store. The app runs locally on the developer's laptop (backend on `:8000`, frontend on `:3000`); an optional `cloudflared` quick-tunnel can expose `:8000` for external demos. **No cloud-hosted runtime.**

---

## Latency architecture

The single most expensive operation (Claude concept extraction) is **never on the quiz hot path**. It runs once per PR at ingestion time; its output is cached in Redis under `concept:{user_id}:{concept_id}:quiz` with a 7-day TTL. The quiz session reads from Redis (sub-10ms p50 against Redis Cloud), Deepgram TTS plays immediately on the pre-cached text. The only real-time Claude call during a quiz is answer grading, which is short input + short output (≤ 256 tokens) and finishes well within human-perceptible latency.

```
INGESTION (async, after a "Sync" click on the dashboard):
  list user repos → list merged PRs → fetch each diff →
  Bear-2 compress → Claude extract → cache {concept, roast, question, hint, answer_hint} in Redis
                                  ↘ update SM-2 state + due-queue ZSET

QUIZ SESSION (real-time, when the user clicks 🎤 on a concept):
  GET /api/concepts/{concept_id} → Redis quiz cache →
  browser plays pre-cached audio (TTS, currently silent — STT-only today) →
  MediaRecorder captures answer → POST /api/transcribe → Deepgram STT →
  POST /api/grade → Claude grader → SM-2 update → due-queue re-rank
  → optional POST /api/schedule-review → Poke calendar block
```

---

## Tech stack — confirmed shipped

### Backend (`backend/`, Python 3.14)
- **FastAPI** + **uvicorn** (`backend/main.py` mounts 5 routers under `/api`)
- **redis.asyncio** — pooled client, TLS, health checks, retry-on-timeout (`services/redis_client.py:29-36`)
- **Anthropic SDK** — `anthropic.AsyncAnthropic` (`services/claude.py:16`); model env-overridable
- **Deepgram** — `nova-2` STT (`services/deepgram_stt.py`)
- **Token Company Bear-2** — `compress_diff` (`services/bear2.py`); graceful fallback
- **httpx** for all outbound HTTP — per-request `AsyncClient` (debt item, see `STATUS.md` P1-B9)
- **Sentry SDK** — no-op when `SENTRY_DSN` empty; pytest session also no-op via `tests/conftest.py:sentry_test_safe`
- **fakeredis** — in-memory Redis for hermetic tests (`tests/conftest.py`)
- **pytest-asyncio** — `asyncio_mode=auto` (`pytest.ini`)

### Frontend (`frontend/`, Next.js 14 App Router)
- **Next.js 14.2.35** — no `pages/`, no `components/` dir, no hooks dir (single `useRecorder.ts` in `lib/`)
- **NextAuth 4.24.14** with GitHub provider, scopes `read:user user:email repo`
- **React 18** + **TypeScript strict**
- **@sentry/nextjs 10.59.0**
- **bun** (lockfile present, `bun dev` is the dev command)
- **Vitest** — **NOT installed** (see `STATUS.md` P2-S4)

### Optional infrastructure
- **cloudflared** quick-tunnel — `./start-local.sh` exposes `localhost:8000` at a rotating `*.trycloudflare.com` URL. CORS regex in `backend/main.py:16` already accepts that hostname pattern.

---

## What was built (per phase)

### Phase 1 — Sat 10 AM → 3 PM: core loop visible
| Task | Description | Status | Evidence |
|---|---|---|---|
| A1 | GitHub webhook + diff parser | **Superseded** by OAuth polling in `8711303`/`bf11523`. The webhook path was deleted; `/api/sync` polls the GitHub REST API on user demand using their OAuth token. | `backend/services/sync.py`, `backend/services/github_oauth.py` |
| A2 | Token Company Bear-2 compression | ✅ Complete + bug-fixed (`cabe858`). | `backend/services/bear2.py` |
| A3 | Claude concept extraction + caching | ✅ Complete + async (`19fe5f9`). | `backend/services/claude.py:57-122` |
| S1 | Next.js scaffold + GitHub OAuth via NextAuth | ✅ Complete. | `frontend/app/api/auth/[...nextauth]/route.ts` |
| S2 | Sentry instrumentation (hour one) | ✅ Complete — three runtimes (client / server / edge), SDK init order correct, no-op when DSN empty, no leak in pytest. | `frontend/instrumentation*.ts`, `sentry.{client,server,edge}.config.ts`, `backend/sentry_init.py` |
| S3 | Dashboard skeleton | ✅ Complete + live-wired (commit `82f2237`). | `frontend/app/dashboard/page.tsx` |

### Phase 2 — Sat 3 PM → 7 PM: voice quiz loop end-to-end
| Task | Description | Status | Evidence |
|---|---|---|---|
| A4 | SM-2 + Redis scheduler | ✅ Complete. `services/sm2.py` + `services/redis_client.py:cache_quiz_content` + `update_sm2_state`. TTL pinned at 7 days. | `backend/tests/test_sm2.py` (98% cov), `backend/tests/test_redis.py` (100% cov) |
| A5 | Deepgram STT + Claude grader | ✅ Complete. `grade_answer` JSON-parse hardened (`19fe5f9`), quality clamped to `[0,5]`, async client. | `backend/services/claude.py:125-168`, `backend/services/deepgram_stt.py` |
| S4 | Deepgram TTS playback | ⚠️ **In spec but NOT shipped.** STT works (developer speaks, transcript returns). TTS (reading roast/question aloud to developer) is not wired — see `STATUS.md` "Out of scope (intentional)". | — |
| S5 | Quiz UI + mic button | ✅ Complete. 6-state machine, uses extracted `useRecorder` hook, AbortController-wired, retry state cleanly reset. | `frontend/app/quiz/[id]/page.tsx`, `frontend/lib/useRecorder.ts` |

### Phase 3 — Sat 7 PM → 1 AM: polish + integration
| Task | Description | Status | Evidence |
|---|---|---|---|
| A6 | Poke API calendar integration | ✅ Code-complete (`/api/schedule-review` works); **43% test coverage** on the service (no failure-mode tests); **P1-B7 IDOR still open** (calendar ID comes from request body). | `backend/services/poke.py`, `backend/routers/schedule.py` |
| A7 | Browserbase docs enrichment (P1) | ✅ Code-complete but **silent on failure** (P1-B8); **28% test coverage** on the service. | `backend/services/browserbase.py`, `backend/routers/enrich.py` |
| A8 | E2E stress test | ✅ One full pipeline hermetic test (`test_full_pipeline_with_claude`, 98% cov) + one with real Claude (`test_review_loop_hermetic`, gated). The full sync → quiz → grade → reschedule round-trip works in tests. | `backend/tests/test_e2e.py` |
| S6 | Mascot + UI polish | ⚠️ Mascot (banana duck) is **not in this repo** — out of scope, see "Out of scope" below. UI polish shipped: dark + marigold design system on dashboard + quiz pages. | `frontend/app/page.tsx`, `dashboard/page.tsx`, `quiz/[id]/page.tsx` |
| S7 | Sentry dashboard review | ⚠️ Code is instrumented; actual dashboard review is a manual task for the team. | — |

### Phase 4 — Sun AM: submission + demo prep
| Task | Description | Status |
|---|---|---|
| B1 | Devpost draft | Owner action (Aryan) |
| B2 | Demo video | Owner action (Samuel) — should show: PR merge → Bear-2 token delta breadcrumb → Claude concepts + roast → STT transcript → grade result → Poke calendar event |
| B3 | Devpost writeup | Owner action — sponsor-blurb draft is in `AGENTS/vibeschool_roadmap.md:296-307` |
| B4 | 4-min pitch prep | Owner action — structure in `AGENTS/vibeschool_roadmap.md:308-318` |

---

## Repo structure (ground truth)

```
ucb-ai-hackathon/
├── ROADMAP.md                   ← this file (consolidated build plan)
├── STATUS.md                    ← current verified state + fix list
├── RENAME.md                    ← historical rename notes (keep, do not modify)
├── start-local.sh               ← convenience: uvicorn + cloudflared tunnel
├── pytest.ini                   ← asyncio_mode=auto, testpaths=backend/tests
├── .gitignore                   ← covers .venv, __pycache__, **/.env, .coverage
├── backend/
│   ├── main.py                  ← FastAPI app, 5 routers, CORS (local + cloudflare regex)
│   ├── config.py                ← env loader, _require() for P0 keys
│   ├── sentry_init.py           ← SDK init (empty DSN = no-op)
│   ├── models.py                ← Pydantic: QuizConcept
│   ├── requirements.txt         ← 9 deps (PyGithub already removed)
│   ├── .env.example             ← template (incl. TokenRouter block, **uncommitted**)
│   ├── .env                     ← real values, gitignored
│   ├── routers/
│   │   ├── sync.py              ← POST /api/sync, GET /api/sync/status
│   │   ├── concepts.py          ← GET /api/concepts, GET /api/concepts/{concept_id}
│   │   ├── quiz.py              ← POST /api/transcribe (capped), POST /api/grade
│   │   ├── schedule.py          ← POST /api/schedule-review (calendar IDOR open)
│   │   └── enrich.py            ← POST /api/enrich (silent on failure)
│   ├── dependencies/auth.py     ← get_current_user — GitHub bearer + 60s in-proc cache
│   ├── services/
│   │   ├── redis_client.py      ← SM-2 + cache, key schema below
│   │   ├── token_store.py       ← Fernet-encrypted OAuth tokens (30-day TTL)
│   │   ├── sync.py              ← OAuth ingestion orchestrator
│   │   ├── github_oauth.py      ← per-user-token GitHub client (MAX_PAGES=50 cap)
│   │   ├── claude.py            ← AsyncAnthropic + TokenRouter switch (uncommitted)
│   │   ├── bear2.py             ← compress_diff (fallback to raw on failure)
│   │   ├── deepgram_stt.py      ← transcribe_audio (nova-2 REST)
│   │   ├── poke.py              ← schedule_review_block (43% cov)
│   │   ├── browserbase.py       ← enrich_concept (28% cov, silent-failure)
│   │   ├── diff_parser.py       ← clean_diff (fetch_and_parse_diff is dead code)
│   │   └── sm2.py               ← pure SM-2 (DEMO_MODE=True, no env toggle)
│   ├── scripts/check_redis.py   ← live-Redis smoke test (0% cov, standalone)
│   └── tests/                   ← 16 test files, 93 tests passing (1 xfailed, 1 flaky)
│
├── frontend/
│   ├── app/
│   │   ├── layout.tsx           ← root layout (Geist fonts)
│   │   ├── page.tsx             ← landing (148 lines, client component)
│   │   ├── providers.tsx        ← SessionProvider
│   │   ├── not-found.tsx        ← 404
│   │   ├── global-error.tsx     ← stock NextError {statusCode:0} — improve
│   │   ├── dashboard/page.tsx   ← live-wired; mock fallback when BACKEND_URL empty
│   │   ├── quiz/[id]/page.tsx   ← 6-state voice quiz; useRecorder hook
│   │   └── api/auth/[...nextauth]/route.ts  ← NextAuth GitHub provider
│   ├── lib/
│   │   ├── api.ts               ← apiFetch<T> + typed api.*; triggerSync/syncStatus dead
│   │   ├── useRecorder.ts       ← MediaRecorder hook with cleanup
│   │   ├── mock.ts              ← MOCK_PRS / MOCK_CONCEPTS (used as fallback)
│   │   └── types.ts
│   ├── types/next-auth.d.ts     ← accessToken module augmentation
│   ├── instrumentation*.ts      ← Sentry server + client
│   ├── sentry.{server,edge}.config.ts
│   ├── next.config.mjs          ← Sentry wrapper, no tunnelRoute (P2-2 fixed)
│   ├── tailwind.config.ts       ← dead globs for ./pages/** + ./components/**
│   ├── .env.local.example       ← template (hardcoded Sentry DSN, P2-F7 open)
│   ├── .env                     ← NOT tracked (gitignored; historical leak in 0fe1aae7)
│   └── .gitignore
│
├── AGENTS/
│   ├── vibeschool_agent_plan.md ← ORIGINAL detailed task plan (keep for history)
│   └── (audit/demo/redis/roadmap docs → consolidated into ROADMAP.md + STATUS.md)
│
└── .hermes/plans/               ← dated operational guides from past sessions
```

---

## Redis key schema (ground truth)

```
concept:{user_id}:{concept_id}:quiz        JSON  {concept, roast_text, question_text, answer_hint}
concept:{user_id}:{concept_id}:state       JSON  {ease_factor, interval, repetitions, next_review}
due:{user_id}                              ZSET  score = next_review unix timestamp
user:{user_id}:prs                         HASH  pr_number → {repo, merged_at}  (idempotency)
user:{user_id}:encrypted_token             str   Fernet ciphertext (30-day TTL)
user:{user_id}:last_sync                   str   Unix ts (last sync timestamp)
user:{user_id}:sync_inflight               str   "1" with 5-min TTL (per-user mutex)
user:{user_id}:repos                       SET   Repo full names the user has synced
```

- **`concept_id`** already includes `{user_id}` (see `backend/models.py`), so the full key has `user_id` twice. Both segments are load-bearing — the prefix scopes by user (multi-tenancy primitive); the suffix is the identifier. **Do not "fix" the duplication.**
- **TTL:** 7 days on every concept/due/prs/repos key. 30 days on encrypted token. Sync lock has 5-min TTL (auto-release if the caller dies mid-sync).
- **Ingestion lock:** `user:{user_id}:sync_inflight` prevents two simultaneous syncs from double-billing Claude. Idempotency is enforced by `user:{user_id}:prs` hash, so re-running a sync skips already-processed PRs locally before any network call.

---

## Demo checklist (live, on a developer's laptop)

```bash
# Terminal 1 — backend
cd /Users/aryanashta/Documents/GitHub/ucb-ai-hackathon
./.venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8000
# Confirm: curl http://localhost:8000/health → {"status":"ok"}

# Terminal 2 — frontend
cd frontend && bun dev
# Confirm: curl -I http://localhost:3000 → 200

# Optional Terminal 3 — expose backend to a second device (judge's phone)
./start-local.sh
# Set NEXT_PUBLIC_BACKEND_URL in frontend/.env.local to the printed tunnel URL, restart `bun dev`

# Sign in
open http://localhost:3000          # → click "Sign in with GitHub"
# → land on /dashboard with your real repos + merged PRs

# Sync
# → /dashboard auto-triggers /api/sync on mount; "Sync now" button is exposed
# → concepts appear as cards under each PR; due sidebar shows what's up for review

# Quiz
# → click 🎤 on any concept → /quiz/{concept_id}
# → see roast + question, press mic, speak, stop
# → transcript appears, grade result renders, next_review updates in Redis

# Calendar
# → after grading, click "Schedule review" (or auto-fire on grade) → Poke event appears
```

---

## Risk register

| Risk | Likelihood | Impact | Mitigation in code |
|---|---|---|---|
| Deepgram STT accuracy on ambient noise | Medium | Medium | Quiz UI shows the transcript and lets the user retry before grading (`quiz/[id]/page.tsx` ActionBar). |
| Poke API credentials missing in demo | Medium | High | `/api/schedule-review` returns 200 with an error envelope — the grade + SM-2 update still happens regardless. |
| `test_live_extraction` flakes | Low | Low | Documented as a known-flaky live test in `STATUS.md`. The hermetic `test_full_pipeline_with_claude` covers the same path with a mock. |
| CORS rejection during cloudflared demo | Low | Medium | `main.py:16` regex allows `https://*.trycloudflare.com`; set `NEXT_PUBLIC_BACKEND_URL` to the tunnel URL after `./start-local.sh`. |
| Redis Cloud quota exceeded mid-demo | Very low | High | `backend/scripts/check_redis.py` is a smoke check; keys carry 7-day TTLs so quota resets naturally. |
| Browserbase quota exceeded | Low | Low | `enrich_concept` returns `""` silently; the quiz flow still works without enrichment (it's P1, not on the demo critical path). |

---

## Out of scope (explicit)

- **Deepgram TTS** — the spec called for reading the roast + question aloud to the developer before they speak. Only STT is wired today; TTS is a post-hackathon addition. The cached quiz text is the same payload, so adding TTS later is a one-route addition (`POST /api/tts`).
- **Mascot animations** — banana duck is in the spec but not in this repo. Skip for the demo unless it's quick to add; it's not a sponsor criterion.
- **Mascot as Devpost hero image** — needs a separate render.
- **Production-grade rate limiting, abuse prevention, multi-worker uvicorn** — single-worker + single-event-loop deployment model (see `STATUS.md` P1-3 / P1-B2 / P1-B9 for the known scaling debt).
- **Frontend test suite** — zero tests on the frontend (P2-S4). The voice quiz flow is the highest-leverage thing to add a Vitest suite for, post-hackathon.
- **Cron-based background sync** — sync is user-triggered (`POST /api/sync`); no scheduled job. The OAuth polling path runs on demand.
- **Refresh-token rotation** — GitHub OAuth tokens are long-lived (handled by GitHub). Stale tokens just re-prompt re-auth on next request.
- **Postgres / vector DB** — Redis-only is appropriate for the demo. No migrations, no schema.
- **Multi-tenancy beyond `user_id` scoping in Redis key prefix** — single Redis Cloud database, one app, many users.

---

## Submission checklist (for the team)

- [ ] Devpost draft created before midnight Saturday (rule requirement)
- [ ] Both teammates confirmed on Devpost
- [ ] Demo video (≤ 3 min) — show the full PR → quiz → grade → calendar loop, with Sentry + Bear-2 breadcrumbs visible
- [ ] Devpost description — sponsor blurbs from `AGENTS/vibeschool_roadmap.md:296-307` (copy-paste)
- [ ] Screenshots: Sentry dashboard, Redis key readout, Bear-2 token delta, Poke calendar event, Deepgram transcript
- [ ] Submitted before 11 AM Sunday hard deadline
- [ ] Both team members physically present at judging table 1–3 PM

---

## Cross-references

- **STATUS.md** — verified state, fixed/open findings, verification commands. Read this if you want to know what actually works right now.
- **AGENTS/vibeschool_agent_plan.md** — original detailed task-by-task execution plan with code snippets (kept for history). Most tasks are now complete; the doc still has value as a reference for what each sponsor integration was supposed to do.
- **.hermes/plans/** — dated operational guides from past sessions (OAuth sync refactor, cloudflare tunnel setup, Redis audit follow-up, secrets scrub). All superseded by ROADMAP.md + STATUS.md but kept for traceability.
