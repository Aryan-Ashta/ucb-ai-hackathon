"""
Make every synced concept due for review RIGHT NOW.

Demo helper — useful when you've already graded some concepts and want to
demo the full quiz flow again without waiting days for SM-2 intervals to
elapse. Walks Redis, finds every `concept:*:state` key, rewrites
`next_review` to the current unix timestamp, and re-adds the concept to
the `due:{user_id}` ZSET with the same score.

Usage:
    .venv/bin/python -m backend.scripts.make_all_due
    .venv/bin/python -m backend.scripts.make_all_due --user-id 12345
    .venv/bin/python -m backend.scripts.make_all_due --dry-run
    .venv/bin/python -m backend.scripts.make_all_due --seconds-into-future 30

Notes:
- Uses SCAN (not KEYS) — safe to run against a populated Redis Cloud DB.
- TTL on the rewritten state keys is preserved (7-day REDIS_TTL_SECONDS);
  we SET with KEEPTTL via a pipeline so a concept that's about to expire
  doesn't get a free 7-day extension as a side-effect.
- Idempotent — running it twice is fine; second run is a no-op write.
"""
import argparse
import asyncio
import json
import sys
import time
from collections import defaultdict

from backend.services.redis_client import REDIS_TTL_SECONDS, get_redis

STATE_KEY_PREFIX = "concept:"
STATE_KEY_SUFFIX = ":state"
DUE_KEY_PREFIX = "due:"
# Redis SCAN cursor batch — keeps memory bounded for users with thousands
# of concepts. 500 is a reasonable default; tune via the CLI.
SCAN_BATCH = 500


def _parse_state_key(key: str) -> tuple[str, str] | None:
    """Extract (user_id, concept_id) from `concept:{user_id}:{concept_id}:state`.

    concept_id itself contains colons (format `{user_id}:{pr_number}:{slug}`),
    so we split on the OUTER pair of colons — first segment is `concept`,
    last segment is `state`, everything in between is `{user_id}:{concept_id}`.
    Re-joining the middle with ':' reconstructs the full concept_id.
    """
    if not key.startswith(STATE_KEY_PREFIX) or not key.endswith(STATE_KEY_SUFFIX):
        return None
    middle = key[len(STATE_KEY_PREFIX) : -len(STATE_KEY_SUFFIX)]
    if ":" not in middle:
        return None
    user_id, _, concept_id = middle.partition(":")
    if not user_id or not concept_id:
        return None
    return user_id, concept_id


async def _collect_state_keys(r, user_filter: str | None) -> list[tuple[str, str, str]]:
    """SCAN for state keys, optionally filtered by user_id.

    Returns [(key, user_id, concept_id), ...].
    """
    found: list[tuple[str, str, str]] = []
    cursor = 0
    while True:
        cursor, batch = await r.scan(cursor=cursor, match="concept:*:state", count=SCAN_BATCH)
        for key in batch:
            parsed = _parse_state_key(key)
            if not parsed:
                continue
            user_id, concept_id = parsed
            if user_filter and user_id != user_filter:
                continue
            found.append((key, user_id, concept_id))
        if cursor == 0:
            break
    return found


async def make_all_due(
    user_filter: str | None,
    dry_run: bool,
    seconds_into_future: int,
) -> int:
    """Rewrite every concept's next_review to now. Returns the number of concepts touched."""
    r = await get_redis()

    # Fail fast (with a clear error) if Redis is unreachable rather than
    # letting the script hang on TLS. socket_connect_timeout=5 (set in
    # _CONNECT_KWARGS in redis_client.py) bounds the wait.
    try:
        await r.ping()
    except Exception as e:
        print(f"✗ Redis unreachable: {type(e).__name__}: {e}", file=sys.stderr)
        print(
            "  If you're on home WiFi, Redis Cloud TLS is blocked.\n"
            "  Run on your phone hotspot or set REDIS_URL to a reachable instance.",
            file=sys.stderr,
        )
        return 0

    keys = await _collect_state_keys(r, user_filter)
    if not keys:
        scope = f"user_id={user_filter!r}" if user_filter else "all users"
        print(f"No concept state keys found ({scope}). Nothing to do.")
        return 0

    now_ts = int(time.time()) + seconds_into_future
    now_iso = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(now_ts))

    # Group by user so we can ZADD into one due:{user_id} call per user —
    # fewer round-trips than per-concept. We still need to SET each state key
    # individually because they're at different key paths.
    by_user: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for _key, user_id, concept_id in keys:
        by_user[user_id].append((_key, concept_id))

    touched = 0
    per_user_summary: list[tuple[str, int, int, list[int]]] = []

    if dry_run:
        print(f"[DRY RUN] would update {len(keys)} concepts across {len(by_user)} user(s) to next_review={now_iso} (ts={now_ts})")
        for user_id in sorted(by_user):
            concepts = by_user[user_id]
            print(f"  user {user_id}: {len(concepts)} concept(s)")
        return len(keys)

    for user_id, concepts in by_user.items():
        pipe = r.pipeline()
        old_scores: list[int] = []
        # KEEPTTL preserves the existing TTL on the state key so we don't
        # accidentally extend an about-to-expire concept by another 7 days.
        # redis-py exposes this as kwarg `keepttl=True` on SET.
        for state_key, _concept_id in concepts:
            raw = await r.get(state_key)
            if not raw:
                continue
            try:
                state = json.loads(raw)
            except json.JSONDecodeError:
                # Corrupt entry — skip rather than crash the whole run.
                continue
            old_scores.append(int(state.get("next_review", now_ts)))
            state["next_review"] = now_ts
            pipe.set(state_key, json.dumps(state), keepttl=True)
        # Re-add every concept to the due ZSET with the new score. Members
        # already in the ZSET are updated in place (ZADD upsert semantics).
        if concepts:
            due_key = f"{DUE_KEY_PREFIX}{user_id}"
            pipe.zadd(due_key, {cid: now_ts for _state_key, cid in concepts})
            pipe.expire(due_key, REDIS_TTL_SECONDS)
        await pipe.execute()
        touched += len(concepts)
        per_user_summary.append((user_id, len(concepts), len(old_scores), old_scores))

    print(f"✓ Updated {touched} concept(s) across {len(by_user)} user(s) to next_review={now_iso} (ts={now_ts})")
    for user_id, n_concepts, n_with_state, old_scores in sorted(per_user_summary):
        if n_with_state == 0:
            print(f"  user {user_id}: skipped {n_concepts} (no readable state)")
            continue
        if old_scores:
            oldest = min(old_scores)
            newest = max(old_scores)
            oldest_iso = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(oldest))
            newest_iso = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(newest))
            print(
                f"  user {user_id}: {n_concepts} concept(s); "
                f"previous next_review range {oldest_iso} → {newest_iso}"
            )
    return touched


async def main_async(args: argparse.Namespace) -> int:
    return await make_all_due(
        user_filter=args.user_id,
        dry_run=args.dry_run,
        seconds_into_future=args.seconds_into_future,
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Set every synced concept's next_review to 'now' (or N seconds into the future)."
    )
    parser.add_argument(
        "--user-id",
        default=None,
        help="Limit to one user_id; default is all users with synced concepts.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would change without writing to Redis.",
    )
    parser.add_argument(
        "--seconds-into-future",
        type=int,
        default=0,
        help="Set next_review to now+N seconds (default 0). Useful for staggering.",
    )
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
