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


def _run(coro):
    """Run an async coroutine in a fresh loop. Used in sync tests."""
    import asyncio
    return asyncio.new_event_loop().run_until_complete(coro)
