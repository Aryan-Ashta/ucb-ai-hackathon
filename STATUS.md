# Repository Status

**Project:** VibeSchool (DiffLingo) — UC Berkeley AI Hackathon  
**Branch:** `HEAD` (all files untracked, not yet committed)  
**Last commit:** `7a9564e` — claude code plan

---

## What This Is

A spaced-repetition quiz platform for developers. When a GitHub PR merges, the backend:
1. Receives a webhook, verifies HMAC, parses the diff
2. Compresses the diff via Bear-2 (Token Company API)
3. Sends it to Claude → extracts CS concepts + generates roast text + quiz question
4. Caches everything in Redis with an SM-2 scheduler
5. Developer answers via voice (Deepgram STT), Claude grades the answer (0–5)
6. SM-2 state updated, next review block scheduled on calendar (Poke API)
7. Optional: Browserbase enriches concepts with MDN documentation snippets (P1)

---

## Stack

- **Python 3.14 / FastAPI / Uvicorn**
- **redis.asyncio 8.0** — async pool with TLS, health-checks, retry-on-timeout
- **Anthropic SDK** — `claude-sonnet-4-6` for extraction and grading
- **Deepgram** — nova-2 STT
- **Sentry SDK** — breadcrumbs on every external call
- **fakeredis** — in-memory Redis for tests (no server needed)
- **pytest-asyncio** — `asyncio_mode=auto`

---

## Directory Map

```
backend/
  main.py                  FastAPI app factory; mounts all routers
  config.py                Env var loading; _require() fails fast at import for P0 keys
  sentry_init.py           Sentry init; imported first by main.py
  models.py                Pydantic: QuizConcept, ConceptList
  requirements.txt         11 pip dependencies
  .env.example             Template for all env vars (copy → .env, never commit .env)
  routers/
    webhook.py             POST /api/webhook/github — HMAC verify + background ingestion
    concepts.py            GET  /api/concepts/{user_id} — list due concepts from Redis
    quiz.py                POST /api/transcribe (Deepgram) + /api/grade (Claude + SM-2)
    schedule.py            POST /api/schedule-review — Poke API calendar event
    enrich.py              POST /api/enrich — Browserbase MDN snippet (P1)
  services/
    diff_parser.py         fetch_and_parse_diff, clean_diff (extension filter + denoising)
    bear2.py               compress_diff via Token Company Bear-2; fallback = raw diff
    claude.py              extract_concepts_and_cache, grade_answer
    redis_client.py        get_redis(), cache_quiz_content, get_due_concepts, update_sm2_state
    sm2.py                 sm2_next() — SM-2 algorithm (DEMO_MODE=True → intervals in minutes)
    deepgram_stt.py        transcribe_audio() — nova-2 REST call
    poke.py                schedule_review_block() — Poke API event creation
    browserbase.py         enrich_concept() — Browserbase session + MDN parse (P1)
  scripts/
    check_redis.py         Smoke test: ping → set/get → TTL → cleanup (run to verify Cloud creds)
  tests/
    conftest.py            autouse fakeredis fixture (replaces _redis global before each test)
    test_sm2.py            Unit: SM-2 state transitions
    test_diff_parser.py    Unit: extension filter, lock file stripping, binary blob removal
    test_webhook.py        Unit: HMAC verify, non-merged PR ignored
    test_redis.py          Integration: 13 tests — cache, due list, SM-2, TTL, multi-user isolation
    test_bear2.py          Integration: fallback + live token reduction (live needs real API key)
    test_claude.py         Integration: fence stripping unit tests + live extraction (needs key)
    test_e2e.py            E2E: hermetic review loop + full pipeline with Claude (needs key)
    fixtures/              sample.diff, pr_payload.json
AGENTS/
  vibeschool_agent_plan.md  Task-by-task plan (A1–A8); agents should read this for intent
  vibeschool_roadmap.md     Hackathon roadmap and sponsor map
pytest.ini                  asyncio_mode=auto, verbose
```

---

## Redis Key Schema

