"""Tests for backend.services.sync."""
import pytest

from backend.services import sync as sync_mod


@pytest.mark.asyncio
async def test_sync_user_prs_processes_new_prs(monkeypatch, fake_redis):
    """End-to-end: one repo, one new PR, no prior sync."""
    async def _fake_list_repos(token):
        return [{"full_name": "octocat/hello"}]

    monkeypatch.setattr(sync_mod, "list_user_repos", _fake_list_repos)

    async def fake_list_merged_prs(token, repo, *, since_iso):
        return [
            {
                "number": 42,
                "merged_at": "2026-06-01T00:00:00Z",
                "user": {"id": 9},
                "html_url": "https://github.com/octocat/hello/pull/42",
            }
        ]

    monkeypatch.setattr(sync_mod, "list_merged_prs", fake_list_merged_prs)

    async def fake_fetch_pr_diff(token, repo, n):
        return (
            "diff --git a/x.py b/x.py\n"
            "+def add(a, b):\n"
            "+    return a + b\n"
        )

    monkeypatch.setattr(sync_mod, "fetch_pr_diff", fake_fetch_pr_diff)  # already async

    extract_calls = []

    async def fake_extract(raw_diff, user_id, pr_number, repo="", pr_title=""):
        extract_calls.append((user_id, pr_number))
        return []  # empty is fine; we only assert the call happened

    monkeypatch.setattr(sync_mod, "extract_concepts_and_cache", fake_extract)

    summary = await sync_mod.sync_user_prs("ghp_test", "9")

    assert summary["repos_seen"] == 1
    assert summary["prs_seen"] == 1
    assert summary["prs_processed"] == 1
    assert summary["prs_skipped"] == 0
    assert summary["status"] == "ok"
    assert extract_calls == [("9", 42)]


@pytest.mark.asyncio
async def test_sync_user_prs_skips_already_processed(monkeypatch, fake_redis):
    """Re-running a sync must not re-ingest PRs we already processed."""
    from backend.services.redis_client import mark_pr_processed

    # Seed the "already processed" set.
    await mark_pr_processed(
        "u1", repo="octocat/hello", pr_number=42, merged_at="2026-06-01T00:00:00Z"
    )

    async def _fake_list_repos2(token):
        return [{"full_name": "octocat/hello"}]

    monkeypatch.setattr(sync_mod, "list_user_repos", _fake_list_repos2)

    async def fake_list_merged_prs(token, repo, *, since_iso):
        return [{"number": 42, "merged_at": "2026-06-01T00:00:00Z", "user": {"id": 1}}]

    monkeypatch.setattr(sync_mod, "list_merged_prs", fake_list_merged_prs)
    async def _fake_fetch_unused(token, repo, n):
        return "unused"

    monkeypatch.setattr(sync_mod, "fetch_pr_diff", _fake_fetch_unused)

    extract_calls = []

    async def fake_extract(raw_diff, user_id, pr_number, repo="", pr_title=""):
        extract_calls.append(pr_number)
        return []

    monkeypatch.setattr(sync_mod, "extract_concepts_and_cache", fake_extract)

    summary = await sync_mod.sync_user_prs("ghp_test", "u1")
    assert summary["prs_seen"] == 1
    assert summary["prs_skipped"] == 1
    assert summary["prs_processed"] == 0
    assert extract_calls == []  # no Claude calls for the duplicate


@pytest.mark.asyncio
async def test_sync_user_prs_skips_empty_diff(monkeypatch, fake_redis):
    """A PR whose diff contains no code (only whitespace, only binary blobs)
    must be marked processed without calling Claude."""
    async def _fake_list_repos2(token):
        return [{"full_name": "octocat/hello"}]

    monkeypatch.setattr(sync_mod, "list_user_repos", _fake_list_repos2)

    async def fake_list_merged_prs(token, repo, *, since_iso):
        return [{"number": 1, "merged_at": "2026-06-01T00:00:00Z", "user": {"id": 1}}]

    monkeypatch.setattr(sync_mod, "list_merged_prs", fake_list_merged_prs)
    async def _fake_fetch_binary(token, repo, n):
        return "diff --git a/logo.png b/logo.png\nBinary files differ"

    monkeypatch.setattr(sync_mod, "fetch_pr_diff", _fake_fetch_binary)

    extract_calls = []

    async def fake_extract(raw_diff, user_id, pr_number, repo="", pr_title=""):
        extract_calls.append(pr_number)
        return []

    monkeypatch.setattr(sync_mod, "extract_concepts_and_cache", fake_extract)

    summary = await sync_mod.sync_user_prs("ghp_test", "u1")
    assert summary["prs_seen"] == 1
    assert summary["prs_skipped"] == 1
    assert summary["prs_processed"] == 0
    assert extract_calls == []


