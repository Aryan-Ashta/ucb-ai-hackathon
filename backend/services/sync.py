"""
Orchestrator for the OAuth ingestion path.

The webhook used to fire-and-forget one PR at a time. The OAuth path
instead runs on demand: `sync_user_prs(access_token, user_id)` lists every
repo the user can push to, walks the merged-PR list since the last sync,
and runs each new diff through the unchanged Bear-2 -> Claude -> Redis
pipeline.

Idempotent: re-running produces no new concepts because processed PRs
are tracked in `user:{user_id}:prs` (Redis HASH).

Concurrency: a per-user Redis lock prevents two simultaneous syncs from
double-billing Claude. The lock auto-releases after 5 min if the caller
dies mid-sync.
"""
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
INITIAL_LOOKBACK_SECONDS: int = 7 * 24 * 60 * 60


def _since_iso(ts: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


async def sync_user_prs(access_token: str, user_id: str) -> dict:
    """
    Pull all merged PRs the user has access to since the last sync, ingest
    each new one. Returns a summary dict with per-stage counts and any
    per-repo/per-PR errors encountered.
    """
    if not await acquire_sync_lock(user_id):
        return {"status": "already_in_progress"}

    summary: dict = {
        "status": "ok",
        "repos_seen": 0,
        "prs_seen": 0,
        "prs_processed": 0,
        "prs_skipped": 0,
        "errors": [],
    }

    try:
        with sentry_sdk.start_transaction(op="sync", name=f"sync {user_id}"):
            last = await get_last_sync(user_id)
            since_ts = last or (int(time.time()) - INITIAL_LOOKBACK_SECONDS)
            since_iso = _since_iso(since_ts)

            already_seen = {p["pr_number"] for p in await list_processed_prs(user_id)}

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
                try:
                    prs = await list_merged_prs(access_token, full_name, since_iso=since_iso)
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
                            # Nothing useful in the diff; mark it processed so
                            # we don't re-fetch it on every sync, but skip the
                            # Claude call.
                            await mark_pr_processed(
                                user_id, repo=full_name,
                                pr_number=pr["number"], merged_at=pr["merged_at"],
                            )
                            summary["prs_skipped"] += 1
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
