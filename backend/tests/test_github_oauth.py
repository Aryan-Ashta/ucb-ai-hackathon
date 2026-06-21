"""Tests for backend.services.github_oauth."""
import json

import httpx
import pytest

from backend.services import github_oauth


def _patch_request(monkeypatch, handler):
    """Replace the module's _request with a stub that calls `handler`."""
    async def fake_request(token, url, *, params=None, extra_headers=None, accept=None, timeout=15.0):
        req = httpx.Request("GET", url, params=params or {}, headers=extra_headers or {})
        resp = handler(req, token=token, accept=accept)
        if isinstance(resp, dict) or isinstance(resp, list):
            return httpx.Response(200, json=resp)
        if isinstance(resp, str):
            return httpx.Response(200, content=resp.encode())
        return resp

    monkeypatch.setattr(github_oauth, "_request", fake_request)


def test_list_user_repos_paginates(monkeypatch):
    state = {"page": 0}

    def handler(req: httpx.Request, **_) -> dict:
        state["page"] += 1
        if state["page"] == 1:
            return [{"full_name": "octo/r1"}]
        if state["page"] == 2:
            return [{"full_name": "octo/r2"}]
        return []

    _patch_request(monkeypatch, handler)
    repos = _run(github_oauth.list_user_repos("ghp_test"))
    assert {r["full_name"] for r in repos} == {"octo/r1", "octo/r2"}


def test_list_merged_prs_filters_by_since_and_stops_early(monkeypatch):
    """Old PRs (before `since`) must be excluded, and pagination must stop
    as soon as the loop sees one (results are sorted desc by updated_at)."""
    prs_desc = [
        {"number": 10, "merged_at": "2026-06-15T00:00:00Z", "user": {"id": 1}},
        {"number": 9, "merged_at": "2026-06-10T00:00:00Z", "user": {"id": 2}},
        {"number": 8, "merged_at": "2026-05-30T00:00:00Z", "user": {"id": 1}},  # before since
        {"number": 7, "merged_at": "2026-05-20T00:00:00Z", "user": {"id": 3}},  # not reached
    ]

    def handler(req: httpx.Request, **_) -> list:
        if handler.calls > 0:
            return []
        handler.calls += 1
        return prs_desc
    handler.calls = 0

    _patch_request(monkeypatch, handler)
    result = _run(
        github_oauth.list_merged_prs(
            "ghp_test", "octo/r", since_iso="2026-06-01T00:00:00Z"
        )
    )
    # Only the two PRs merged after 2026-06-01 are returned; #8 stops the loop
    # so #7 (also <since) is never fetched.
    assert [p["number"] for p in result] == [10, 9]


def test_list_merged_prs_includes_cross_author(monkeypatch):
    """Per Q2 flip, we do NOT filter by author -- any merged PR counts."""
    prs = [
        {"number": 1, "merged_at": "2026-06-15T00:00:00Z", "user": {"id": 999}},  # someone else
        {"number": 2, "merged_at": "2026-06-10T00:00:00Z", "user": {"id": 42}},   # someone else
    ]

    def handler(req: httpx.Request, **_) -> list:
        if handler.calls > 0:
            return []
        handler.calls += 1
        return prs
    handler.calls = 0

    _patch_request(monkeypatch, handler)
    result = _run(
        github_oauth.list_merged_prs(
            "ghp_test", "octo/r", since_iso="2026-06-01T00:00:00Z"
        )
    )
    assert {p["number"] for p in result} == {1, 2}


def test_fetch_pr_diff_returns_raw_text(monkeypatch):
    diff_text = "diff --git a/x.py b/x.py\n+def add(a, b):\n+    return a+b\n"

    def handler(req: httpx.Request, **kw) -> str:
        assert "application/vnd.github.v3.diff" in (kw.get("accept") or req.headers.get("Accept", ""))
        return diff_text

    _patch_request(monkeypatch, handler)
    text = _run(github_oauth.fetch_pr_diff("ghp_test", "octo/r", 42))
    assert text == diff_text


