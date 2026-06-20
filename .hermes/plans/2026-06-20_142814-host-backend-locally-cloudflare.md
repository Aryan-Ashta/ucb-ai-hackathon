# Hosting the Backend Locally with Cloudflare Tunnel

> **For Hermes:** Single-session implementation guide. No subagents, no TDD cycle — this is operational setup, not code. Walk through it top to bottom once; everything past "Verify" is optional.

**Goal:** Run the FastAPI backend on a developer laptop, expose it to the public internet via `cloudflared`, and point the Vercel-hosted frontend at the tunnel URL so the full app works end-to-end without paying for a host.

**When this is the right pick:**
- Hackathon demo where the laptop will be open and online.
- You want to iterate against real Redis/Claude/Deepgram without deploying.
- You want zero cost during development.

**When this is the wrong pick:**
- Demo runs while the laptop is asleep or offline.
- You're submitting a recorded demo for asynchronous judging.
- You're handing the URL to anyone who isn't watching you live.

---

## Architecture (what we're building)

```
┌─────────────────────────────────────────────────────────────────────────┐
│   Browser (anywhere on the internet)                                    │
│   vibeschool.vercel.app                                                 │
└──────────┬──────────────────────────────────────────────────────────────┘
           │  fetch NEXT_PUBLIC_BACKEND_URL + "/api/..."
           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│   Vercel CDN — Next.js                                                  │
│   - serves dashboard page                                               │
│   - proxies nothing (no /api routes except NextAuth)                    │
└──────────┬──────────────────────────────────────────────────────────────┘
           │
           ▼  (cross-origin; needs CORS allow_origins on the backend)
┌─────────────────────────────────────────────────────────────────────────┐
│   Cloudflare Edge                                                      │
│   https://vibeschool-api.trycloudflare.com  (rotates every ~24h)       │
│   - terminates TLS                                                      │
│   - forwards TCP to localhost:8000 on the laptop                        │
└──────────┬──────────────────────────────────────────────────────────────┘
           │  (loopback HTTP — no TLS past this point)
           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│   Developer laptop (macOS)                                              │
│   uvicorn backend.main:app --host 0.0.0.0 --port 8000                   │
│   ↳ talks to Anthropic / Deepgram / Token Company / Poke / Redis Cloud  │
└─────────────────────────────────────────────────────────────────────────┘
```

Total moving parts: **one terminal for uvicorn, one terminal for cloudflared**. That's it.

---

## Prerequisites (5 min, one-time)

### Install `cloudflared`

```bash
brew install cloudflared
cloudflared --version    # sanity check
```

### Verify backend boots locally

```bash
cd /Users/aryanashta/Documents/GitHub/ucb-ai-hackathon
source backend/.venv/bin/activate       # or: cd backend && .venv/bin/python ...
.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

In another terminal:
```bash
curl http://localhost:8000/health
# → {"status":"ok"}
```

If `config.py` raises on import, your `backend/.env` is missing required keys. See "Env var audit" below.

### Confirm Redis is reachable from the laptop

```bash
cd backend
.venv/bin/python -m backend.scripts.check_redis
# → "✓ Cloud Redis is reachable and working."
```

---

## The two-terminal workflow

### Terminal 1 — backend

```bash
cd /Users/aryanashta/Documents/GitHub/ucb-ai-hackathon
source backend/.venv/bin/activate
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

Flags:
- `--host 0.0.0.0` so `cloudflared` (loopback or not) can reach it.
- `--reload` for live Python edits — only useful during development; remove for the demo to avoid mid-quiz restarts.

Leave this running for the entire demo.

### Terminal 2 — tunnel

```bash
cloudflared tunnel --url http://localhost:8000
```

Look for output like:
```
+----------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at:              |
|  https://<random-word>-<random-word>.trycloudflare.com         |
+----------------------------------------------------------------+
```

**That URL is your `BACKEND_URL`.** It rotates whenever you restart `cloudflared`. Same laptop + same `cloudflared` process = same URL for ~24h.

### Verify end-to-end through the tunnel

```bash
# In a third terminal:
curl https://<your-tunnel-url>/health
# → {"status":"ok"}
```

If this works, the tunnel is wired correctly.

---

## Wire the frontend (Vercel)

1. Open the Vercel project for this repo.
2. **Settings → Environment Variables → Production** (and Preview if you care).
3. Add:
   ```
   NEXT_PUBLIC_BACKEND_URL = https://<your-tunnel-url>
   ```