@pytest.mark.asyncio
async def test_sync_user_prs_returns_already_in_progress_when_locked(monkeypatch, fake_redis):
    """Two simultaneous syncs for the same user: the second must short-circuit."""
    from backend.services.redis_client import acquire_sync_lock, release_sync_lock

    # Pre-acquire the lock so the next call fails to acquire it.
    assert await acquire_sync_lock("u1") is True
    try:
        summary = await sync_mod.sync_user_prs("ghp_test", "u1")
        assert summary["status"] == "already_in_progress"
    finally:
        await release_sync_lock("u1")


@pytest.mark.asyncio
async def test_sync_user_prs_records_per_repo_errors(monkeypatch, fake_redis):
    """A failing repo must not abort the whole sync; its error is recorded."""
    async def _fake_list_repos3(token):
        return [{"full_name": "a/b"}, {"full_name": "c/d"}]

    monkeypatch.setattr(sync_mod, "list_user_repos", _fake_list_repos3)

    async def fake_list_merged_prs(token, repo, *, since_iso):
        if repo == "a/b":
            raise RuntimeError("rate limited")
        return []

    monkeypatch.setattr(sync_mod, "list_merged_prs", fake_list_merged_prs)

    summary = await sync_mod.sync_user_prs("ghp_test", "u1")
    assert summary["repos_seen"] == 2
    assert any("a/b" in e for e in summary["errors"])


@pytest.mark.asyncio
async def test_sync_user_prs_passes_no_since_to_list_merged_prs(monkeypatch, fake_redis):
    """
    Full-history mode: a fresh sync must call list_merged_prs with
    since_iso=None so the GitHub client returns the entire merged-PR history
    (capped at MAX_PAGES). The per-PR hash at user:{user_id}:prs is the only
    idempotency mechanism, so passing since=None is safe correctness-wise.
    """
    from backend.services import github_oauth

    async def _fake_list_repos(token):
        return [{"full_name": "octocat/hello"}]

    monkeypatch.setattr(sync_mod, "list_user_repos", _fake_list_repos)

    calls: list[dict] = []

    async def fake_list_merged_prs(token, repo, *, since_iso):
        calls.append({"repo": repo, "since_iso": since_iso})
        return []

    monkeypatch.setattr(sync_mod, "list_merged_prs", fake_list_merged_prs)

    summary = await sync_mod.sync_user_prs("ghp_test", "u-full-history")
    assert summary["status"] == "ok"
    assert calls, "list_merged_prs should have been called at least once"
    for c in calls:
        assert c["since_iso"] is None, (
            f"full-history sync must pass since_iso=None, got {c['since_iso']!r}"
        )

    # Also exercise list_merged_prs itself with since_iso=None to make sure
    # the new None-handling path in github_oauth doesn't crash and respects
    # MAX_PAGES as a safety cap on pagination.
    class _StubResp:
        def __init__(self, body): self._body = body
        def json(self): return self._body
        def raise_for_status(self): return None

    state = {"n": 0}

    async def fake_request(token, url, *, params=None, extra_headers=None, accept=None, timeout=15.0):
        state["n"] += 1
        # Always return one merged PR per page so pagination runs until the cap.
        return _StubResp([{"number": state["n"], "merged_at": "2020-01-01T00:00:00Z", "user": {"id": 1}}])

    monkeypatch.setattr(github_oauth, "_request", fake_request)
    result = await github_oauth.list_merged_prs("ghp_test", "octo/r", since_iso=None)
    assert state["n"] == github_oauth.MAX_PAGES, (
        f"pagination should cap at MAX_PAGES ({github_oauth.MAX_PAGES}), "
        f"made {state['n']} requests"
    )
    assert len(result) == github_oauth.MAX_PAGES


# --- sync_user_history: commit ingestion ---------------------------------------

