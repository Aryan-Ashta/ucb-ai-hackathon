# VibeSchool — Repository Audit & Issue Tracker

> **Snapshot date:** 2026-06-20
> **Scope:** `backend/` (FastAPI + Redis) and `frontend/` (Next.js 14 App Router)
> **Branch state:** `main` clean, on `origin/main`. Three historical branches in
> remotes: `fullstack-S` (frontend scaffold), `backend-A!` (backend plan),
> `main` (merged head). 7 commits, working tree clean.
>
> **Verification baseline (before any fixes in this doc):**
> - `pytest` from repo root → `ModuleNotFoundError: No module named 'backend'`
>   (conftest cannot import `backend.services.redis_client`)
> - `cd frontend && bun install && bun run build` → succeeds, 4 routes
> - `cd frontend && npx tsc --noEmit` → clean
> - `cd frontend && npx eslint app types` → clean
> - Live API calls (Anthropic, Deepgram, Token Company) reachable with the
>   keys in `backend/.env`. Redis Cloud reachable; fakeredis works in tests.

---

## Reading guide

Issues are grouped by **severity**, not by file. Each issue has:

- **Where** — exact file + line(s)
- **What** — the broken or risky behavior, in one sentence
- **Why it matters** — user-visible impact, in one sentence
- **Fix** — concrete edit (often copy-pasteable)
- **Verify** — the single command that proves the fix worked

Recommended execution order is the same as the numbering: fix P0-1 first
(it unblocks `pytest` entirely), then P0-2, then everything else.

---

## P0 — Real bugs (silent at runtime, will break the demo or the pipeline)

### P0-1. Missing `backend/tests/__init__.py` — pytest cannot collect the suite

- **Where:** `backend/tests/` (file does not exist)
- **What:** The test directory has no `__init__.py`, so `pytest` cannot resolve
  `backend.tests.conftest` and dies before running a single test. The
  other three backend subpackages (`routers/`, `services/`, `scripts/`) all
  have empty `__init__.py` files; this one is the lone outlier.
- **Why it matters:** Running the documented verification command
  `pytest` produces zero test output and a traceback. Anyone landing in the
  repo will assume the tests are broken.
- **Fix:**
  ```bash
  touch backend/tests/__init__.py
  ```
  (Empty file is correct; `conftest.py` does the heavy lifting.)
- **Verify:**
  ```bash
  pytest
  # expected: 30 passed, 1 failed (the bear2 live test, see P0-2)
  ```

### P0-2. Bear-2 client sends the wrong request body and reads the wrong response key

- **Where:** `backend/services/bear2.py:24-37`
- **What:** The current code POSTs `{"text": ..., "mode": "accuracy"}` and
  reads `response.json()["compressed_text"]`. The real Token Company API
  at `https://api.thetokencompany.com/v1/compress` requires
  `{"model": "bear-2", "input": "..."}` and returns
  `{"output": "...", "output_tokens": N, "original_input_tokens": N, "compression_time": ...}`.
  Confirmed live: the wrong body returns **HTTP 422**, which the `except Exception`
  branch in `compress_diff` swallows and returns the **raw** diff. Net effect:
  Bear-2 is silently disabled on every PR and the full Claude input-token
  cost is paid.
- **Why it matters:** The whole reason Bear-2 exists is to reduce the
  per-PR Claude bill. Right now it's burning money doing nothing.
  The live `test_live_compression` test is also failing because of this
  (asserts `compressed_tokens < raw_tokens` but the fallback returns the
  raw diff verbatim).
