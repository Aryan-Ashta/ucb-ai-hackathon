"""
Orchestrator for the OAuth ingestion path.

The webhook used to fire-and-forget one PR at a time. The OAuth path
instead runs on demand: `sync_user_history(access_token, user_id)` lists
every repo the user can push to, walks the full merged-PR history AND the
recent commit history of each repo, and runs each new diff through the
unchanged Bear-2 -> Claude -> Redis pipeline.

Idempotent: re-running produces no new concepts because processed items
(PRs and commits) are tracked in `user:{user_id}:prs` (Redis HASH) with
`pr_number` or `c-{sha_short}` keys. For an already-synced user, every
previously-processed item is skipped locally before any network call.

Concurrency: a per-user Redis lock prevents two simultaneous syncs from
double-billing Claude. The lock auto-releases after 5 min if the caller
dies mid-sync.
"""
import time

import sentry_sdk

from backend.services.claude import extract_concepts_and_cache
from backend.services.diff_parser import clean_diff
from backend.services.github_oauth import (
    fetch_commit_diff,
    fetch_pr_diff,
    list_commits,
    list_merged_prs,
    list_user_repos,
)
from backend.services.redis_client import (
    acquire_sync_lock,
    add_user_repo,
    list_processed_prs,
    mark_commit_processed,
    mark_pr_processed,
    release_sync_lock,
    set_last_sync,
)

# Per-repo cap on commits ingested per sync. Solo repos with thousands of
# commits would otherwise produce an explosion of Claude calls. 100 is
# enough to demo the loop end-to-end for any single repo and keeps the
# sync wall-clock under a minute for a typical repo.
DEFAULT_MAX_COMMITS_PER_REPO = 100


async def _ingest_pr(
    *,
    access_token: str,
    user_id: str,
    full_name: str,
    pr: dict,
    summary: dict,
) -> None:
    """Run one PR through Bear-2 → Claude → Redis and record idempotency.

    prs_seen is incremented by the outer loop in sync_user_history (so
    every PR returned by the API counts, including ones we'll skip).
    """
    try:
        raw = await fetch_pr_diff(access_token, full_name, pr["number"])
        cleaned = clean_diff(raw)
        if not cleaned:
            await mark_pr_processed(
                user_id, repo=full_name,
                pr_number=pr["number"], merged_at=pr["merged_at"],
            )
            summary["prs_skipped"] += 1
            return
        await extract_concepts_and_cache(
            cleaned, user_id, pr["number"],
            repo=full_name, pr_title=pr.get("title", ""),
        )
        await mark_pr_processed(
            user_id, repo=full_name,
            pr_number=pr["number"], merged_at=pr["merged_at"],
        )
        summary["prs_processed"] += 1
    except Exception as e:
        summary["errors"].append(f"{full_name}#{pr['number']}: {e!r}")
        sentry_sdk.capture_exception(e)


async def _ingest_commit(
    *,
    access_token: str,
    user_id: str,
    full_name: str,
    commit: dict,
    summary: dict,
    max_commits: int,
) -> None:
    """Run one commit through Bear-2 → Claude → Redis and record idempotency.

    A commit's diff is the same shape as a PR's diff (GitHub returns the
    `application/vnd.github.v3.diff` media type for both endpoints), so
    the existing clean_diff + extract_concepts_and_cache pipeline handles
    it without changes — we just pass the SHA (a string) where the
    pipeline expects a source identifier.

    commits_seen is incremented by the outer loop in sync_user_history.
    """
    sha = commit["sha"]
    if summary["commits_seen"] > max_commits:
        return  # hard cap; we already started paging past the limit
    try:
        raw = await fetch_commit_diff(access_token, full_name, sha)
        cleaned = clean_diff(raw)
        committed_at = commit.get("commit", {}).get("author", {}).get("date", "")
        commit_msg = commit.get("commit", {}).get("message", "").split("\n", 1)[0]
        if not cleaned:
            await mark_commit_processed(
                user_id, repo=full_name,
                commit_sha=sha, committed_at=committed_at,
            )
            summary["commits_skipped"] += 1
            return
        await extract_concepts_and_cache(
            cleaned, user_id, sha,
            repo=full_name, pr_title=commit_msg,
        )
        await mark_commit_processed(
            user_id, repo=full_name,
            commit_sha=sha, committed_at=committed_at,
        )
        summary["commits_processed"] += 1
    except Exception as e:
        summary["errors"].append(f"{full_name}@{sha[:7]}: {e!r}")
        sentry_sdk.capture_exception(e)


