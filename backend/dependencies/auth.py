"""FastAPI dependencies for auth."""
from typing import Annotated

import httpx
from fastapi import Header, HTTPException

from backend.config import GITHUB_API_BASE
from backend.services.token_store import store_token

# In-process cache: token-hash -> (user_id, login, expires_at).
# Keeps the GitHub /user hit off the hot path; expires after 60s.
_USER_CACHE: dict[str, tuple[str, str, float]] = {}
_USER_CACHE_TTL_SECONDS: int = 60


def _cache_key(token: str) -> str:
    import hashlib
    return hashlib.sha256(token.encode()).hexdigest()


async def get_current_user(authorization: Annotated[str | None, Header()] = None) -> dict:
    """
    Validate the GitHub OAuth access token in the Authorization header.

    1. Parse the `Bearer <token>` header.
    2. Check the in-process cache (60s TTL).
    3. On miss, call `GET {GITHUB_API_BASE}/user` with the token.
    4. On success, encrypt and persist the token in Redis via `token_store`.
    5. Return `{"id": str(github_id), "login": login, "token": raw_token}`.

    Raises 401 on any failure.
    """
    import time

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

    async with httpx.AsyncClient() as client:
        try:
            r = await client.get(
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

    # Persist the encrypted token for future background work.
    try:
        await store_token(user_id, token)
    except Exception:
        # A Redis blip should not block an otherwise-valid request.
        pass

    _USER_CACHE[cache_key] = (user_id, login, now + _USER_CACHE_TTL_SECONDS)
    return {"id": user_id, "login": login, "token": token}