- **Fix:** replace lines 24-37 of `backend/services/bear2.py` with:
  ```python
  response = await client.post(
      BEAR2_URL,
      headers={
          "Authorization": f"Bearer {TOKEN_COMPANY_API_KEY}",
          "Content-Type": "application/json",
      },
      json={
          "model": "bear-2",
          "input": raw_diff,
      },
      timeout=10.0,
  )
  response.raise_for_status()
  data = response.json()
  compressed = data["output"]
  raw_tokens = data.get("original_input_tokens") or raw_tokens
  compressed_tokens = data.get("output_tokens") or compressed_tokens
  ```
  Also drop the now-redundant `count_tokens_approx` heuristic from the
  success path (use the API's own BPE counts). Keep it for the no-key
  fallback test only.
- **Verify:**
  ```bash
  pytest backend/tests/test_bear2.py -v
  # expected: test_live_compression PASSES (asserts token reduction)
  #           test_fallback_returns_raw_on_failure still passes
  ```
  And a smoke test from Python:
  ```python
  import asyncio
  from backend.services.bear2 import compress_diff
  print(len(asyncio.run(compress_diff("def f(x):\n    return x*x\n" * 20))))
  # expected: a number strictly less than the input length
  ```

### P0-3. Dashboard "🎤 Quiz me" buttons link to a route that does not exist

- **Where:** `frontend/app/dashboard/page.tsx:183` and `:240`
- **What:** Both the sidebar "DueQueueItem" and the "ConceptCard" render
  `<a href={`/quiz/${concept.id}`}>`. The Next.js build only emits routes
  for `/` and `/dashboard`; there is no `app/quiz/[id]/page.tsx` (and no
  `pages/quiz/[id].tsx`). Clicking the link 404s. STATUS.md correctly notes
  "A8: Frontend / voice UI — Not in this repo", but the dashboard ships
  with the broken links anyway, so the demo will 404 on its first click.
- **Why it matters:** Judges clicking "Quiz me" on a stale-looking PR
  will see a 404. The voice quiz page is the headline demo moment.
- **Fix (option A — stub the route, fastest):** create
  `frontend/app/quiz/[id]/page.tsx` with a placeholder that says
  "Voice quiz coming soon — your concept: {id}" and a back link. 30 lines.
- **Fix (option B — replace the demo data with a no-op button):** change
  the two `<a>` tags to `<button disabled>` with the existing
  `pointer-events-none opacity-50` classes. 5 minutes, ships no broken UX.
- **Verify:**
  ```bash
  cd frontend && bun run build
  # expected: route list now includes ƒ /quiz/[id] (option A) or no change
  # but dashboard links are no longer <a href> (option B)
  ```

---

## P1 — Deprecations & fragile bits

### P1-1. `sentry_sdk.start_span(..., description=...)` is deprecated across 5 sites

- **Where:**
  - `backend/services/claude.py:58`
  - `backend/routers/quiz.py:20`
  - `backend/routers/quiz.py:44`
  - `backend/routers/schedule.py:24`
  - `backend/routers/enrich.py:19`
- **What:** Sentry SDK 2.x prints `DeprecationWarning: The 'description' parameter
  is deprecated. Please use 'name' instead.` on every span. 5 warnings appear
  in the test output today; the Sentry dashboard will still capture the
  spans but the labels will eventually disappear from the trace UI.
- **Why it matters:** It's a deprecation today, a removal in the next major
  Sentry release. Cheap to fix while we have the codebase open.
- **Fix:** a one-line edit per call site — change `description=` to `name=`.
  Example for `claude.py:58`:
  ```python
  with sentry_sdk.start_span(op="claude.extract", name="Concept extraction"):
  ```
  Repeat for the other four sites with their respective `name=` strings.
- **Verify:**
  ```bash
  pytest 2>&1 | grep -i deprecat
  # expected: zero hits from sentry_sdk
  ```

### P1-2. `starlette.testclient` warns about `httpx` being deprecated

- **Where:** `backend/tests/test_webhook.py:13` (via `from fastapi.testclient import TestClient`)
- **What:** FastAPI 0.138 ships a warning:
  `Using 'httpx' with 'starlette.testclient' is deprecated; install 'httpx2' instead.`
- **Why it matters:** Cosmetic. The TestClient still works. The deprecation
  will turn into a runtime error in a future FastAPI release.
- **Fix:** when `httpx2` is available, change
  `from fastapi.testclient import TestClient` →
  `from fastapi.testclient import TestClient  # auto-picks httpx2 if installed`
  in a follow-up. Today: nothing to change in the repo, just bump deps.
- **Verify:** `pip show httpx2` (when it ships); re-run `pytest`; warning gone.

### P1-3. `_redis` global in `redis_client.py` is a process-wide mutable singleton

- **Where:** `backend/services/redis_client.py:19, 38-56`
- **What:** `get_redis()` lazily initializes a module-level `_redis` on first
  call and reuses it. There's no per-loop guard, no thread lock. Fine for
  one uvicorn worker; will explode under multiple workers (each worker
  caches its own connection) or under `pytest-asyncio` if a fixture leaks.
- **Why it matters:** Today the fakeredis conftest sets `redis_client._redis`
  directly, which works because of the lazy init. But the moment we add a
  second test that touches the real client, or run uvicorn with `--workers 2`,
  the invariant breaks silently.
- **Fix:** either (a) add a `WeakKeyDictionary` keyed on
  `asyncio.get_running_loop()` to cache one client per loop, or
  (b) keep it simple and add a `# SINGLETON: safe only because we run one
  event loop per process; revisit before scaling workers` comment. Option
  (b) is enough for the hackathon.
- **Verify:** (b) is a comment — no command. (a) would need a small
  concurrent test that exercises two loops.

### P1-4. No auth on the backend routers — any `user_id` is accepted

- **Where:** every router under `backend/routers/` accepts `user_id` as a
  path or body parameter with zero validation.
- **What:** `GET /api/concepts/{user_id}`, `POST /api/grade`,
  `POST /api/schedule-review`, and `POST /api/enrich` all trust the caller
  to supply their own `user_id`. The frontend's NextAuth callback exposes
  the GitHub `id` as the user identifier, so the demo happens to line up,
  but a hostile caller can read/write any other user's data.
- **Why it matters:** This is a public-facing app after the demo. The
  STATUS.md rightly flags it; we should at least require the
  `accessToken` from the NextAuth session to match the `user_id` before
  scoring the request.
- **Fix (minimal):** add a FastAPI dependency `get_current_user_id` that
  extracts the GitHub `id` from a bearer token, and apply it to the four
  endpoints. The frontend already stores `session.accessToken` (see
  `frontend/app/api/auth/[...nextauth]/route.ts:13-22`); have it send the
  token in the `Authorization: Bearer` header on every fetch.
- **Verify:** a curl with a different `user_id` in the body should now
  return 401/403.

### P1-5. Browserbase sessions are never explicitly closed

- **Where:** `backend/services/browserbase.py:27-67`
- **What:** `enrich_concept` creates a session with
  `POST /sessions`, fetches a page with `POST /sessions/{id}/fetch`, then
  returns. It never calls the session-stop endpoint, relying on
  Browserbase's auto-cleanup. The whole flow is also wrapped in a single
  `try/except Exception` that swallows everything.
- **Why it matters:** Sessions are billable. Leaks during a demo compound
  silently. The bare `except` makes every enrichment failure look like
  the same thing in Sentry, which hurts debugging.
- **Fix:** split the body into two `try` blocks (session create vs.
  fetch+parse), call `client.post(f"{BASE}/sessions/{id}/stop")` in a
  `finally`, and log specific exception types.
- **Verify:** `pytest backend/tests -v` (no enrichment tests today —
  consider adding one with `httpx.MockTransport`).

---

## P2 — Cleanup, alignment, docs drift

### P2-1. `STATUS.md` is stale — says "all files untracked" but 7 commits exist

- **Where:** `STATUS.md:4, 192`
- **What:** The header reads "Branch: HEAD (all files untracked, not yet
  committed)" and the Git State section says "All implementation files
  are untracked — nothing has been committed except the two planning docs."
  Both are wrong: `git log --oneline -20` shows 7 commits including the
  full backend (`13c9eb2`, `347ea10`) and the frontend scaffold
  (`ec4a915`, `eabfc4a`). `git status` is clean.
