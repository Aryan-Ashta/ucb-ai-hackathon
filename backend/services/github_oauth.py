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
from backend.services.http_client import shared_client

_client = shared_client("github_oauth")


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
    r = await _client.get(url, headers=headers, params=params, timeout=timeout)
    r.raise_for_status()
    return r


async def get_authenticated_user(token: str) -> dict:
    """Resolve a token to its GitHub user record. Used to compute user_id."""
    r = await _request(token, f"{GITHUB_API_BASE}/user", timeout=10.0)
    return r.json()


async def list_user_repos(token: str) -> list[dict]:
    """
    All repos the user can push to (owner, collaborator, or org member),
    capped at MAX_PAGES × 100/page = 5,000 repos.

    Without a cap, a user belonging to many orgs (e.g. an enterprise
    account) would walk every page the API returns. P2-B7 closes the
    remaining gap left when the same cap was applied to list_merged_prs
    in `bf11523`.

    Note on early-exit: we can't short-circuit on `len(batch) < per_page`
    because the GitHub API may legitimately return a partial page even
    when more pages exist (the `per_page` parameter is a max, not an
    exact). We rely on the empty-batch terminator + MAX_PAGES bound.
    """
    repos: list[dict] = []
    page = 1
    while page <= MAX_PAGES:
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
    return repos


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


async def list_commits(
    token: str, repo_full_name: str, *, since_iso: str | None = None, max_commits: int = 100
) -> list[dict]:
    """
    Recent commits in this repo, newest first, capped at `max_commits` (default 100).

    We bound the cap aggressively because solo repos with thousands of commits
    would otherwise produce an explosion of Claude calls — one per commit. 100
    is enough to demo the loop end-to-end for any single repo and keeps the
    sync wall-clock under a minute for a typical repo.

    No time-window filter: commits are inherently "recent" by their position
    in the sorted-desc list, so a hard cap is the natural pagination bound.
    (Unlike PRs, we don't paginate to a time floor — we just stop after
    `max_commits`.) The MAX_PAGES safety bound still applies.
    """
    out: list[dict] = []
    page = 1
    while page <= MAX_PAGES and len(out) < max_commits:
        r = await _request(
            token,
            f"{GITHUB_API_BASE}/repos/{repo_full_name}/commits",
            params={
                "per_page": min(100, max_commits - len(out)),
                "page": page,
            },
        )
        batch = r.json()
        if not batch:
            return out
        # Defensive truncation: GitHub's API may return up to 100 items even
        # when per_page asks for fewer. Truncate here so `out` never exceeds
        # `max_commits` regardless of API behaviour.
        remaining = max_commits - len(out)
        out.extend(batch[:remaining])
        if len(batch) < 100 or len(out) >= max_commits:
            return out  # last page OR cap reached
        page += 1
    return out


async def fetch_commit_diff(token: str, repo_full_name: str, sha: str) -> str:
    """Fetch the unified diff for a single commit. Returns the raw diff text.

    The commit endpoint accepts the same `application/vnd.github.v3.diff`
    media type as the PR endpoint, so we reuse the diff format and the
    existing diff_parser.clean_diff pipeline.
    """
    r = await _request(
        token,
        f"{GITHUB_API_BASE}/repos/{repo_full_name}/commits/{sha}",
        accept="application/vnd.github.v3.diff",
    )
    sentry_sdk.add_breadcrumb(
        category="github_oauth",
        level="info",
        message=f"Fetched diff for {repo_full_name}@{sha[:7]}: {len(r.text)} chars",
    )
    return r.text
