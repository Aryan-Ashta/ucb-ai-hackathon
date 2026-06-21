# VibeSchool — Demo Readiness Plan

> **⚠️ SUPERSEDED — see [`STATUS.md`](../../STATUS.md) and [`ROADMAP.md`](../../ROADMAP.md).**
>
> This is the demo-prep plan from June 20, 2026 afternoon. Both blockers it calls out (dashboard using `MOCK_PRS`, `/quiz/[id]` returning 404) are fixed in current `main` (`STATUS.md` "What works end-to-end"). The current demo checklist is in `ROADMAP.md` → "Demo checklist (live, on a developer's laptop)".
>
> Kept for audit trail only.

---

> **For Hermes:** Execute in numbered order. P0 tasks block P1 tasks; P1 blocks P2. Every task has a one-line verify command that proves it worked.
>
> **Goal:** Take VibeSchool from "code-complete but disconnected" to "live demo working end-to-end on a developer laptop" in roughly 2 hours of focused work. The deployment model is **fully local**: backend on `localhost:8000` (uvicorn), frontend on `localhost:3000` (`bun dev`). There is no Vercel, Render, or any cloud-hosted runtime.

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
L-1   Run end-to-end on the laptop         (5 min)
── gate: live demo works locally ──
```

Total estimate: **~2 hours** end-to-end.

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
- **Why it matters:** The Next.js dev server runs on `http://localhost:3000` and the FastAPI backend on `http://localhost:8000`. Different ports = different origins from the browser's perspective, so cross-origin fetches will be blocked without `Access-Control-Allow-Origin`. (If you later expose the backend via a cloudflared tunnel, the tunnel hostname becomes another origin to allow.)
- **Files:** `backend/main.py`
- **Patch:** add directly after `app = FastAPI(title="VibeSchool Backend")`:
  ```python
  from fastapi.middleware.cors import CORSMiddleware

  # Local-only deployment. Allow the Next.js dev server, plus any
  # trycloudflare.com hostname (rotates per session) in case you expose the
  # backend through a tunnel for an external demo.
  app.add_middleware(
      CORSMiddleware,
      allow_origins=[
          "http://localhost:3000",
          "http://127.0.0.1:3000",
      ],
      # cloudflared quick-tunnel URLs rotate per session (xxx-yyy.trycloudflare.com),
      # so we can't list them — match by hostname pattern instead.
      allow_origin_regex=r"https://[a-z0-9-]+\.trycloudflare\.com",
      allow_credentials=True,
      allow_methods=["*"],
      allow_headers=["*"],
  )
  ```
- **Verify:**
  ```bash
  .venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8000 &
  sleep 2
  curl -s -H "Origin: http://localhost:3000" \
    -D - http://localhost:8000/health | grep -i access-control-allow-origin
  # expected: access-control-allow-origin: http://localhost:3000
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

### P1-2. Confirm audio goes directly to the backend (no proxy)

- **Where:** the `fetch` URL inside the MediaRecorder snippet from P1-1.
- **Why it matters:** Next.js dev server doesn't proxy `/api/transcribe`, but even in a hypothetical production build the audio/webm blob should hit FastAPI directly — FastAPI has no body-size cap equivalent to Vercel Serverless Functions' 4.5 MB limit. Going direct bypasses any future proxy layer entirely.
- **Files:** `frontend/app/quiz/[id]/page.tsx`
- **Action:** the snippet above already uses `${BACKEND_URL}/api/transcribe` directly. **Document this decision with a one-line comment** so future agents don't "fix" it by routing through `/api/transcribe` on the frontend.
- **Verify:** record a 30-second clip and confirm the backend logs the request at `/api/transcribe` with the full body size (not a 413 from any proxy in the middle).

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

## L — Local end-to-end run

Both the backend and the frontend run locally on the developer laptop. No cloud-hosted runtime is involved at any point. This section replaces the old "D — Deployment" steps; everything from P0/P1/P2 above should be working before you get here.

### L-1. Run end-to-end on the laptop

**Prereqs (one-time):**
- Python 3.14 with the venv at the repo root (`.venv/`) — installed per `backend/requirements.txt`.
- `bun` (or `npm`) for the frontend.
- Redis Cloud credentials in `backend/.env` (see `backend/.env.example`).
- GitHub OAuth app with callback `http://localhost:3000/api/auth/callback/github` and credentials in `frontend/.env.local`.