4. Trigger a redeploy (or push a commit). Vercel needs to re-bundle the client code so `process.env.NEXT_PUBLIC_BACKEND_URL` is inlined.

If the dashboard still uses mock data, you don't need to redeploy to test the tunnel — just hit `https://<your-tunnel-url>/api/concepts/test_user_id` from the browser; the JSON you get back is what the dashboard will eventually fetch.

---

## CORS — required once the frontend calls the backend

Without this, the browser will block every cross-origin fetch.

### Edit `backend/main.py`

Add **before** the `app.include_router(...)` lines:

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://vibeschool.vercel.app",     # production frontend
        "https://*.vercel.app",              # preview deploys
        "http://localhost:3000",             # local Next.js dev
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

`backend/main.py` already has `from backend.sentry_init` as the first import — keep that. Add the `CORSMiddleware` import right after the `FastAPI(...)` line.

For the demo only, you can use `allow_origins=["*"]` to skip the headache. Tighten before any real launch.

Restart uvicorn after editing — the CORS middleware is registered at import time.

---

## Env var audit (what must be in `backend/.env`)

`config.py` calls `_require(key)` for every P0 var — the app refuses to start if any are missing. Cross-check against `backend/.env.example`:

| Var | Status | Source |
|---|---|---|
| `ANTHROPIC_API_KEY` | required | console.anthropic.com → Settings → API Keys |
| `TOKEN_COMPANY_API_KEY` | required | thetokencompany.info (Bear-2) |
| `DEEPGRAM_API_KEY` | required | console.deepgram.com |
| `POKE_API_KEY` | required | Interaction Co (Poke) |
| `TOKEN_ENCRYPTION_KEY` | required | generate with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `REDIS_HOST` + `REDIS_PORT` + `REDIS_USERNAME` + `REDIS_PASSWORD` | required | Redis Cloud → database → Connect |
| `REDIS_TLS` | required (`true` / `false`) | match your Redis Cloud TLS setting |
| `SENTRY_DSN` | optional | leave empty to no-op Sentry |
| `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` | optional (P1) | needed only if you demo the `/api/enrich` path |
| `GITHUB_API_BASE` | optional | defaults to `https://api.github.com` |
| `GITHUB_TOKEN` | optional | server-wide fallback for unauthenticated API calls |

> **Heads-up on `TOKEN_ENCRYPTION_KEY`**: This is a new requirement from the OAuth sync refactor. If your local `.env` is older than `2026-06-20`, add it and restart uvicorn.

---

## Demo-day checklist

Run through these **15 minutes before** the demo, in order:

1. **Laptop power**: plug in. Disable energy saver:
   - System Settings → Battery → Energy Mode → "High Power"
   - System Settings → Lock Screen → "Prevent automatic sleeping when the display is off" → enable
