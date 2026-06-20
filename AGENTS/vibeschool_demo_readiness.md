# VibeSchool — Demo Readiness Plan

> **For Hermes:** Execute in numbered order. P0 tasks block P1 tasks; P1 blocks P2; deployment tasks depend on P0 being complete. Every task has a one-line verify command that proves it worked.
>
> **Goal:** Take VibeSchool from "code-complete but disconnected" to "live demo working end-to-end on Vercel + Render" in roughly 2 hours of focused work.

---

## Current state (verified 2026-06-20)

**Working:**
- Backend ingests PRs via OAuth sync path (`backend/services/sync.py`)
- All five routers mounted (`backend/main.py:7-11`)
- `extract_concepts_and_cache` → Redis → SM-2 → grade → reschedule loop is complete
- Frontend renders landing page and dashboard with hard-coded mock data
- NextAuth GitHub OAuth returns an `accessToken` in the session

**Broken or missing:**
- `backend/main.py:7` still mounts `webhook.router`, but `config.py:22` removed `GITHUB_WEBHOOK_SECRET` → **first import raises `ImportError`**
- No `CORSMiddleware` in `main.py` → any cross-origin browser fetch fails
- Dashboard renders `MOCK_PRS` (`frontend/app/dashboard/page.tsx:37`) instead of fetching from the backend
- No `app/quiz/[id]/page.tsx` route — 🎤 button 404s
- `next.config.mjs:13` sets `tunnelRoute: "/monitoring"` with no backing route
- Three Sentry config files hard-code a live DSN as fallback

**Reference:** `STATUS.md`, `.hermes/plans/2026-06-20_131518-oauth-sync-refactor.md`, `.hermes/plans/2026-06-20_142814-host-backend-locally-cloudflare.md`.

---

## Execution order

```
P0-1  Fix backend startup crash            (5 min)
P0-2  Add CORS middleware                  (5 min)
P0-3  Wire dashboard to /api/concepts      (30 min)
── gate: dashboard renders live data ──
P1-1  Build /quiz/[id] page                (75 min)
P1-2  Audio upload path decision           (15 min)
── gate: full voice quiz loop works locally ──
P2-1  Remove hard-coded Sentry DSN fallbacks  (5 min)
P2-2  Fix tunnelRoute: "/monitoring"       (3 min)
P2-3  Run full pytest suite                (5 min)
── gate: zero deprecation warnings, all tests green ──
D-1   Deploy backend to Render Starter     (15 min)
D-2   Deploy frontend to Vercel            (15 min)
D-3   Wire end-to-end demo                 (10 min)
── gate: live URL serves a real quiz ──
```

Total estimate: **~3 hours** end-to-end, including deploy wait time.

---

## P0 — Block the demo from working

### P0-1. Fix the webhook/config import crash

- **Where:** `backend/routers/webhook.py:7` imports `GITHUB_WEBHOOK_SECRET` from `backend.config`, but `backend/config.py:22` removed that variable during the OAuth refactor. `backend/main.py:7` still mounts `webhook.router`.
- **Why it matters:** First `uvicorn backend.main:app` raises `ImportError: cannot import name 'GITHUB_WEBHOOK_SECRET'`. Nothing runs.
- **Decision:** delete the webhook router entirely. Webhooks are not used; ingestion happens on user-driven sync.
- **Files:**
  - Delete: `backend/routers/webhook.py`
  - Modify: `backend/main.py` — remove the `webhook` import and `app.include_router(webhook.router, …)` line
  - Delete: `backend/tests/test_webhook.py` (now dead code)
- **Verify:**
  ```bash
  cd backend && .venv/bin/python -c "from backend.main import app; print(len(app.routes))"
  # expected: prints a number ≥ 10, no ImportError
  ```

### P0-2. Add `CORSMiddleware` to the FastAPI app

- **Where:** `backend/main.py` (after the `app = FastAPI(...)` line, before any `include_router` calls).
- **Why it matters:** Vercel-hosted frontend → your backend is cross-origin. Browser will block every fetch without `Access-Control-Allow-Origin`.
- **Files:** `backend/main.py`
- **Patch:** add directly after `app = FastAPI(title="VibeSchool Backend")`:
  ```python
  from fastapi.middleware.cors import CORSMiddleware

  # During local tunnel development the origin rotates per session, so
  # allow any localhost/vercel.app host plus a wildcard for ad-hoc tests.
  # Tighten to specific origins once a real domain is wired.
  app.add_middleware(
      CORSMiddleware,
      allow_origins=[
          "https://vibeschool.vercel.app",
          "https://*.vercel.app",
          "http://localhost:3000",
      ],
      allow_credentials=True,
      allow_methods=["*"],
      allow_headers=["*"],
  )
  ```