async def sync_user_history(
    access_token: str,
    user_id: str,
    *,
    max_commits_per_repo: int = DEFAULT_MAX_COMMITS_PER_REPO,
) -> dict:
    """
    Pull all merged PRs and recent commits the user has access to
    (full PR history + capped recent commits per repo) and ingest each
    not-yet-seen item. Returns a summary dict with per-stage counts and
    any per-repo/per-item errors encountered.
    """
    if not await acquire_sync_lock(user_id):
        return {"status": "already_in_progress"}

    summary: dict = {
        "status": "ok",
        "repos_seen": 0,
        "prs_seen": 0,
        "prs_processed": 0,
        "prs_skipped": 0,
        "commits_seen": 0,
        "commits_processed": 0,
        "commits_skipped": 0,
        "errors": [],
    }

    try:
        with sentry_sdk.start_transaction(op="sync", name=f"sync {user_id}"):
            already_seen_prs: set[int] = set()
            already_seen_commits: set[str] = set()
            for item in await list_processed_prs(user_id):
                if item["source_type"] == "pr":
                    already_seen_prs.add(item["key"])
                else:
                    already_seen_commits.add(item["key"])

            try:
                repos = await list_user_repos(access_token)
            except Exception as e:
                summary["status"] = "error"
                summary["errors"].append(f"list_user_repos: {e!r}")
                sentry_sdk.capture_exception(e)
                return summary
            summary["repos_seen"] = len(repos)

            for repo in repos:
                full_name = repo["full_name"]
                await add_user_repo(user_id, full_name)

                # PRs (full history; idempotency via user:{u}:prs HASH).
                # prs_seen counts every PR returned by the API, even those
                # we end up skipping — matches the pre-commit semantic and
                # matches how a user would read the summary ("GitHub says
                # there are N PRs in this repo").
                try:
                    prs = await list_merged_prs(access_token, full_name, since_iso=None)
                except Exception as e:
                    summary["errors"].append(f"{full_name} PRs: {e!r}")
                    sentry_sdk.capture_exception(e)
                    prs = []
                for pr in prs:
                    summary["prs_seen"] += 1
                    if pr["number"] in already_seen_prs:
                        summary["prs_skipped"] += 1
                        continue
                    await _ingest_pr(
                        access_token=access_token,
                        user_id=user_id, full_name=full_name,
                        pr=pr, summary=summary,
                    )

                # Commits (capped recent; idempotency via the same HASH,
                # keys prefixed "c-" to distinguish from PR numbers).
                try:
                    commits = await list_commits(
                        access_token, full_name,
                        max_commits=max_commits_per_repo,
                    )
                except Exception as e:
                    summary["errors"].append(f"{full_name} commits: {e!r}")
                    sentry_sdk.capture_exception(e)
                    commits = []
                for commit in commits:
                    summary["commits_seen"] += 1
                    short_sha = commit["sha"][:7]
                    if short_sha in already_seen_commits:
                        summary["commits_skipped"] += 1
                        continue
                    await _ingest_commit(
                        access_token=access_token,
                        user_id=user_id, full_name=full_name,
                        commit=commit, summary=summary,
                        max_commits=max_commits_per_repo,
                    )

            await set_last_sync(user_id, int(time.time()))
    finally:
        await release_sync_lock(user_id)

    return summary


# Backward-compatible alias — older code/tests call sync_user_prs.
async def sync_user_prs(access_token: str, user_id: str) -> dict:
    """Deprecated alias for sync_user_history; kept so existing callers don't break."""
    return await sync_user_history(access_token, user_id)