2. **Wi-Fi**: confirm you have internet (`ping 1.1.1.1`).
3. **Terminal 1 — uvicorn**: still running? Hit `curl http://localhost:8000/health` from another shell.
4. **Terminal 2 — cloudflared**: still running? Hit `curl https://<tunnel-url>/health`.
5. **Vercel env var**: `NEXT_PUBLIC_BACKEND_URL` still matches the current tunnel URL? **If you restarted cloudflared, this changed.** Update in Vercel + redeploy (or hot-edit if you have a build-less path).
6. **CORS**: your Vercel URL is in `allow_origins`?
7. **Browser cache**: open the dashboard in an incognito window — fresh state, no stale `process.env` from a previous bundle.
8. **One full happy path**: sign in → load dashboard → record a quiz answer → confirm SM-2 state updated in Redis (`.venv/bin/python -m backend.scripts.check_redis` won't show this; just trust the response from `/api/grade`).

If any step fails, the next section tells you which knob to turn.

---

## Troubleshooting

### "CORS policy: No 'Access-Control-Allow-Origin' header"
- `allow_origins` in `backend/main.py` doesn't include your Vercel URL (or wildcard).
- Restart uvicorn after the edit.

### "Tunnel URL returned 502 / 503"
- uvicorn is not running, or crashed mid-request. Check Terminal 1.
- If uvicorn shows an exception, paste the traceback — usually a missing env var or a Redis timeout.

### "Tunnel works for me but the deployed frontend shows network error"
- The frontend is hitting an *old* tunnel URL. Vercel env vars are baked at build time. Update `NEXT_PUBLIC_BACKEND_URL` and **redeploy** (or `vercel --prod`).
- Quick check: open DevTools → Network → click a failing request → look at the URL host.

### "Audio upload (transcribe) is slow / fails"
- `/api/transcribe` ships audio/webm blobs from the browser **directly to the backend** (no Vercel proxy). Cloudflare's free tier accepts up to 100 MB per request — short voice clips fit easily.
- If you get 413, the recording is too long; tighten the MediaRecorder `timeslice` in the quiz page.

### "Laptop went to sleep mid-demo, now nothing works"
1. Wake the laptop.
2. `cloudflared` may have died — restart Terminal 2.
3. New URL → update Vercel env var → redeploy.
4. Or: run everything on Render / DigitalOcean instead. This is exactly the failure mode that pushes you toward a paid host.

### "Redis connection failed"
- Run `.venv/bin/python -m backend.scripts.check_redis` from `backend/`. It will tell you exactly which env var is wrong.
- If it works locally but the live uvicorn fails, the env vars in `.env` differ from your shell — uvicorn reads `.env` via `config.py:7` (`load_dotenv`), so they should match.

### "Webhook events never arrive"
- That's expected. The OAuth sync refactor removed webhooks (`backend/config.py:22`); PRs are pulled on demand from the signed-in user's GitHub account, not pushed by GitHub. Nothing to do here.

### "Claude grade takes forever / times out"
- Default Anthropic timeout via the SDK is 60s. If a request is hanging, check `claude.py` — every call is wrapped in `sentry_sdk.start_span`, so Sentry will show the duration.
- If you're rate-limited (lots of demo attempts), back off and retry; the SDK raises `anthropic.RateLimitError`.

---

## Optional polish (do these once the basic flow works)

### Stable URL across restarts

The free `trycloudflare.com` URL rotates. To get a stable hostname:

1. Sign up for a free Cloudflare account.
2. `cloudflared tunnel login` → browser auth.
3. `cloudflared tunnel create vibeschool` → gives you a tunnel UUID and credentials file.
4. `cloudflared tunnel route dns vibeschool api.vibeschool.app` (or any subdomain you own).
5. `cloudflared tunnel run vibeschool` → tunnel now lives at `https://api.vibeschool.app`, no rotation.

Costs nothing; takes 10 minutes. Worth it if you're going to demo more than once.

### Auto-start on login (macOS)

Use `launchd` so `uvicorn` + `cloudflared` come up automatically if you reboot:

```bash
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.vibeschool.backend.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.vibeschool.backend</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/aryanashta/Documents/GitHub/ucb-ai-hackathon/backend/.venv/bin/uvicorn</string>
    <string>backend.main:app</string>
    <string>--host</string><string>0.0.0.0</string>
    <string>--port</string><string>8000</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/aryanashta/Documents/GitHub/ucb-ai-hackathon/backend</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.vibeschool.backend.plist
```

Repeat for `cloudflared` if you set up a named tunnel. Verify with `launchctl list | grep vibeschool`.

### Faster feedback loop during development

```bash
# Terminal 1
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

The `--reload` flag watches `backend/**/*.py` and restarts on save. Don't use during the demo (a restart mid-quiz = dropped connection).

### Logs to Sentry

If `SENTRY_DSN` is set in `.env`, breadcrumbs + spans from every external call are already wired (you'll see `sentry_init.py:7` in `main.py:1`). Confirm by visiting your Sentry project after a single demo run.

---

## Files referenced / likely to change

| File | Change | When |
|---|---|---|
| `backend/main.py` | Add `CORSMiddleware` | Once, before first demo |
| `backend/.env` | Fill in all required vars | Once, before first run |
| `frontend/.env.local` | Add `NEXT_PUBLIC_BACKEND_URL` if doing local frontend too | Once |
| Vercel project env vars | Add `NEXT_PUBLIC_BACKEND_URL` | Once per demo session if URL rotates |
| `~/.config/cloudflared/` | Created automatically by `cloudflared tunnel login` | Only if you set up a named tunnel |

No application code changes are required to host locally — the entire backend already runs cleanly under uvicorn. CORS is the only code edit needed before the frontend on Vercel can reach it.

---

## Switching to a real host later

The local setup is fully compatible with any future host. The migration is:

1. Provision Render / DigitalOcean App Platform / a Droplet.
2. Push the same `backend/` directory; the build command and entry point don't change.
3. Copy every var from `backend/.env` into the host's env-var dashboard.
4. Update Vercel `NEXT_PUBLIC_BACKEND_URL` to the new URL.
5. Decommission the laptop + `cloudflared`.

No refactor required.