- **Verify:**
  ```bash
  .venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8000 &
  sleep 2
  curl -s -H "Origin: https://vibeschool.vercel.app" \
    -D - http://localhost:8000/health | grep -i access-control-allow-origin
  # expected: access-control-allow-origin: https://vibeschool.vercel.app
  ```

### P0-3. Wire the dashboard to `/api/concepts/{user_id}`

- **Where:** `frontend/app/dashboard/page.tsx:37-130` defines `MOCK_PRS`; the rest of the file reads from it.
- **Why it matters:** Without this, the deployed frontend is a marketing site. The actual feature never runs.
- **Files:**
  - Modify: `frontend/app/dashboard/page.tsx`
  - Create: `frontend/lib/api.ts` (small helper for backend fetches)
- **Plan:**
  1. Create `frontend/lib/api.ts`:
     ```ts
     export const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "";

     export async function apiFetch<T>(
       path: string,
       init?: RequestInit,
     ): Promise<T> {
       if (!BACKEND_URL) throw new Error("NEXT_PUBLIC_BACKEND_URL is not set");
       const res = await fetch(`${BACKEND_URL}${path}`, {
         ...init,
         headers: {
           "Content-Type": "application/json",
           ...(init?.headers ?? {}),
         },
       });
       if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
       return res.json() as Promise<T>;
     }
     ```
  2. In `dashboard/page.tsx`:
     - Remove the `MOCK_PRS` constant (lines 32–130).
     - Add a `useEffect` that calls `apiFetch<{ due: DueConcept[]; count: number }>(`/api/concepts/${userId}`)` on mount.
     - Define a `DueConcept` type that matches the backend response (note: `state` is nested inside each due item per `redis_client.py:118`).
     - Render loading state, error state, and empty state separately from the populated state.
  3. Map the API response into the existing `PRSection` / `ConceptCard` components. Two options:
     - **Easier (recommended for first pass):** flat-list all due concepts in a single section, ignore PR grouping. ~30 lines of changes.
     - **Closer to current design:** group concepts by PR — requires the backend to return PR metadata, which it doesn't today. Skip for now; flat list is fine for the demo.
- **Verify (locally, before deploy):**
  ```bash
  cd frontend && bun run dev
  # in another terminal, hit the backend's due endpoint with a known user_id
  curl http://localhost:8000/api/concepts/<github_id_with_data>
  # open http://localhost:3000/dashboard
  # expected: page renders concepts from the API (or empty state if no data)
  ```

---

## P1 — Needed for the full voice-quiz demo

### P1-1. Build `/quiz/[id]` page

- **Where:** `frontend/app/quiz/[id]/page.tsx` (does not exist yet).
- **Why it matters:** The 🎤 button on every dashboard card links here. Today it's a 404. This is the headline demo moment.
- **Files:**
  - Create: `frontend/app/quiz/[id]/page.tsx`
  - Modify: `frontend/lib/api.ts` (add typed quiz helpers)
- **Plan (single-file client component):**
  1. On mount: parse `id` from `params`, fetch quiz content. Since `/api/concepts/{user_id}` returns the full payload but the route only knows the concept_id (not user_id), take user_id from `useSession()` and look up the concept inside the `due` list client-side. Alternative: add `GET /api/concepts/{user_id}/{concept_id}` to the backend (cleaner; ~10 lines in `routers/concepts.py`).
  2. Render three stages sequentially:
     - **Idle**: show the roast + question + 🎤 button
     - **Recording**: red pulsing mic, stop button, MediaRecorder → blob
     - **Grading**: spinner while `POST /api/transcribe` + `POST /api/grade` complete
     - **Result**: passed/failed, quality 0-5, explanation, "Schedule review" button
  3. State machine with a small `useState<"idle"|"recording"|"grading"|"done"|"error">` enum.
- **MediaRecorder snippet:**
  ```tsx
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: "audio/webm" });
    const fd = new FormData();
    fd.append("audio", blob, "answer.webm");
    const res = await fetch(`${BACKEND_URL}/api/transcribe`, { method: "POST", body: fd });
    const { transcript } = await res.json();
    // ... then POST /api/grade
  };
  recorder.start();
  ```
- **Verify:**
  ```bash
  cd frontend && bun run dev
  # navigate to /quiz/<some-concept-id>, click mic, speak, click stop
  # expected: transcript appears, grade result renders, SM-2 next_review advances
  ```

### P1-2. Confirm audio goes directly to the backend (not through Vercel)