- **Why it matters:** New contributors will be misled about repo state.
- **Fix:** either delete `STATUS.md` (the agent plan in
  `AGENTS/vibeschool_agent_plan.md` already covers A1–A8) or rewrite it
  to reflect the current state. Cheapest: delete, or keep only the
  "Known Issues & Placeholders" table.
- **Verify:** `git log --oneline -5` matches the description in the doc.

### P2-2. `RENAME.md` is full of unfinished placeholders

- **Where:** `RENAME.md` (entire file, 20 lines)
- **What:** Action items still pending:
  - Sentry `org`/`project` = `ucb-ai-hackathon` (in `frontend/next.config.mjs:7-8`)
  - GitHub App name and repo name
  - NextAuth callback URL on production
  - `NEXTAUTH_URL` env in deployment
- **Why it matters:** Demo can ship without these (Sentry works with a
  throwaway org, NextAuth defaults to the configured callback URL), but
  going public with placeholder org slugs in a public repo looks rough.
- **Fix:** tick off what's done, delete the file once the rest is settled.
  If the team isn't ready to ship publicly, the file should be in
  `AGENTS/` rather than at repo root.

### P2-3. Real Sentry DSN committed in `frontend/.env.local.example`

- **Where:** `frontend/.env.local.example:9-10`
- **What:** The template ships the actual public DSN
  `https://f973e82b5576ef46627d46944e4aab25@o4511596175097856.ingest.us.sentry.io/4511599391801344`.
  Public-source DSNs are not catastrophic (they're meant to be embedded
  in the client bundle), but a template should not be tied to one project.
- **Why it matters:** Anyone who copies the file gets the project's events.
  Rotating the DSN later requires editing the example file too.
- **Fix:** replace both lines with
  `NEXT_PUBLIC_SENTRY_DSN=` and `SENTRY_DSN=` (empty), and add a
  comment pointing to the project's Sentry settings page.
- **Verify:** `grep -c 'ingest.us.sentry.io' frontend/.env.local.example`
  returns `0`.

### P2-4. `DEMO_MODE = True` in `sm2.py` — fine for hackathon, dangerous for prod

- **Where:** `backend/services/sm2.py:6`
- **What:** `DEMO_MODE = True` makes SM-2 schedule in minutes instead of
  days, so the spaced-repetition loop is observable during the demo.