**Steps:**

1. **Terminal 1 — backend:**
   ```bash
   cd /Users/aryanashta/Documents/GitHub/ucb-ai-hackathon
   ./.venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8000
   ```
   Confirm with `curl http://localhost:8000/health` → `{"status":"ok"}`.

2. **Terminal 2 — frontend:**
   ```bash
   cd frontend
   bun dev
   ```
   Confirm with `curl -I http://localhost:3000` → `200 OK`.

3. **Optional Terminal 3 — cloudflared tunnel** (only if judges need to reach the app from their own devices; see `.hermes/plans/2026-06-20_142814-host-backend-locally-cloudflare.md`):
   ```bash
   ./start-local.sh
   ```
   If used, set `NEXT_PUBLIC_BACKEND_URL` in `frontend/.env.local` to the printed tunnel URL and restart `bun dev`. The frontend itself still runs locally; only the backend's `localhost:8000` is exposed publicly.

4. **Sign in.** Open `http://localhost:3000` in a browser, click "Sign in with GitHub". You should land on `/dashboard`.

5. **Trigger sync.** The dashboard calls `POST /api/sync` on mount. If the list is empty, click the dashboard's "Sync now" button (if exposed) or call `POST /api/sync` directly with the bearer token.

6. **Click a 🎤 button → record an answer → confirm grade + `next_review` update.**

**Verify:** the full voice-quiz loop works against `http://localhost:3000` on the laptop. If you used the cloudflared tunnel, also verify it works at the printed `https://...trycloudflare.com` URL.

**If the dashboard is empty for the signed-in user:** the OAuth sync path needs to run first. Per `.hermes/plans/2026-06-20_131518-oauth-sync-refactor.md`, the frontend calls `POST /api/sync` with `Authorization: Bearer <github_token>` on dashboard mount. The endpoint is implemented in `backend/routers/sync.py`; if the list is still empty, hit `/api/sync/status` to see the last sync timestamp, or `/api/sync` again to force a fresh pull.

---

## Final verification gate (run before declaring demo-ready)

```bash
# Backend
cd /Users/aryanashta/Documents/GitHub/ucb-ai-hackathon
.venv/bin/pytest                              # all tests green
.venv/bin/python -m backend.scripts.check_redis
.venv/bin/uvicorn backend.main:app --port 8000 &
sleep 2 && curl http://localhost:8000/health   # → {"status":"ok"}
kill %1

# Frontend
cd frontend
bun run build                                   # clean build, no Sentry warnings
bun run lint                                    # clean
npx tsc --noEmit                                # clean

# Manual end-to-end
# 1. Backend running: ./.venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8000
# 2. Frontend running: cd frontend && bun dev
# 3. Open http://localhost:3000 in a browser, sign in with GitHub, click a concept, record an answer
# 4. (Optional) Run ./start-local.sh to expose the backend via cloudflared; verify from a second device
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

No cloud-platform config files (no `render.yaml`, no Vercel project, no hosted runtime) are needed — deployment is local.

---

## Open work (intentionally not in this plan)

These are real but lower priority. If time permits, tackle in this order:

1. **Stable Cloudflare tunnel** for local dev so the URL doesn't rotate per session (see `.hermes/plans/2026-06-20_142814-…` §"Optional polish"). Reminder: this is *not* a deployment — the backend still runs locally; the tunnel only forwards public traffic to `localhost:8000`.
2. **A second GitHub OAuth app** (optional, only if you ever expose a non-local URL). For the current local-only deployment, the single OAuth app with callback `http://localhost:3000/api/auth/callback/github` is sufficient.

---

## Out of scope (explicit)

- Cron-based background sync (the OAuth refactor moved this out; revisit post-hackathon).
- Refresh-token rotation.
- "Select repos" UX in the dashboard.
- TTS (deepgram TTS for reading the roast aloud was in the original spec but isn't wired anywhere — only STT is in use today).
- Mascot animations.
- Production-grade rate limiting and abuse prevention.