- **Where:** the `fetch` URL inside the MediaRecorder snippet from P1-1.
- **Why it matters:** Vercel Serverless Functions cap request bodies at 4.5 MB. Audio/webm blobs hit this fast. Going direct to the backend bypasses the cap entirely.
- **Files:** `frontend/app/quiz/[id]/page.tsx`
- **Action:** the snippet above already uses `${BACKEND_URL}/api/transcribe` directly. No proxy through `/api/transcribe` on the frontend. **Document this decision with a one-line comment** so future agents don't "fix" it.
- **Verify:** record a 30-second clip and confirm the backend logs the request at `/api/transcribe` with the full body size (not a 413 from Vercel).

---

## P2 — Polish

### P2-1. Remove hard-coded Sentry DSN fallbacks

- **Where:**
  - `frontend/instrumentation-client.ts:4`
  - `frontend/sentry.server.config.ts:4`
  - `frontend/sentry.edge.config.ts:4`
- **Why it matters:** All three have `?? "https://..."` fallbacks that ship a live DSN into the bundle. Fail loud instead.
- **Patch (apply to all three):**
  ```ts
  const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn && process.env.NODE_ENV === "production") {
    throw new Error("Sentry DSN is not set in production");
  }
  // ...
  dsn,
  ```
- **Verify:**
  ```bash
  cd frontend && bun run build
  # expected: builds without "Sentry DSN is not set" error when env var is set
  ```

### P2-2. Fix `tunnelRoute: "/monitoring"` (or implement it)

- **Where:** `frontend/next.config.mjs:13`
- **Why it matters:** The Sentry config references a tunnel route that doesn't exist. Every client event 404s in production, silently dropping telemetry.
- **Decision:** **delete** the option. The tunnel is an ad-blocker workaround; not worth the complexity for a hackathon.
- **Patch:**
  ```js
  export default withSentryConfig(nextConfig, {
    org: "ucb-ai-hackathon",
    project: "ucb-ai-hackathon",
    authToken: process.env.SENTRY_AUTH_TOKEN,
    widenClientFileUpload: true,
    silent: !process.env.CI,
    // tunnelRoute removed — no backing route; clients ship events directly
  });
  ```
- **Verify:** `bun run build` succeeds; no `/monitoring` route is registered.

### P2-3. Run the full pytest suite

- **Why it matters:** Confirms the P0 changes (especially the webhook deletion) didn't break anything.
- **Verify:**
  ```bash
  pytest
  # expected: all non-live tests pass; bear2 live test may be skipped without a real key
  ```

---

## D — Deployment

### D-1. Deploy the backend to Render Starter

Reference: `.hermes/plans/2026-06-20_142814-host-backend-locally-cloudflare.md` (Option B), or use this Render-specific path.

- **Steps:**
  1. Create `backend/render.yaml` (see below).
  2. dashboard.render.com → **New Web Service** → connect `Aryan-Ashta/ucb-ai-hackathon`.
  3. **Root Directory:** `backend`.
  4. **Build Command:** `pip install --upgrade pip && pip install -r requirements.txt`.
  5. **Start Command:** `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`.
  6. **Health Check Path:** `/health`.
  7. **Plan:** Starter ($7/mo) — no spin-down.
  8. **Region:** match your Redis Cloud region (Oregon / Virginia).
  9. Add every required env var from `backend/.env.example`. Mark `*_API_KEY`, `TOKEN_ENCRYPTION_KEY`, `REDIS_*` as Secret.
- **`backend/render.yaml` (commit this for reproducibility):**
  ```yaml
  services:
    - type: web
      name: vibeschool-api
      runtime: python
      rootDir: backend
      plan: starter
      region: oregon
      buildCommand: pip install --upgrade pip && pip install -r requirements.txt
      startCommand: uvicorn backend.main:app --host 0.0.0.0 --port $PORT
      healthCheckPath: /health
      autoDeploy: true
      envVars:
        - key: PYTHON_VERSION
          value: 3.11.11
  ```
- **Verify:** `curl https://vibeschool-api-<hash>.onrender.com/health` → `{"status":"ok"}`.

### D-2. Deploy the frontend to Vercel

- **Steps:**
  1. vercel.com → **Add New Project** → import `Aryan-Ashta/ucb-ai-hackathon`.
  2. **Root Directory:** `frontend`. (Same monorepo concern as Render.)
  3. **Framework Preset:** Next.js (auto-detected).
  4. **Environment Variables** (set in Vercel dashboard, NOT in a `.env` file):
     ```
     NEXT_PUBLIC_BACKEND_URL        https://vibeschool-api-<hash>.onrender.com
     NEXTAUTH_SECRET                <openssl rand -base64 32>
     NEXTAUTH_URL                   https://vibeschool.vercel.app
     GITHUB_CLIENT_ID               <from GitHub OAuth app>
     GITHUB_CLIENT_SECRET           <from GitHub OAuth app>
     NEXT_PUBLIC_SENTRY_DSN         <your DSN>
     SENTRY_DSN                     <your DSN, can match client>
     SENTRY_AUTH_TOKEN              <Sentry project token, project:releases scope>
     ```
  5. **Build Command:** leave default (`next build`).
  6. Deploy.
