"""
Cloud Redis connectivity smoke-test.

Usage:
    .venv/bin/python -m backend.scripts.check_redis

Reads Redis Cloud credentials from backend/.env (via config). Verifies:
connect → PING → SET with TTL → GET round-trip → TTL read → cleanup. Prints a
clear pass/fail.
"""
import asyncio
import sys

from backend.config import REDIS_HOST, REDIS_PORT, REDIS_TLS, REDIS_URL
from backend.services.redis_client import get_redis


def _masked_url(url: str) -> str:
    """Hide the password when echoing the URL back to the terminal."""
    if "@" not in url:
        return url
    creds, host = url.rsplit("@", 1)
    scheme_user = creds.split(":")[:2]  # scheme//, user
    return ":".join(scheme_user) + ":****@" + host


def _target() -> str:
    """A printable, password-free description of where we're connecting."""
    if REDIS_URL:
        return _masked_url(REDIS_URL)
    scheme = "rediss" if REDIS_TLS else "redis"
    return f"{scheme}://{REDIS_HOST}:{REDIS_PORT}"


async def main() -> int:
    print(f"Connecting to: {_target()}")
    try:
        r = await get_redis()

        pong = await r.ping()
        print(f"  PING        → {pong}")

        await r.set("vibeschool:healthcheck", "ok", ex=60)
        value = await r.get("vibeschool:healthcheck")
        ttl = await r.ttl("vibeschool:healthcheck")
        print(f"  SET/GET     → {value!r}")
        print(f"  TTL         → {ttl}s (expected ~60)")

        await r.delete("vibeschool:healthcheck")
        print(f"  CLEANUP     → done")

        assert pong is True
        assert value == "ok"
        assert 0 < ttl <= 60
    except Exception as e:
        print(f"\n✗ Redis connection FAILED: {type(e).__name__}: {e}")
        print(
            "  Check REDIS_HOST / REDIS_PORT / REDIS_USERNAME / REDIS_PASSWORD in "
            "backend/.env\n  (set REDIS_TLS=true if your Redis Cloud database has "
            "TLS enabled)."
        )
        return 1

    print("\n✓ Cloud Redis is reachable and working.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