```
concept:{user_id}:{concept_id}:quiz        JSON  {concept, roast_text, question_text, answer_hint}
concept:{user_id}:{concept_id}:state       JSON  {ease_factor, interval, repetitions, next_review}
concept:{user_id}:{concept_id}:enrichment  str   MDN snippet (optional, P1)
due:{user_id}                              ZSET  score = next_review unix timestamp
```

TTL on all keys: **7 days**.

---

## Environment Variables

### Required — app won't start without these
```
GITHUB_WEBHOOK_SECRET    HMAC key for webhook signature verification
ANTHROPIC_API_KEY        Claude API
TOKEN_COMPANY_API_KEY    Bear-2 compression
DEEPGRAM_API_KEY         STT
POKE_API_KEY             Calendar scheduling (Interaction Co)
```

### Redis — choose one pattern
```
# Pattern A: full URL (local or paste a rediss:// string)
REDIS_URL=rediss://default:<password>@<host>:<port>

# Pattern B: discrete fields (recommended for Redis Cloud; avoids special-char URL encoding bugs)
REDIS_HOST=redis-xxxxx.c1.us-east-1-2.ec2.redns.redis-cloud.com
REDIS_PORT=12345
REDIS_USERNAME=default
REDIS_PASSWORD=<user key from Redis Cloud console>
REDIS_TLS=true
```
REDIS_URL takes precedence if set. For a local server, set `REDIS_URL=redis://localhost:6379`.

### Optional
```
GITHUB_TOKEN             Raises GitHub API rate limit from 60 → 5000 req/hr
SENTRY_DSN               Empty string disables Sentry (safe default)
BROWSERBASE_API_KEY      P1 enrichment only
BROWSERBASE_PROJECT_ID   P1 enrichment only
```

---

## Running

```bash
# Install
python -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
cp backend/.env.example backend/.env  # then fill in real values

# Verify Redis Cloud
python -m backend.scripts.check_redis

# Start server
uvicorn backend.main:app --reload --port 8000

# Run tests (no Redis server needed — fakeredis handles it)
pytest backend/tests -v
```

---

## Test Status

| Suite | Tests | Status | Notes |
|---|---|---|---|
| `test_sm2` | 5 | ✓ always pass | Pure algorithm, no deps |
| `test_diff_parser` | ~6 | ✓ always pass | Pure logic |
| `test_webhook` | ~4 | ✓ always pass | TestClient + HMAC |
| `test_redis` | 13 | ✓ always pass | fakeredis, full coverage |
| `test_bear2` | ~4 | ✓ / ⚠ | Live test skipped without TOKEN_COMPANY_API_KEY |
| `test_claude` | ~5 | ✓ / ⚠ | Live test skipped without ANTHROPIC_API_KEY |
| `test_e2e` | ~3 | ✓ / ⚠ | Hermetic loop always runs; full pipeline needs keys |

---

## Known Issues & Placeholders

| Location | Issue |
|---|---|
| `bear2.py:6` | `BEAR2_URL` is a placeholder — confirm exact URL from Token Company docs |
| `poke.py:8` | `POKE_API_BASE` is a placeholder — confirm from Interaction Co workshop |
| `browserbase.py:9` | `BROWSERBASE_API_BASE` needs verification from Browserbase docs |
| `sm2.py:6` | `DEMO_MODE = True` — intervals are in minutes; **must be False for production** |
| All routers | No auth — any `user_id` string is accepted; no GitHub OAuth |
| All routers | No rate limiting |
| `enrich.py` | Browserbase sessions not explicitly closed (auto-cleanup only) |

---

---

## Frontend

**Stack:** Next.js 14 (App Router) · React 18 · TypeScript · Tailwind CSS · NextAuth v4 · Sentry

### Directory Map