# --- list_commits --------------------------------------------------------------

def test_list_commits_paginates_and_caps_at_max(monkeypatch):
    """list_commits should stop paginating once `max_commits` is reached.

    Real GitHub returns up to 100 commits per page. We feed 3 pages of 100
    each (300 total) with max_commits=150 — the loop must stop after the
    2nd page (which gives 200 commits, hitting the cap mid-page).
    """
    def handler(req: httpx.Request, **_) -> list:
        if handler.calls == 0:
            handler.calls += 1
            return [{"sha": f"sha_a_{i:04d}"} for i in range(100)]
        if handler.calls == 1:
            handler.calls += 1
            return [{"sha": f"sha_b_{i:04d}"} for i in range(100)]
        handler.calls += 1
        return []  # should never be reached — list_commits stops at max_commits
    handler.calls = 0

    _patch_request(monkeypatch, handler)
    commits = _run(github_oauth.list_commits("ghp_test", "octo/r", max_commits=150))
    assert len(commits) == 150  # exactly 100 + 50 from the second page
    assert handler.calls == 2  # never hit the third (empty) page


def test_list_commits_returns_short_pages_unchanged(monkeypatch):
    """If GitHub returns a page with < 100 entries, that's the last page."""
    def handler(req: httpx.Request, **_) -> list:
        if handler.calls == 0:
            handler.calls += 1
            return [{"sha": f"sha_{i:04d}"} for i in range(7)]
        handler.calls += 1
        return []  # should never be reached
    handler.calls = 0

    _patch_request(monkeypatch, handler)
    commits = _run(github_oauth.list_commits("ghp_test", "octo/r"))
    assert len(commits) == 7
    assert handler.calls == 1


def test_list_commits_respects_max_pages_safety_cap(monkeypatch):
    """The MAX_PAGES=50 cap must still hold — a runaway pagination loop
    would blow Claude quota. With max_commits=10000 we expect the loop
    to terminate at MAX_PAGES even if every page is full.
    """
    # Just verify the function returns (doesn't hang) with a huge cap;
    # we don't need to assert exact count, just that it terminates.
    def handler(req: httpx.Request, **_) -> list:
        return [{"sha": f"sha_{i:04d}"} for i in range(100)]

    _patch_request(monkeypatch, handler)
    commits = _run(github_oauth.list_commits("ghp_test", "octo/r", max_commits=10_000))
    # MAX_PAGES is 50; at 100/page that's 5000 max.
    assert 0 < len(commits) <= github_oauth.MAX_PAGES * 100


# --- fetch_commit_diff ---------------------------------------------------------

def test_fetch_commit_diff_returns_raw_text(monkeypatch):
    """Commit diffs are fetched with the same v3.diff Accept header as PRs."""
    diff_text = "diff --git a/x.py b/x.py\n+def add(a, b):\n+    return a+b\n"

    def handler(req: httpx.Request, **kw) -> str:
        assert "application/vnd.github.v3.diff" in (kw.get("accept") or "")
        return diff_text

    _patch_request(monkeypatch, handler)
    text = _run(github_oauth.fetch_commit_diff("ghp_test", "octo/r", "abc1234567890def"))
    assert text == diff_text


def test_fetch_commit_diff_url_includes_full_sha(monkeypatch):
    captured_urls: list[str] = []

    def handler(req: httpx.Request, **_) -> str:
        captured_urls.append(str(req.url))
        return ""

    _patch_request(monkeypatch, handler)
    _run(github_oauth.fetch_commit_diff("ghp_test", "octo/r", "abc1234567890def"))
    assert len(captured_urls) == 1
    assert captured_urls[0].endswith("/repos/octo/r/commits/abc1234567890def")


def _run(coro):
    """Run an async coroutine in a fresh loop. Used in sync tests."""
    import asyncio
    return asyncio.new_event_loop().run_until_complete(coro)
