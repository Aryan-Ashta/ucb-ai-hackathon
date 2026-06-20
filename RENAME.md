# Things to rename / configure before shipping

The deployment model for this repo is **fully local**: backend runs on
`localhost:8000` (uvicorn), frontend runs on `localhost:3000` (Next.js dev
server). There is no Vercel, no Render, no cloud hosting. This file
tracks the cosmetic config items that should still be settled before
the repo is shown publicly.

## Sentry
| File | Field | Current value | Replace with |
|---|---|---|---|
| `frontend/next.config.mjs` | `org` | `ucb-ai-hackathon` | your Sentry org slug |
| `frontend/next.config.mjs` | `project` | `ucb-ai-hackathon` | your Sentry project slug |
| `frontend/.env.local.example` | `NEXT_PUBLIC_SENTRY_DSN` / `SENTRY_DSN` | real project DSN committed | empty + comment pointing at the Sentry settings page |

## GitHub
| What | Current value | Replace with |
|---|---|---|
| GitHub App name | _(whatever you named it)_ | finalize before Devpost |
| GitHub repo name | `ucb-ai-hackathon` | finalize before going public |
| NextAuth callback URL | `http://localhost:3000/api/auth/callback/github` | keep as-is — the local callback is correct for the local deployment model |

## Local-only env
| Var | Notes |
|---|---|
| `NEXTAUTH_URL` | Keep as `http://localhost:3000`. NextAuth's default for the local deployment. |
| `NEXT_PUBLIC_BACKEND_URL` | Keep as `http://localhost:8000`. Frontend talks to the locally-running uvicorn process. If you expose the backend via `cloudflared` for a remote demo, point this at the tunnel URL. |

## Optional cloudflared tunnel
For hackathon demos where judges will hit the URL from their own
devices, the backend can be exposed publicly via `cloudflared tunnel
--url http://localhost:8000` (see `./start-local.sh`). This is not
"deployment" — the backend still runs locally; the tunnel only forwards
public traffic to `localhost:8000`. The frontend still runs locally too;
point its browser at `http://localhost:3000`.

When using a tunnel, set `NEXT_PUBLIC_BACKEND_URL` in
`frontend/.env.local` to the printed tunnel URL and restart `bun dev`.