- **Why it matters:** If the deploy accidentally runs with
  `DEMO_MODE = True`, every user gets a "review in 60 s" notification and
  the calendar fills with thousands of events. There is no env override.
- **Fix:** read from env with a default of `True` for the hackathon:
  ```python
  import os
  DEMO_MODE = os.environ.get("VIBESCHOOL_DEMO_MODE", "true").lower() in ("1", "true", "yes")
  ```
  And add a startup `warnings.warn(...)` if `DEMO_MODE` is on in a
  non-`development` environment.
- **Verify:** set `VIBESCHOOL_DEMO_MODE=false` in `.env`, restart, observe
  next_review deltas in the 1-day range instead of 1-minute.

### P2-5. Unused dependency: `PyGithub` is in `requirements.txt` but imported nowhere

- **Where:** `backend/requirements.txt:8`
- **What:** `grep -r "import github" backend/` returns nothing. The webhook
  fetches diffs via raw `httpx` (see `backend/services/diff_parser.py:24-32`).
  `PyGithub` is dead weight.
- **Why it matters:** Adds install time and a supply-chain surface for
  no reason.
- **Fix:** remove line 8 from `requirements.txt`. Reinstall with
  `pip uninstall PyGithub`.
- **Verify:** `pip show PyGithub` after `pip install -r backend/requirements.txt`
  returns "Package not found".

### P2-6. `POKE_API_BASE` and `BROWSERBASE_API_BASE` URLs unconfirmed

- **Where:** `backend/services/poke.py:8`, `backend/services/browserbase.py:9`
- **What:** Both have `# confirm from docs` comments. Only matters for the
  live `/api/schedule-review` and `/api/enrich` paths, which are not
  exercised by the test suite.
- **Why it matters:** If the URL is wrong, the demo of "schedule a review
  on the user's calendar" silently fails and only surfaces as a 500 in
  the Sentry breadcrumb.
- **Fix:** verify with the workshop's API docs at the event. Update the
  constants. Add a one-line `httpx.get(f"{BASE}/health", timeout=3)` smoke
  test that the URLs return anything other than connection-refused.
- **Verify:** call the smoke test from `backend/scripts/check_redis.py` and
  add a sibling `check_poke.py` and `check_browserbase.py`.

---

## Suggested fix order

```
P0-1  touch backend/tests/__init__.py              # 5 seconds, unblocks pytest
P0-2  fix bear2.py request/response contract       # 5 lines, real $$ saved
P0-3  stub /quiz/[id] OR replace <a> with <button> # 30 lines
P1-1  description= → name= in 5 sentry calls      # 5 one-liners
P1-2  bump deps when httpx2 ships                 # no code change today
P1-3  add a # SINGLETON comment in redis_client   # 1 line
P1-4  add auth dependency + Bearer header from FE  # ~50 lines
P1-5  explicit Browserbase session stop           # ~15 lines
P2-1  delete or rewrite STATUS.md                 # docs
P2-2  tick off RENAME.md placeholders             # docs
P2-3  scrub the real DSN from .env.local.example  # docs
P2-4  env-driven DEMO_MODE + warn() at startup    # ~5 lines
P2-5  drop PyGithub from requirements.txt         # 1 line
P2-6  verify Poke + Browserbase URLs live         # needs workshop access
```

Total backend code change if all P0+P1 are applied: ~120 lines plus the
new `app/quiz/[id]/page.tsx` stub. Nothing in the data model changes.

---

## Things that are NOT broken (verified during the audit)

- `backend/services/redis_client.py` — fakeredis conftest works, all 13
  integration tests pass, TTL assertions hold.
- `backend/services/sm2.py` — pure algorithm, 5 unit tests pass.
- `backend/routers/webhook.py` — HMAC verify + merged-PR detection
  work; 3 webhook tests pass.
- `backend/services/diff_parser.py` — extension filter, lock-file strip,
  binary-blob removal, whitespace-hunk skip all confirmed.
- `backend/services/claude.py` — `extract_concepts_and_cache` and
  `grade_answer` both live-tested with real key; concepts produced.
- `frontend/app/page.tsx`, `frontend/app/dashboard/page.tsx` — render
  cleanly, TypeScript clean, ESLint clean, build succeeds.
- `frontend/app/api/auth/[...nextauth]/route.ts` — NextAuth + GitHub
  provider wired up correctly with `read:user user:email repo` scope.
- `frontend/instrumentation*.ts` and `sentry.*.config.ts` — Sentry
  initialised on all three runtimes (client / server / edge).
- `package.json` — every dep is used; `bun install` succeeds; lockfile
  is consistent.
- `pytest.ini` — `asyncio_mode=auto`, `testpaths=backend/tests` correct.
- `.gitignore` — covers `.venv`, `__pycache__`, `backend/.env`,
  `.pytest_cache`, and the frontend's standard set.
