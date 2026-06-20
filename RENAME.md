# Things to rename / configure before shipping

## Sentry
| File | Field | Current value | Replace with |
|---|---|---|---|
| `frontend/next.config.mjs` | `org` | `ucb-ai-hackathon` | your Sentry org slug |
| `frontend/next.config.mjs` | `project` | `ucb-ai-hackathon` | your Sentry project slug |

## GitHub
| What | Current value | Replace with |
|---|---|---|
| GitHub App name | _(whatever you named it)_ | finalize before Devpost |
| GitHub repo name | `ucb-ai-hackathon` | finalize before going public |
| NextAuth callback URL | `http://localhost:3000/api/auth/callback/github` | production URL on deploy |

## Vercel / deployment
| What | Notes |
|---|---|
| `NEXTAUTH_URL` in env | Change from `http://localhost:3000` to prod URL |
| GitHub OAuth App (or GitHub App) | Create a second one with the prod callback URL |