```
frontend/
  app/
    page.tsx                    Landing/marketing page — hero, "how it works", GitHub sign-in
    layout.tsx                  Root layout — Geist fonts, metadata, wraps with Providers
    globals.css                 Tailwind directives + CSS vars for light/dark mode
    global-error.tsx            Global React error boundary → Sentry
    providers.tsx               NextAuth SessionProvider
    dashboard/page.tsx          Main app page — PR list, concept cards, due queue (see below)
    api/auth/[...nextauth]/
      route.ts                  NextAuth catch-all: GitHub OAuth, stores accessToken in JWT
  types/
    next-auth.d.ts              Extends Session/JWT types to include accessToken
  instrumentation.ts            Sentry init dispatcher (Node vs Edge runtime)
  instrumentation-client.ts     Browser Sentry init with Session Replay
  sentry.server.config.ts       Server-side Sentry (tracing, local vars)
  sentry.edge.config.ts         Edge runtime Sentry
  next.config.mjs               Next.js config wrapped with withSentryConfig
  package.json                  deps: next, react, next-auth, @sentry/nextjs
  bun.lock                      Bun lockfile
  .env.local.example            Env var template
```

### Pages

**`/` (Landing)** — Marketing page. Guest sees GitHub sign-in button; authed user sees "Go to dashboard" + sign-out. Explains the product in three steps. Shows tech stack badges. Footer credits UCB AI Hackathon 2026.

**`/dashboard`** — Protected (redirects to `/` if unauthenticated). Sticky header with avatar. Two-column desktop layout:
- Left: PRs with merged date, each expanded into Concept Cards (name, roast snippet, mastery % bar, rep count, "Quiz me" button, due-status color-coding)
- Right (lg+ only): sticky "Due today" queue with time-relative labels ("30m overdue", "in 2h")
- **Currently uses hardcoded `MOCK_PRS` data — backend API not connected yet**

### Auth

GitHub OAuth via NextAuth. Scopes: `read:user user:email repo`. The GitHub access token is stored in the JWT and forwarded to the session as `session.accessToken`.

### Environment Variables

```
GITHUB_CLIENT_ID        GitHub OAuth app client ID
GITHUB_CLIENT_SECRET    GitHub OAuth app secret
NEXTAUTH_SECRET         Session encryption key (any random string)
NEXTAUTH_URL            OAuth callback base URL (default: http://localhost:3000)

NEXT_PUBLIC_SENTRY_DSN  Client-side Sentry DSN (safe to expose)
SENTRY_DSN              Server-side Sentry DSN
SENTRY_AUTH_TOKEN       Source map upload token (build only)
```

### How to Run

```bash
cd frontend
cp .env.local.example .env.local   # fill in GitHub OAuth + NEXTAUTH_SECRET
bun install                         # or npm install
bun dev                             # http://localhost:3000
```

### Frontend TODOs / Stubs

| Gap | Location |
|---|---|
| Dashboard uses mock data | `dashboard/page.tsx` — replace `MOCK_PRS` with `/api/concepts/{user_id}` fetch |
| Quiz page not implemented | Dashboard links to `/quiz/{id}` but no route exists |
| Voice input not wired | Deepgram env var present but no MediaRecorder UI |
| No backend API routes | No `/api/concepts`, `/api/grade`, `/api/schedule-review` proxy routes |
| PR sync not triggered | Auth scope includes `repo` but no webhook setup flow in UI |

---

## Implementation Completeness

| Task | Description | Status |
|---|---|---|
| A1 | Webhook + diff parser | ✓ Complete |
| A2 | Bear-2 compression | ✓ Complete (URL pending confirmation) |
| A3 | Claude concept extraction + caching | ✓ Complete |
| A4 | SM-2 + Redis scheduler | ✓ Complete |
| A5 | Deepgram STT + Claude grader | ✓ Complete |
| A6 | Poke calendar integration | ✓ Complete (URL pending confirmation) |
| A7 | Browserbase enrichment (P1) | ✓ Complete (URL pending confirmation) |
| A8 | Frontend landing + dashboard UI | ✓ Complete (mock data; backend not connected) |
| — | Frontend ↔ backend integration | ✗ Not started — dashboard still uses hardcoded data |

---

## Git State

All implementation files are **untracked** — nothing has been committed except the two planning docs in `AGENTS/`. Before doing any work, run `git status` to confirm the current state.

Files intentionally excluded from git: `backend/.env`, `.venv/`, `__pycache__/`, `.pytest_cache/`.
