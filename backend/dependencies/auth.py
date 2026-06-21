"""FastAPI dependencies for auth."""
import hashlib
import time
from typing import Annotated

import cachetools
import httpx
import redis
import sentry_sdk
from fastapi import Header, HTTPException

from backend.config import GITHUB_API_BASE
from backend.services.http_client import shared_client
from backend.services.token_store import store_token

# P1-B2: In-process cache for token → user identity, with both a TTL and a
# max size. The previous plain dict grew unbounded (every distinct token
# stayed forever). cachetools.TTLCache evicts on read when an entry has
# expired AND evicts LRU entries when the cache is full.
_USER_CACHE: cachetools.TTLCache[str, tuple[str, str, float]] = cachetools.TTLCache(
    maxsize=10_000, ttl=60
)
_USER_CACHE_TTL_SECONDS: int = 60

# Single httpx client per process — reused across every auth check so
# subsequent calls reuse the keep-alive connection (P1-B9).
_auth_client = shared_client("auth")


def _cache_key(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def get_current_user(authorization: Annotated[str | None, Header()] = None) -> dict:
    """
    Validate the GitHub OAuth access token in the Authorization header.

    1. Parse the `Bearer <token>` header.
    2. Check the in-process cache (60s TTL, bounded to 10k entries — P1-B2).
    3. On miss, call `GET {GITHUB_API_BASE}/user` with the token.
    4. On success, encrypt and persist the token in Redis via `token_store`.
    5. Return `{"id": str(github_id), "login": login, "token": raw_token}`.

    Raises 401 on any failure.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Empty bearer token")

    now = time.time()
    cache_key = _cache_key(token)
    cached = _USER_CACHE.get(cache_key)
    if cached and cached[2] > now:
        user_id, login, _ = cached
        return {"id": user_id, "login": login, "token": token}

    try:
        r = await _auth_client.get(
            f"{GITHUB_API_BASE}/user",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=5.0,
        )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=503, detail=f"GitHub unreachable: {e!s}") from e

    if r.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid GitHub token")

    user = r.json()
    user_id = str(user["id"])
    login = user["login"]

    # P1-B3: A Redis blip should not block an otherwise-valid request, but
    # it MUST be visible. Capture to Sentry at warning level + emit a
    # breadcrumb so the team sees "this user just authed successfully but
    # we couldn't persist the token" instead of failing silently.
    # P3-B2: narrow the broad except to the realistic failure modes for
    # store_token (network / connection to Redis; malformed Fernet key).
    # A bare `except Exception` would swallow programming errors (typos in
    # the call site) that we'd rather see bubble up.
    try:
        await store_token(user_id, token)
    except (redis.RedisError, ValueError) as e:
        sentry_sdk.capture_exception(e)
        sentry_sdk.add_breadcrumb(
            category="auth",
            message="token_persistence_failed",
            level="warning",
            data={"user_id": user_id, "error_class": type(e).__name__},
        )

    _USER_CACHE[cache_key] = (user_id, login, now + _USER_CACHE_TTL_SECONDS)
    return {"id": user_id, "login": login, "token": token}
