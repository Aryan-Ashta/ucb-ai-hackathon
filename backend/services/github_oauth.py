"""
GitHub API client for OAuth-user-token-authenticated calls.

The webhook path used to call `GET /repos/{owner}/{repo}/pulls/{n}` with a
server-wide `GITHUB_TOKEN`. The OAuth refactor instead passes the signed-in
user's `access_token` (from NextAuth) on every call. Per Q2 decision, this
service does NOT filter merged PRs by author -- it returns every merged PR
in the repo since the requested timestamp, so the team can learn from each
other's merges ("learn from your team's code").
"""
from datetime import datetime

import httpx
import sentry_sdk

from backend.config import GITHUB_API_BASE


# Safety cap on pagination for a single repo: 50 pages × 100/page = 5,000 PRs.
# Without `since_iso` there is no early-exit on the sorted-desc-by-updated
# ordering, so the loop would otherwise walk every page the API returns.
MAX_PAGES = 50


def _headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


async def _request(
    token: str,
    url: str,
    *,
    params: dict | None = None,
    extra_headers: dict | None = None,
    accept: str | None = None,
    timeout: float = 15.0,
) -> httpx.Response:
    """Single seam for all GitHub calls; tests patch this."""
    headers = _headers(token)
    if accept:
        headers["Accept"] = accept
    if extra_headers:
        headers.update(extra_headers)
    async with httpx.AsyncClient() as client:
        r = await client.get(url, headers=headers, params=params, timeout=timeout)
        r.raise_for_status()
        return r


async def get_authenticated_user(token: str) -> dict:
    """Resolve a token to its GitHub user record. Used to compute user_id."""
    r = await _request(token, f"{GITHUB_API_BASE}/user", timeout=10.0)
    return r.json()


async def list_user_repos(token: str) -> list[dict]:
    """
    All repos the user can push to (owner, collaborator, or org member).
    The result is a superset of what we'll actually sync; the orchestrator
    can re-filter on `permissions.push` if it wants to be more selective.
    """
    repos: list[dict] = []
    page = 1
    while True:
        r = await _request(
            token,
            f"{GITHUB_API_BASE}/user/repos",
            params={
                "per_page": 100,
                "page": page,
                "affiliation": "owner,collaborator,organization_member",
            },
        )
        batch = r.json()
        if not batch:
            return repos
        repos.extend(batch)
        page += 1


async def list_merged_prs(
    token: str, repo_full_name: str, *, since_iso: str | None = None
) -> list[dict]:
    """
    All merged PRs in this repo, regardless of who authored them.

    If `since_iso` is provided, results are filtered to `merged_at >= since_iso`
    and pagination stops early (results are sorted descending by `updated`, so
    the first older-than-since PR marks the end). If `since_iso` is None, every
    merged PR in the repo is returned — capped at `MAX_PAGES` requests as a
    safety bound against a user with thousands of merged PRs.
    """
    since_ts = (
        datetime.fromisoformat(since_iso.replace("Z", "+00:00"))
        if since_iso is not None
        else None
    )
    out: list[dict] = []
    page = 1
    while page <= MAX_PAGES:
        r = await _request(
            token,
            f"{GITHUB_API_BASE}/repos/{repo_full_name}/pulls",
            params={
                "state": "closed",
                "per_page": 100,
                "page": page,
                "sort": "updated",
                "direction": "desc",
            },
        )
        batch = r.json()
        if not batch:
            return out
        for pr in batch:
            if not pr.get("merged_at"):
                continue
            if since_ts is not None:
                merged_ts = datetime.fromisoformat(
                    pr["merged_at"].replace("Z", "+00:00")
                )
                if merged_ts < since_ts:
                    return out  # sorted desc by updated; can stop here
            out.append(pr)
        page += 1
    return out


async def fetch_pr_diff(token: str, repo_full_name: str, pr_number: int) -> str:
    """Fetch the unified diff for a single PR. Returns the raw diff text."""
    r = await _request(
        token,
        f"{GITHUB_API_BASE}/repos/{repo_full_name}/pulls/{pr_number}",
        accept="application/vnd.github.v3.diff",
    )
    sentry_sdk.add_breadcrumb(
        category="github_oauth",
        level="info",
        message=f"Fetched diff for {repo_full_name}#{pr_number}: {len(r.text)} chars",
    )
    return r.text