- **GitHub OAuth callback:**
  In github.com → Settings → Developer settings → OAuth app → add `https://vibeschool.vercel.app/api/auth/callback/github` as the authorization callback URL.
- **Verify:** open the deployed URL → click "Sign in with GitHub" → land back on `/dashboard` authenticated.

### D-3. Wire end-to-end demo

- **Action:**
  1. Vercel → redeploy with `NEXT_PUBLIC_BACKEND_URL` set (D-2 above).
  2. Open `https://vibeschool.vercel.app/dashboard` in an incognito window.
  3. Sign in with GitHub.
  4. Confirm `/api/concepts/<github_id>` returns concepts (or empty if the user has no PRs ingested yet).
  5. Click a 🎤 button → record an answer → confirm grade + next_review update.
- **If dashboard is empty for the signed-in user:** the OAuth sync path needs to run first. Per `.hermes/plans/2026-06-20_131518-oauth-sync-refactor.md`, the frontend should call `POST /api/sync` with `Authorization: Bearer <github_access_token>` on dashboard mount. **This sync endpoint is described in the plan but is NOT yet implemented in `backend/routers/sync.py`.** If the demo needs populated data, that's the highest-priority missing piece — see "Open work" below.
- **Verify:** the demo loop works end-to-end against the deployed URLs.

---

## Final verification gate (run before declaring demo-ready)

```bash
# Backend
cd backend
.venv/bin/pytest                              # all tests green
.venv/bin/python -m backend.scripts.check_redis
.venv/bin/uvicorn backend.main:app --port 8000 &
sleep 2 && curl http://localhost:8000/health   # → {"status":"ok"}
kill %1

# Frontend
cd ../frontend
bun run build                                   # clean build, no Sentry warnings
bun run lint                                    # clean
npx tsc --noEmit                                # clean

# Live deployment
curl https://vibeschool-api-<hash>.onrender.com/health
curl -I https://vibeschool.vercel.app
# visit the URL in a browser, sign in, click a concept, record an answer
```

---

## Files likely to change (summary)

| File | Action | Task |
|---|---|---|
| `backend/routers/webhook.py` | **delete** | P0-1 |
| `backend/main.py` | **modify** — remove webhook mount; add CORS | P0-1, P0-2 |
| `backend/tests/test_webhook.py` | **delete** | P0-1 |
| `frontend/lib/api.ts` | **create** | P0-3, P1-1 |
| `frontend/app/dashboard/page.tsx` | **modify** — replace MOCK_PRS with fetch | P0-3 |
| `frontend/app/quiz/[id]/page.tsx` | **create** | P1-1 |
| `frontend/instrumentation-client.ts` | **modify** — remove hard-coded DSN | P2-1 |
| `frontend/sentry.server.config.ts` | **modify** — remove hard-coded DSN | P2-1 |
| `frontend/sentry.edge.config.ts` | **modify** — remove hard-coded DSN | P2-1 |
| `frontend/next.config.mjs` | **modify** — remove `tunnelRoute` | P2-2 |
| `backend/render.yaml` | **create** | D-1 |
| Vercel project env vars | **set in dashboard** | D-2 |
| GitHub OAuth app callback URL | **add** | D-2 |

---

## Open work (intentionally not in this plan)

These are real but lower priority. If time permits, tackle in this order:

1. **Implement `POST /api/sync`** — described in detail in `.hermes/plans/2026-06-20_131518-oauth-sync-refactor.md`. Until this exists, the dashboard shows whatever the dev machine last ingested, not the signed-in user's actual PRs. Critical for a non-dev demo.
2. **Real auth on backend routers** — `backend/routers/concepts.py:8`, `quiz.py:37`, `schedule.py:18`, `enrich.py:16` all trust the client's `user_id`. Add a `get_current_user_id` dependency that verifies the bearer token and rejects mismatches. See `AGENTS/vibeschool_audit_issues.md` P1-4.
3. **Custom domain** — `api.vibeschool.app` on Render + `vibeschool.app` on Vercel, with `vibeschool_*.app` whitelisted in CORS.
4. **Stable Cloudflare tunnel** for local dev so the URL doesn't rotate per session (see `.hermes/plans/2026-06-20_142814-…` §"Optional polish").

---

## Out of scope (explicit)

- Cron-based background sync (the OAuth refactor moved this out; revisit post-hackathon).
- Refresh-token rotation.
- "Select repos" UX in the dashboard.
- TTS (deepgram TTS for reading the roast aloud was in the original spec but isn't wired anywhere — only STT is in use today).
- Mascot animations.
- Production-grade rate limiting and abuse prevention.