@pytest.mark.asyncio
async def test_sync_user_history_ingests_commits_in_addition_to_prs(monkeypatch, fake_redis):
    """The new dual-walk: PRs AND commits per repo. Both go through
    extract_concepts_and_cache; both are recorded for idempotency."""
    async def _fake_list_repos(token):
        return [{"full_name": "solo/myrepo"}]

    monkeypatch.setattr(sync_mod, "list_user_repos", _fake_list_repos)

    # No merged PRs in this solo repo.
    async def fake_list_merged_prs(token, repo, *, since_iso):
        return []

    monkeypatch.setattr(sync_mod, "list_merged_prs", fake_list_merged_prs)

    # But plenty of commits (the solo-repo case this feature was built for).
    async def fake_list_commits(token, repo, *, max_commits=100):
        return [
            {"sha": "abc1234567890aaa", "commit": {"author": {"date": "2026-06-20T00:00:00Z"}, "message": "refactor: dedup the auth helper"}},
            {"sha": "def4567890abcdef", "commit": {"author": {"date": "2026-06-21T00:00:00Z"}, "message": "feat: add cache eviction"}},
        ]

    monkeypatch.setattr(sync_mod, "list_commits", fake_list_commits)

    async def fake_fetch_commit_diff(token, repo, sha):
        return "diff --git a/x.py b/x.py\n+def new():\n+    return 42\n"

    monkeypatch.setattr(sync_mod, "fetch_commit_diff", fake_fetch_commit_diff)

    extract_calls: list[tuple[str, str | int]] = []

    async def fake_extract(raw_diff, user_id, source_id, repo="", pr_title=""):
        extract_calls.append((user_id, source_id))
        return []

    monkeypatch.setattr(sync_mod, "extract_concepts_and_cache", fake_extract)

    summary = await sync_mod.sync_user_history("ghp_test", "u-solo")

    assert summary["status"] == "ok"
    assert summary["prs_seen"] == 0
    assert summary["prs_processed"] == 0
    assert summary["commits_seen"] == 2
    assert summary["commits_processed"] == 2
    assert summary["commits_skipped"] == 0
    # Source IDs passed to extract_concepts_and_cache must be the commit SHAs
    # (strings), not PR numbers — verifies the int|str union discriminator.
    assert extract_calls == [
        ("u-solo", "abc1234567890aaa"),
        ("u-solo", "def4567890abcdef"),
    ]


@pytest.mark.asyncio
async def test_sync_user_history_skips_already_processed_commits(monkeypatch, fake_redis):
    """A commit whose short SHA is already in user:{u}:prs must be skipped."""
    from backend.services.redis_client import mark_commit_processed

    # Seed: one commit already processed in a previous sync.
    await mark_commit_processed(
        "u1", repo="solo/repo",
        commit_sha="abc1234567890aaa", committed_at="2026-06-20T00:00:00Z",
    )

    async def _fake_list_repos(token):
        return [{"full_name": "solo/repo"}]

    monkeypatch.setattr(sync_mod, "list_user_repos", _fake_list_repos)
    monkeypatch.setattr(sync_mod, "list_merged_prs", lambda *a, **kw: [])

    async def fake_list_commits(token, repo, *, max_commits=100):
        return [
            {"sha": "abc1234567890aaa", "commit": {"author": {"date": "2026-06-20T00:00:00Z"}, "message": "already done"}},
            {"sha": "fresh00000000ff", "commit": {"author": {"date": "2026-06-21T00:00:00Z"}, "message": "new work"}},
        ]

    monkeypatch.setattr(sync_mod, "list_commits", fake_list_commits)

    # Must be async — sync.py awaits the result.
    async def fake_fetch_commit_diff(token, repo, sha):
        return "diff --git a/x.py b/x.py\n+def f():\n+    return 42\n"

    monkeypatch.setattr(sync_mod, "fetch_commit_diff", fake_fetch_commit_diff)

    extract_calls: list[str] = []

    async def fake_extract(raw_diff, user_id, source_id, repo="", pr_title=""):
        extract_calls.append(source_id)
        return []

    monkeypatch.setattr(sync_mod, "extract_concepts_and_cache", fake_extract)

    summary = await sync_mod.sync_user_history("ghp_test", "u1")

    assert summary["commits_seen"] == 2  # both are "seen"
    assert summary["commits_skipped"] == 1  # one is already processed
    assert summary["commits_processed"] == 1  # only the new one runs through
    assert extract_calls == ["fresh00000000ff"]


@pytest.mark.asyncio
async def test_sync_user_history_max_commits_per_repo_caps_ingestion(monkeypatch, fake_redis):
    """The per-repo cap must actually be respected by _ingest_commit."""
    async def _fake_list_repos(token):
        return [{"full_name": "active/dev"}]

    monkeypatch.setattr(sync_mod, "list_user_repos", _fake_list_repos)
    monkeypatch.setattr(sync_mod, "list_merged_prs", lambda *a, **kw: [])

    # 50 commits in the repo; we ask for only 5.
    async def fake_list_commits(token, repo, *, max_commits=100):
        return [
            {"sha": f"sha{i:040d}", "commit": {"author": {"date": ""}, "message": ""}}
            for i in range(50)
        ]

    monkeypatch.setattr(sync_mod, "list_commits", fake_list_commits)

    # Must be async.
    async def fake_fetch_commit_diff(token, repo, sha):
        return "diff --git a/x.py b/x.py\n+def f():\n+    return 42\n"

    monkeypatch.setattr(sync_mod, "fetch_commit_diff", fake_fetch_commit_diff)

    async def fake_extract(raw_diff, user_id, source_id, repo="", pr_title=""):
        return []

    monkeypatch.setattr(sync_mod, "extract_concepts_and_cache", fake_extract)

    summary = await sync_mod.sync_user_history(
        "ghp_test", "u-active", max_commits_per_repo=5
    )

    # _ingest_commit hard-caps at the requested limit.
    assert summary["commits_processed"] == 5
