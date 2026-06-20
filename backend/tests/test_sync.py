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

    async def fake_extract(raw_diff, user_id, pr_number):
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

    async def fake_extract(raw_diff, user_id, pr_number):
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

    async def fake_extract(raw_diff, user_id, pr_number):
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
