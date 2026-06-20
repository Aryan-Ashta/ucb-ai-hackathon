# Backend Refactor: Webhooks → GitHub OAuth Polling

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace the GitHub App webhook ingestion path with a pull-based flow driven by the NextAuth session's GitHub `accessToken`, so the demo works the moment a user signs in — no GitHub App, no webhook secret, no public callback URL.

**Architecture:** The frontend (NextAuth) holds a GitHub OAuth `accessToken` with `repo` scope (already configured in `frontend/app/api/auth/[...nextauth]/route.ts:9`). The backend exposes a single `POST /api/sync` endpoint that accepts the access token in an `Authorization: Bearer` header, fetches **all merged PRs in repos the user has push access to** (cross-author: teammates' PRs count), runs each diff through the existing Bear-2 → Claude → Redis pipeline, and returns a sync summary. The dashboard calls `/api/sync` on mount and exposes a "Sync now" button. The webhook router and `GITHUB_WEBHOOK_SECRET` are deleted.

**Token storage model (decision flipped from default):** The backend **encrypts and persists** the access token on first sight, keyed by GitHub `user_id`, using a server-side `TOKEN_ENCRYPTION_KEY` (Fernet). Subsequent requests still carry the token in `Authorization: Bearer` (so we can re-verify and refresh the stored copy), but the **stored encrypted token is the source of truth** for any future background work (cron sync, batch ops). Fernet key generation: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`.

**Tech Stack:** FastAPI (unchanged), `httpx` (unchanged), `backend/services/claude.py` and `redis_client.py` (unchanged), `backend/services/diff_parser.py` (one signature change), new `backend/services/github_oauth.py` and `backend/services/sync.py`, new `backend/routers/sync.py` and `backend/dependencies/auth.py`, new Redis key namespace `user:{user_id}:*`.

---

## Current Context & Assumptions

**What exists today (verified, 2026-06-20):**
- `backend/routers/webhook.py` (62 lines): HMAC verify, merged-PR detection, kicks off `run_ingestion_pipeline` in `BackgroundTasks`.
- `backend/services/diff_parser.py:fetch_and_parse_diff(repo, pr_number)` uses the env `GITHUB_TOKEN` to call `GET /repos/{owner}/{repo}/pulls/{n}` with `Accept: application/vnd.github.v3.diff`.
- `backend/services/claude.py:extract_concepts_and_cache(diff, user_id, pr_number)` produces a `concept_id = f"{user_id}:{pr_number}:{slug}"` and writes to Redis.
- `backend/routers/concepts.py:GET /concepts/{user_id}` returns due concepts for any `user_id` (no auth).
- `frontend/app/api/auth/[...nextauth]/route.ts:9` requests `read:user user:email repo` scope; the `session` callback populates `session.accessToken` from the JWT.
- `frontend/types/next-auth.d.ts` already declares `accessToken?: string` on both `Session` and `JWT`.
- `frontend/app/dashboard/page.tsx` uses hard-coded `MOCK_PRS` (no real API calls yet).

**Assumptions (stated so they're checkable later):**
1. The system has not yet been run end-to-end; no production Redis keys exist with the old `concept:{user_id}:*` schema. Cache-key migration is a non-problem.
2. `user_id` semantics change: under webhooks it was the **PR author's GitHub id** (from the payload); under OAuth it is the **signed-in user's GitHub id**. The cache key namespace `user_id:{github_id}:...` is preserved, so old keys (if any) keep working.
3. The NextAuth `accessToken` is the same GitHub token used for the API; NextAuth's `account.access_token` is the classic OAuth access token, not a GitHub App installation token. (Verify when implementing — see Task 3.)
4. No "select repos" UX in this iteration; sync covers all repos the user has push access to. (This is a deliberate YAGNI decision — see Open Questions.)
5. We do not store the access token on the backend. The frontend sends it per-request. This is a hackathon-acceptable tradeoff; the production path is documented in Open Questions.

**Out of scope for this refactor (call out, don't do):**
- Cron-based background sync
- Refresh-token storage
- Webhook coexistence / migration window (we delete the webhook code)
- "Select repos" UI
- A Redis-backed "ingestion lock" so two simultaneous syncs don't double-bill Claude (we use a simple in-process lock + idempotent `extract_concepts_and_cache` keyed by `concept_id`)

---

## Proposed Approach

### Data flow (after refactor)

```
┌──────────────┐   signIn("github")    ┌──────────────┐
│   Browser    │ ──────────────────▶   │  NextAuth    │  (already wired)
│              │   ◀─ session.accessToken ─  GitHub  │
└──────┬───────┘                       └──────────────┘
       │ fetch /api/sync + Bearer
       ▼
┌──────────────────────────────────────────────────────┐
│              FastAPI backend                         │
│                                                      │
│  POST /api/sync                                      │
│      │                                               │
│      ├─▶ dependencies/auth.py:get_current_user()    │
│      │       GET https://api.github.com/user         │
│      │       → {id, login, ...}  (cached 5 min)      │
│      │                                               │
│      ├─▶ services/github_oauth.py                    │
│      │       list_user_repos(token)                  │
│      │       list_merged_prs(token, repo, since)     │
│      │       fetch_pr_diff(token, repo, pr_number)   │
│      │                                               │
│      └─▶ services/sync.py:sync_user_prs(...)        │
│              for each new merged PR:                 │
│                  diff = fetch_pr_diff(...)           │
│                  await extract_concepts_and_cache(   │
│                      diff, user_id=gh_id, pr_number  │
│                  )  ◀── UNCHANGED                    │
└──────────────────────────────────────────────────────┘
       │ diff (already cleaned) + user_id + pr_number
       ▼
   (Bear-2 → Claude → Redis — fully unchanged)
```

### Why this is small

- `extract_concepts_and_cache` already takes `(raw_diff, user_id, pr_number)` — exactly the call we need. The webhook code is just a transport; deleting it and replacing with a sync router is a swap, not a rewrite.
- `clean_diff` is pure. `fetch_and_parse_diff` only needs a per-request `access_token` parameter.
- The Redis key namespace already keys on `user_id`; we just have to make sure we use the same `user_id` schema (GitHub user `id` as string) the webhook would have used.

### New Redis keys (additive, no conflict)

```
user:{user_id}:repos           SET  repo full_names the user has access to
user:{user_id}:prs             HASH pr_number → {merged_at, repo_full_name, processed}
user:{user_id}:last_sync       INT  unix timestamp of last successful sync
user:{user_id}:sync_inflight   STR  "1" with EX=300 — prevents overlapping syncs
```

`concept:{user_id}:*` and `due:{user_id}` (the existing schema) are untouched.

### Auth model

A FastAPI dependency `get_current_user` that:
1. Reads `Authorization: Bearer <token>`.
2. Calls `GET https://api.github.com/user` with the token. On non-2xx → 401.
3. Returns `{"id": str(user["id"]), "login": user["login"], "token": token}`.

The frontend sends this header on every protected request (a tiny `apiFetch` helper in `frontend/lib/api.ts`).

---

## Files Likely To Change

| File | Action | Why |
|---|---|---|
| `backend/routers/webhook.py` | **delete** | Replaced by `/api/sync` |
| `backend/routers/sync.py` | **create** | `POST /api/sync`, `GET /api/sync/status` |
| `backend/services/sync.py` | **create** | Orchestrator: list repos → list PRs → diff → extract |
| `backend/services/github_oauth.py` | **create** | All GitHub API calls, takes `access_token` |
| `backend/services/token_store.py` | **create** | Fernet encrypt/decrypt of user access tokens |
| `backend/dependencies/__init__.py` | **create** | empty |
| `backend/dependencies/auth.py` | **create** | `get_current_user` FastAPI dependency |
| `backend/services/diff_parser.py` | **modify** | `fetch_and_parse_diff` takes `access_token: str` param |
| `backend/services/redis_client.py` | **modify** | Add 4 helper functions for new keys |
| `backend/routers/concepts.py` | **modify** | Drop `{user_id}` path param; derive from auth |
| `backend/routers/quiz.py` | **modify** | Drop `user_id` body field; derive from auth |
| `backend/routers/schedule.py` | **modify** | Drop `user_id` body field; derive from auth |
| `backend/routers/enrich.py` | **modify** | Drop `user_id` body field; derive from auth |
| `backend/main.py` | **modify** | Drop `webhook` import, add `sync`, `dependencies.auth` |
| `backend/config.py` | **modify** | Drop `GITHUB_WEBHOOK_SECRET`; add `TOKEN_ENCRYPTION_KEY`, `GITHUB_API_BASE` |
| `backend/.env.example` | **modify** | Drop `GITHUB_WEBHOOK_SECRET`; add explanatory comments |
| `backend/tests/test_webhook.py` | **delete** | Webhook is gone |
| `backend/tests/test_sync.py` | **create** | Unit + integration tests for sync |
| `backend/tests/test_auth.py` | **create** | Tests for the auth dependency (httpx MockTransport) |
| `backend/tests/test_github_oauth.py` | **create** | Tests for OAuth service (httpx MockTransport) |
| `backend/tests/test_diff_parser.py` | **modify** | Update call sites for new signature |
| `backend/tests/test_claude.py` | **no change** | Signature unchanged |
| `backend/tests/test_e2e.py` | **no change** | Uses `cache_quiz_content` directly |
| `frontend/lib/api.ts` | **create** | `apiFetch` wrapper that injects Bearer token |
| `frontend/app/dashboard/page.tsx` | **modify** | Real fetch on mount; "Sync now" button; loading state |
| `frontend/types/next-auth.d.ts` | **modify** | Add `user.id` to the Session type |
| `AGENTS/vibeschool_agent_plan.md` | **modify** | Add a note at the top that A1/A2/A3 are now driven by `/api/sync` |
| `RENAME.md` | **no change** | Sentry / OAuth URL items remain |
| `AGENTS/vibeschool_audit_issues.md` | **modify** | Mark P0-1 and P1-4 as fixed by this refactor |

---

## Step-by-Step Plan (bite-sized, TDD)

Each task is 2-5 minutes of focused work. Every code task follows RED → GREEN → REFACTOR. Commit after every task.

### Task 0: Branch + dependency check

**Objective:** Start a clean branch and verify httpx mocking is available for the new tests.

**Files:** none

```bash
git checkout -b refactor/oauth-sync
git status
.venv/bin/pip show httpx | head -1   # confirm httpx>=0.27 for MockTransport
```

**Verify:** On new branch, venv active.

### Task 1: Failing test for `get_current_user` dependency

**Objective:** Test that the auth dependency returns the right shape on a valid token and 401s on an invalid one.

**Files:**
- Create: `backend/dependencies/__init__.py` (empty)
- Create: `backend/tests/test_auth.py`

**Step 1 — Write failing test**

```python
# backend/tests/test_auth.py
import httpx
import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from backend.dependencies.auth import get_current_user

app = FastAPI()

@app.get("/me")
def me(user=Depends(get_current_user)):
    return {"id": user["id"], "login": user["login"]}


def _mock_app_user():
    return {"id": 4242, "login": "octocat"}


def test_get_current_user_returns_github_identity(monkeypatch):
    async def fake_get(self, url, headers=None, **kw):
        if url.endswith("/user"):
            return httpx.Response(200, json=_mock_app_user())
        raise AssertionError(f"unexpected URL: {url}")

    transport = httpx.MockTransport(fake_get)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    with TestClient(app) as c:
        r = c.get("/me", headers={"Authorization": "Bearer ghp_test"})
    assert r.status_code == 200
    assert r.json() == {"id": "4242", "login": "octocat"}


def test_get_current_user_rejects_invalid_token(monkeypatch):
    async def fake_get(self, url, **kw):
        return httpx.Response(401, json={"message": "Bad credentials"})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    with TestClient(app) as c:
        r = c.get("/me", headers={"Authorization": "Bearer bad"})
    assert r.status_code == 401
```

**Step 2 — Run, expect ModuleNotFoundError**

```bash
pytest backend/tests/test_auth.py -v
```

**Step 3 — Implement minimal code**

```python
# backend/dependencies/auth.py
from typing import Annotated

import httpx
from fastapi import Depends, Header, HTTPException

GITHUB_API = "https://api.github.com"


async def get_current_user(authorization: Annotated[str | None, Header()] = None) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()

    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{GITHUB_API}/user",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=5.0,
        )
    if r.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid GitHub token")
    user = r.json()
    return {"id": str(user["id"]), "login": user["login"], "token": token}
```

**Step 4 — Run, expect PASS**

```bash
pytest backend/tests/test_auth.py -v
```

**Step 5 — Commit**

```bash
git add backend/dependencies backend/tests/test_auth.py
git commit -m "feat(auth): add get_current_user dependency for OAuth bearer tokens"
```

### Task 2: Failing test for `list_merged_prs` in `github_oauth.py`

**Objective:** Verify the service knows how to paginate and filter merged PRs by `merged_at >= since`.

**Files:**
- Create: `backend/services/github_oauth.py` (test will fail; impl follows)

**Step 1 — Write failing test**

```python
# backend/tests/test_github_oauth.py
import httpx
import pytest

from backend.services.github_oauth import list_merged_prs


@pytest.mark.asyncio
async def test_list_merged_prs_paginates_and_filters(monkeypatch):
    pages = [
        [{"number": 1, "merged_at": "2026-06-01T00:00:00Z", "user": {"id": 9}}],
        [{"number": 2, "merged_at": "2026-05-01T00:00:00Z", "user": {"id": 9}}],  # too old
    ]
    urls_called = []

    def handler(request: httpx.Request) -> httpx.Response:
        urls_called.append(str(request.url))
        if "page=1" in str(request.url) or "page=" not in str(request.url):
            return httpx.Response(200, json=pages[0], headers={"Link": '<next>; rel="next"'})
        return httpx.Response(200, json=pages[1])

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        # Inject our test client into the module
        monkeypatch.setattr("backend.services.github_oauth._client", client)
        result = await list_merged_prs("ghp_test", "octocat/hello", since="2026-06-01T00:00:00Z")

    assert [pr["number"] for pr in result] == [1]
    assert len(urls_called) >= 1
```

**Step 2 — Run, expect ImportError on the module**

**Step 3 — Implement**

```python
# backend/services/github_oauth.py
from datetime import datetime, timezone
from typing import AsyncIterator

import httpx
import sentry_sdk

GITHUB_API = "https://api.github.com"


def _headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


async def get_authenticated_user(token: str) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{GITHUB_API}/user", headers=_headers(token), timeout=10.0)
        r.raise_for_status()
        return r.json()


async def list_user_repos(token: str) -> list[dict]:
    repos, page = [], 1
    async with httpx.AsyncClient() as client:
        while True:
            r = await client.get(
                f"{GITHUB_API}/user/repos",
                headers=_headers(token),
                params={"per_page": 100, "page": page, "affiliation": "owner,collaborator,organization_member"},
                timeout=15.0,
            )
            r.raise_for_status()
            batch = r.json()
            if not batch:
                return repos
            repos.extend(batch)
            page += 1


async def list_merged_prs(token: str, repo_full_name: str, since: str) -> list[dict]:
    """PRs in this repo with merged_at >= since, authored by the token's user."""
    since_ts = datetime.fromisoformat(since.replace("Z", "+00:00"))
    me = await get_authenticated_user(token)
    me_id = me["id"]

    out, page = [], 1
    async with httpx.AsyncClient() as client:
        while True:
            r = await client.get(
                f"{GITHUB_API}/repos/{repo_full_name}/pulls",
                headers={**_headers(token), "Accept": "application/vnd.github+json"},
                params={"state": "closed", "per_page": 100, "page": page, "sort": "updated", "direction": "desc"},
                timeout=15.0,
            )
            r.raise_for_status()
            batch = r.json()
            if not batch:
                return out
            for pr in batch:
                if not pr.get("merged_at"):
                    continue
                merged = datetime.fromisoformat(pr["merged_at"].replace("Z", "+00:00"))
                if merged < since_ts:
                    return out  # sorted desc by updated, can stop
                if pr.get("user", {}).get("id") == me_id:
                    out.append(pr)
            page += 1


async def fetch_pr_diff(token: str, repo_full_name: str, pr_number: int) -> str:
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{GITHUB_API}/repos/{repo_full_name}/pulls/{pr_number}",
            headers={**_headers(token), "Accept": "application/vnd.github.v3.diff"},
            timeout=15.0,
        )
        r.raise_for_status()
        sentry_sdk.add_breadcrumb(
            category="github_oauth", level="info",
            message=f"Fetched diff for {repo_full_name}#{pr_number}: {len(r.text)} chars",
        )
        return r.text
```

**Step 4 — Run, expect PASS**

**Step 5 — Commit**

```bash
git add backend/services/github_oauth.py backend/tests/test_github_oauth.py
git commit -m "feat(github_oauth): list repos, merged PRs, and fetch diffs via user token"
```

### Task 3: `diff_parser.fetch_and_parse_diff` takes an `access_token`

**Objective:** Drop the env-var `GITHUB_TOKEN`; accept a per-request token.

**Files:**
- Modify: `backend/services/diff_parser.py:19-32`
- Modify: `backend/tests/test_diff_parser.py:1-6` (no change to `clean_diff` tests)

**Step 1 — Update one existing test to call the new signature**

In `backend/tests/test_diff_parser.py`, the existing tests only call `clean_diff` (pure), so no change there. But the webhook test (`test_webhook.py`) calls `fetch_and_parse_diff` indirectly — that test file is being deleted in Task 10. No test changes needed for `fetch_and_parse_diff` directly.

**Step 2 — Modify the function**

```python
# backend/services/diff_parser.py
async def fetch_and_parse_diff(
    repo_full_name: str, pr_number: int, *, access_token: str = ""
) -> str:
    """Fetch + clean a PR diff. `access_token` is the user's OAuth token (may be empty)."""
    url = f"https://api.github.com/repos/{repo_full_name}/pulls/{pr_number}"
    headers = {"Accept": "application/vnd.github.v3.diff"}
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"

    async with httpx.AsyncClient() as client:
        response = await client.get(url, headers=headers, timeout=15.0)
        response.raise_for_status()
        raw_diff = response.text

    cleaned = clean_diff(raw_diff)
    sentry_sdk.add_breadcrumb(
        category="diff_parser", level="info",
        message=f"Parsed {repo_full_name}#{pr_number}: {len(raw_diff)} → {len(cleaned)} chars",
    )
    return cleaned
```

**Step 3 — Run all diff_parser tests, expect PASS** (none call this function directly)

```bash
pytest backend/tests/test_diff_parser.py -v
```

**Step 4 — Commit**

```bash
git add backend/services/diff_parser.py
git commit -m "refactor(diff_parser): take per-request access_token instead of env var"
```

### Task 4: Add 4 Redis helpers for the new namespace

**Objective:** Support the new `user:{user_id}:*` keys without bloating `cache_quiz_content`.

**Files:**
- Modify: `backend/services/redis_client.py` (append)

**Step 1 — Write failing tests** in `backend/tests/test_redis.py`:

```python
async def test_track_and_list_user_prs():
    from backend.services.redis_client import mark_pr_processed, list_processed_prs
    await mark_pr_processed("u1", repo="octocat/hello", pr_number=42, merged_at="2026-06-01T00:00:00Z")
    prs = await list_processed_prs("u1")
    assert any(p["pr_number"] == 42 for p in prs)

async def test_last_sync_roundtrip():
    from backend.services.redis_client import get_last_sync, set_last_sync
    assert await get_last_sync("u1") is None
    await set_last_sync("u1", 1_700_000_000)
    assert await get_last_sync("u1") == 1_700_000_000

async def test_sync_inflight_lock():
    from backend.services.redis_client import acquire_sync_lock, release_sync_lock
    assert await acquire_sync_lock("u1") is True
    assert await acquire_sync_lock("u1") is False  # already held
    await release_sync_lock("u1")
    assert await acquire_sync_lock("u1") is True
    await release_sync_lock("u1")

async def test_user_repos_roundtrip():
    from backend.services.redis_client import add_user_repo, list_user_repos_cached
    await add_user_repo("u1", "octocat/hello")
    await add_user_repo("u1", "octocat/world")
    assert set(await list_user_repos_cached("u1")) == {"octocat/hello", "octocat/world"}
```

**Step 2 — Run, expect ImportError**

**Step 3 — Implement** (append to `backend/services/redis_client.py`):

```python
# ── user-scoped state (added by OAuth refactor) ────────────────────────────
async def mark_pr_processed(user_id: str, *, repo: str, pr_number: int, merged_at: str) -> None:
    r = await get_redis()
    key = f"user:{user_id}:prs"
    await r.hset(key, str(pr_number), json.dumps({"repo": repo, "merged_at": merged_at}))
    await r.expire(key, REDIS_TTL_SECONDS)


async def list_processed_prs(user_id: str) -> list[dict]:
    r = await get_redis()
    raw = await r.hgetall(f"user:{user_id}:prs")
    return [{"pr_number": int(k), **json.loads(v)} for k, v in raw.items()]


async def get_last_sync(user_id: str) -> int | None:
    r = await get_redis()
    val = await r.get(f"user:{user_id}:last_sync")
    return int(val) if val else None


async def set_last_sync(user_id: str, ts: int) -> None:
    r = await get_redis()
    await r.set(f"user:{user_id}:last_sync", ts, ex=REDIS_TTL_SECONDS)


async def acquire_sync_lock(user_id: str, ttl: int = 300) -> bool:
    r = await get_redis()
    return bool(await r.set(f"user:{user_id}:sync_inflight", "1", ex=ttl, nx=True))


async def release_sync_lock(user_id: str) -> None:
    r = await get_redis()
    await r.delete(f"user:{user_id}:sync_inflight")


async def add_user_repo(user_id: str, repo_full_name: str) -> None:
    r = await get_redis()
    await r.sadd(f"user:{user_id}:repos", repo_full_name)
    await r.expire(f"user:{user_id}:repos", REDIS_TTL_SECONDS)


async def list_user_repos_cached(user_id: str) -> list[str]:
    r = await get_redis()
    return list(await r.smembers(f"user:{user_id}:repos"))
```

**Step 4 — Run, expect PASS**

**Step 5 — Commit**

```bash
git add backend/services/redis_client.py backend/tests/test_redis.py
git commit -m "feat(redis): helpers for per-user sync state (repos, PRs, last_sync, lock)"
```

### Task 5: `sync_user_prs` orchestrator

**Objective:** Glue: list user repos, for each repo list merged PRs since last sync, for each new PR fetch diff → extract → cache, return summary.

**Files:**
- Create: `backend/services/sync.py`

**Step 1 — Write failing test** in `backend/tests/test_sync.py`:

```python
import pytest
from backend.services.sync import sync_user_prs


@pytest.mark.asyncio
async def test_sync_user_prs_processes_new_prs(monkeypatch):
    """End-to-end: one repo, one new PR, no prior sync."""
    monkeypatch.setattr(
        "backend.services.sync.list_user_repos",
        lambda token: [{"full_name": "octocat/hello"}],
    )
    monkeypatch.setattr(
        "backend.services.sync.list_merged_prs",
        lambda token, repo, since: [
            {"number": 42, "merged_at": "2026-06-01T00:00:00Z",
             "user": {"id": 9}, "html_url": "https://github.com/octocat/hello/pull/42"}
        ],
    )
    monkeypatch.setattr(
        "backend.services.sync.fetch_pr_diff",
        lambda token, repo, n: "diff --git a/x.py b/x.py\n+def add(a, b):\n+    return a + b\n",
    )

    summary = await sync_user_prs("ghp_test", "9")
    assert summary["repos_seen"] == 1
    assert summary["prs_seen"] == 1
    assert summary["prs_processed"] == 1
    assert summary["prs_skipped"] == 0
```

**Step 2 — Run, expect ImportError**

**Step 3 — Implement**

```python
# backend/services/sync.py
import time

import sentry_sdk

from backend.services.claude import extract_concepts_and_cache
from backend.services.diff_parser import clean_diff, fetch_and_parse_diff
from backend.services.github_oauth import (
    fetch_pr_diff,
    list_merged_prs,
    list_user_repos,
)
from backend.services.redis_client import (
    acquire_sync_lock,
    add_user_repo,
    get_last_sync,
    list_processed_prs,
    mark_pr_processed,
    release_sync_lock,
    set_last_sync,
)

# First sync: pull the last 7 days. After that, only since the last successful sync.
INITIAL_LOOKBACK_SECONDS = 7 * 24 * 60 * 60


async def sync_user_prs(access_token: str, user_id: str) -> dict:
    """
    Pull all merged PRs the user has authored since the last sync, ingest each.
    Idempotent: re-running produces no new concepts.
    """
    if not await acquire_sync_lock(user_id):
        return {"status": "already_in_progress"}

    summary = {"repos_seen": 0, "prs_seen": 0, "prs_processed": 0, "prs_skipped": 0, "errors": []}

    try:
        with sentry_sdk.start_transaction(op="sync", name=f"sync {user_id}"):
            since_ts = await get_last_sync(user_id) or (int(time.time()) - INITIAL_LOOKBACK_SECONDS)
            since_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(since_ts))

            already_seen = {p["pr_number"] for p in await list_processed_prs(user_id)}
            repos = await list_user_repos(access_token)
            summary["repos_seen"] = len(repos)

            for repo in repos:
                full_name = repo["full_name"]
                await add_user_repo(user_id, full_name)
                try:
                    prs = await list_merged_prs(access_token, full_name, since=since_iso)
                except Exception as e:
                    summary["errors"].append(f"{full_name}: {e!r}")
                    sentry_sdk.capture_exception(e)
                    continue
                for pr in prs:
                    summary["prs_seen"] += 1
                    if pr["number"] in already_seen:
                        summary["prs_skipped"] += 1
                        continue
                    try:
                        raw = await fetch_pr_diff(access_token, full_name, pr["number"])
                        cleaned = clean_diff(raw)
                        if not cleaned:
                            summary["prs_skipped"] += 1
                            await mark_pr_processed(
                                user_id, repo=full_name,
                                pr_number=pr["number"], merged_at=pr["merged_at"],
                            )
                            continue
                        await extract_concepts_and_cache(cleaned, user_id, pr["number"])
                        await mark_pr_processed(
                            user_id, repo=full_name,
                            pr_number=pr["number"], merged_at=pr["merged_at"],
                        )
                        summary["prs_processed"] += 1
                    except Exception as e:
                        summary["errors"].append(f"#{pr['number']}: {e!r}")
                        sentry_sdk.capture_exception(e)

            await set_last_sync(user_id, int(time.time()))
    finally:
        await release_sync_lock(user_id)

    return summary
```

**Step 4 — Run, expect PASS**

**Step 5 — Commit**

```bash
git add backend/services/sync.py backend/tests/test_sync.py
git commit -m "feat(sync): orchestrator that pulls merged PRs and runs the ingest pipeline"
```

### Task 6: `routers/sync.py` exposes `POST /api/sync` and `GET /api/sync/status`

**Objective:** Public endpoints, auth-gated, thin wrapper around `sync_user_prs`.

**Files:**
- Create: `backend/routers/sync.py`

**Step 1 — Write failing test** (extends `backend/tests/test_sync.py`):

```python
def test_post_sync_requires_auth():
    from fastapi.testclient import TestClient
    from backend.main import app
    client = TestClient(app)
    r = client.post("/api/sync")
    assert r.status_code == 401


def test_get_sync_status_returns_last_sync(monkeypatch):
    from fastapi.testclient import TestClient
    from backend.main import app
    from backend.services.redis_client import set_last_sync
    import asyncio

    async def fake_get_auth_user():
        return {"id": "9", "login": "octocat", "token": "ghp_test"}

    monkeypatch.setattr("backend.dependencies.auth.get_current_user", fake_get_auth_user)
    asyncio.run(set_last_sync("9", 1_700_000_000))

    client = TestClient(app)
    r = client.get("/api/sync/status", headers={"Authorization": "Bearer x"})
    assert r.status_code == 200
    body = r.json()
    assert body["last_sync"] == 1_700_000_000
```

**Step 2 — Run, expect ImportError on router**

**Step 3 — Implement**

```python
# backend/routers/sync.py
from datetime import datetime, timezone

from fastapi import APIRouter, Depends

from backend.dependencies.auth import get_current_user
from backend.services.redis_client import get_last_sync
from backend.services.sync import sync_user_prs

router = APIRouter()


@router.post("/sync")
async def trigger_sync(user=Depends(get_current_user)):
    """Pull all merged PRs the signed-in user has authored since the last sync."""
    summary = await sync_user_prs(user["token"], user["id"])
    return {"user": {"id": user["id"], "login": user["login"]}, "summary": summary}


@router.get("/sync/status")
async def sync_status(user=Depends(get_current_user)):
    last = await get_last_sync(user["id"])
    return {
        "user": {"id": user["id"], "login": user["login"]},
        "last_sync": last,
        "last_sync_iso": datetime.fromtimestamp(last, tz=timezone.utc).isoformat() if last else None,
    }
```

**Step 4 — Run, expect PASS**

**Step 5 — Commit**

```bash
git add backend/routers/sync.py backend/tests/test_sync.py
git commit -m "feat(routers): POST /api/sync and GET /api/sync/status (auth-gated)"
```

### Task 7: Wire the new router into `main.py`; remove webhook

**Files:**
- Modify: `backend/main.py` (lines 1-11)

```python
import backend.sentry_init  # noqa: F401  — MUST be the first import (Sentry init)
from fastapi import FastAPI

from backend.routers import concepts, enrich, quiz, schedule, sync

app = FastAPI(title="VibeSchool Backend")
app.include_router(sync.router, prefix="/api")
app.include_router(concepts.router, prefix="/api")
app.include_router(quiz.router, prefix="/api")
app.include_router(schedule.router, prefix="/api")
app.include_router(enrich.router, prefix="/api")  # P1


@app.get("/health")
async def health():
    return {"status": "ok"}
```

**Verify:** `python -c "from backend.main import app; print(app.title)"` prints `VibeSchool Backend`.

**Commit:**

```bash
git add backend/main.py
git commit -m "refactor(main): mount sync router, drop webhook"
```

### Task 8: Update protected routers to derive `user_id` from auth

**Files:**
- Modify: `backend/routers/concepts.py`
- Modify: `backend/routers/quiz.py`
- Modify: `backend/routers/schedule.py`
- Modify: `backend/routers/enrich.py`

**concepts.py** (was 12 lines):

```python
from fastapi import APIRouter, Depends

from backend.dependencies.auth import get_current_user
from backend.services.redis_client import get_due_concepts

router = APIRouter()


@router.get("/concepts")
async def list_due_concepts(user=Depends(get_current_user)):
    """Return all concepts currently due for review for the signed-in user."""
    due = await get_due_concepts(user["id"])
    return {"user_id": user["id"], "due": due, "count": len(due)}
```

**quiz.py** — `GradeRequest` loses `user_id`; the endpoint pulls it from auth:

```python
class GradeRequest(BaseModel):
    concept_id: str
    transcript: str

@router.post("/grade")
async def grade(req: GradeRequest, user=Depends(get_current_user)):
    quiz = await get_quiz_content(user["id"], req.concept_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Concept not found in Redis")
    # ... unchanged body, but pass user["id"] to update_sm2_state
```

**schedule.py** — same pattern: drop `user_id` and `user_calendar_id` from `ScheduleRequest`. The frontend already has the calendar id (from Poke API), keep that as a body field; only `user_id` is derived from auth.

**enrich.py** — same pattern.

**Tests:** update `backend/tests/test_redis.py` calls to `get_due_concepts(user_id)` (no router change needed for direct service tests; the service signature is unchanged). Add `backend/tests/test_auth_router.py` with one test per endpoint asserting that an unauthenticated request returns 401.

**Commit per file or batched:** `git commit -m "refactor(routers): derive user_id from auth, drop path/body fields"`.

### Task 9: Drop webhook code and `GITHUB_WEBHOOK_SECRET`

**Files:**
- Delete: `backend/routers/webhook.py`
- Delete: `backend/tests/test_webhook.py`
- Delete: `backend/tests/fixtures/pr_payload.json` (only used by webhook test)
- Modify: `backend/config.py` — remove `GITHUB_WEBHOOK_SECRET = _require("GITHUB_WEBHOOK_SECRET")`
- Modify: `backend/.env.example` — remove `GITHUB_WEBHOOK_SECRET=`
- Modify: `backend/PLAN.md` — note that A1 is now `services/github_oauth.py` + `routers/sync.py`

**Verify:** `grep -r "webhook" backend/` returns only the comment in `backend/main.py` (none, since we deleted it). `python -c "from backend.config import GITHUB_WEBHOOK_SECRET"` should raise `ImportError`.

**Commit:**

```bash
git rm backend/routers/webhook.py backend/tests/test_webhook.py backend/tests/fixtures/pr_payload.json
git add backend/config.py backend/.env.example backend/PLAN.md
git commit -m "refactor: remove webhook router and GITHUB_WEBHOOK_SECRET"
```

### Task 10: Full test suite + smoke

```bash
pytest
# expected: 41-45 passed, 0 failed
```

If `test_bear2.py::test_live_compression` is still flaky, fix the bear2 contract per `AGENTS/vibeschool_audit_issues.md` P0-2 first — orthogonal to this refactor but in the same release.

**Commit:** no code change; this is the gate. If anything fails, add the fix as its own commit.

### Task 11: Frontend `apiFetch` helper

**Files:**
- Create: `frontend/lib/api.ts`

```typescript
// frontend/lib/api.ts
const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit & { accessToken?: string } = {}
): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Content-Type", "application/json");
  if (init.accessToken) headers.set("Authorization", `Bearer ${init.accessToken}`);
  const r = await fetch(`${BACKEND}${path}`, { ...init, headers });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`API ${r.status} ${path}: ${body}`);
  }
  return r.json() as Promise<T>;
}
```

**Commit:** `git add frontend/lib/api.ts && git commit -m "feat(frontend): apiFetch helper that injects the NextAuth bearer token"`.

### Task 12: Frontend `dashboard/page.tsx` — real fetch + sync button

**Files:**
- Modify: `frontend/app/dashboard/page.tsx`
- Modify: `frontend/types/next-auth.d.ts` (add `user.id`)

**Changes:**
- Delete the `MOCK_PRS` constant and the related interfaces (or keep them behind a `process.env.NEXT_PUBLIC_USE_MOCKS` flag for offline dev).
- Add a `useEffect` that calls `GET /api/concepts` and `GET /api/sync/status` on mount, with a `loading` state.
- Add a "Sync now" button next to "Sign out" that POSTs to `/api/sync` and refreshes the list.
- Keep the existing render code; just feed it from state instead of `MOCK_PRS`.

**Verify:** `cd frontend && bun run build` succeeds; `npx tsc --noEmit` clean; `npx eslint app types lib` clean.

**Commit:** `git commit -m "feat(dashboard): real /api/concepts + /api/sync, drop mocks"`.

### Task 13: Documentation

**Files:**
- Modify: `AGENTS/vibeschool_agent_plan.md` — prepend a 5-line note explaining the refactor
- Modify: `AGENTS/vibeschool_audit_issues.md` — mark P0-1 (missing `__init__.py` — actually unrelated, leave), P1-4 (no auth) as resolved by Task 1+8
- Modify: `RENAME.md` — note that `NEXTAUTH_URL` callback is no longer relevant (the backend talks to GitHub directly, not GitHub to backend)

**Commit:** `git commit -m "docs: reflect OAuth refactor in plan and audit"`.

---

## Tests & Validation Summary

| Layer | Test | What it proves |
|---|---|---|
| Unit | `tests/test_auth.py` | Token validation, header parsing |
| Unit | `tests/test_github_oauth.py` | Pagination, filter, headers |
| Unit | `tests/test_redis.py` (extended) | New helpers work via fakeredis |
| Unit | `tests/test_sync.py` | Orchestrator handles new + duplicate + empty diffs |
| Integration | `tests/test_e2e.py` (unchanged) | Full ingest still works via `extract_concepts_and_cache` |
| Smoke | `pytest` | 41+ green |
| Build | `cd frontend && bun run build` | Dashboard compiles with real fetch |
| Type | `cd frontend && npx tsc --noEmit` | No new TS errors |
| Lint | `cd frontend && npx eslint app types lib` | No new warnings |
| Manual | `python -m uvicorn backend.main:app --reload` then visit `http://localhost:3000`, sign in, click "Sync now" | End-to-end |

---

## Risks, Tradeoffs, Open Questions

### Risks

1. **GitHub rate limits on the user's token.** 5,000 req/hr is plenty for one user, but a sync that lists hundreds of repos and paginates 100 PRs per page could burn through 10+ calls. Mitigation: cache `user:{user_id}:repos` for the duration of the sync, and only call `list_merged_prs` for repos the user has actually pushed to (filter by `permissions.push`).
2. **The `get_current_user` dependency hits GitHub on every request.** That's a 50-200ms tax per API call. Mitigation: cache the `{id, login}` tuple in Redis for 5 minutes keyed by token hash. (Out of scope for this plan; add a one-line cache wrapper if it bites.)
3. **Long sync = client timeout.** A user with 50 repos × 100 PRs could take minutes. Mitigation: return `{status: "accepted"}` immediately and let the dashboard poll `GET /api/sync/status`. Out of scope for v1; document as a follow-up.

### Tradeoffs accepted

- **No cron / no background refresh.** Sync happens on demand. Tradeoff: if a PR is merged while the user is offline, it won't appear until next sync. Acceptable for a learning tool — there's no SLA.
- **Access token sent per request, not stored.** Frontend holds it; backend only sees it during a request. Tradeoff: no server-side revocation, but the same risk profile as the current frontend (which already holds it in the session). Acceptable for the hackathon.
- **`user_id` semantics shift.** Was "PR author GitHub id", now "signed-in user GitHub id". These are the same in 95% of cases (the typical user is the author). Document the change in the agent plan.

### Open questions (for you to confirm)

1. **Repo filter:** sync *all* repos the user has push access to, or show a "Select repos" UI on first sign-in? (Default: all. YAGNI.) ✅ **RESOLVED: all.**
2. **Cross-author PRs:** if a user signs in and selects a teammate's PR to review (say, a PR they approved), should the sync include it? (Default: no — only the signed-in user's authored PRs. Matches the "learn from your own code" tagline.) ✅ **RESOLVED (FLIPPED): yes — include all merged PRs in the user's accessible repos. "Learn from your team's code" is the better tagline.**
3. **Token storage in production:** for the demo this is fine. For the actual hackathon submission, do you want a server-side token store (encrypted in Redis or a `tokens` table)? (Default: no, defer to a follow-up issue.) ✅ **RESOLVED (FLIPPED): server-side Fernet-encrypted store keyed by `user_id`, mandatory in this iteration. See `backend/services/token_store.py` (Task 1.5).**
4. **Sync trigger:** on dashboard mount, manual button, or both? (Default: both, with the button labeled "Sync now" and the mount-side call debounced so it doesn't fire on every page nav.) ✅ **RESOLVED: both.**

---

## Execution Handoff

When you're ready, dispatch one subagent per task using the `subagent-driven-development` pattern. Each subagent gets:

- The single task block above (e.g. "Task 5: `sync_user_prs` orchestrator")
- A reminder to write the test first and run it red before implementing
- The exact verification command and expected output

After all 14 tasks land and `pytest` is green + `bun run build` is green, the refactor is shippable. The webhook code path is fully gone; the demo flow is: visit `/`, sign in with GitHub, land on `/dashboard`, click "Sync now", watch the cards populate.
