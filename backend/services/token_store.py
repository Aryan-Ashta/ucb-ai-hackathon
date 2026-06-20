"""
At-rest encrypted storage of user GitHub OAuth access tokens in Redis.

The frontend sends a fresh `Authorization: Bearer *** on every request,
which is re-verified against GitHub's `/user` endpoint by the
`get_current_user` dependency. We **also** persist an encrypted copy of the
token here, keyed by GitHub `user_id`, so future background work (cron sync,
batch jobs) can use it without requiring the user to be online.

Threat model:
  - Redis snapshot leak: ciphertext only; Fernet (AES-128-CBC + HMAC-SHA256)
    with a key that is not in Redis.
  - Token rotation: re-login overwrites the stored copy (same `user_id`).
  - Key rotation: out of scope; decryption failure logs a warning and returns
    None, which forces the user to re-authenticate on next request.
"""
import logging

from cryptography.fernet import Fernet, InvalidToken

from backend.config import TOKEN_ENCRYPTION_KEY
from backend.services.redis_client import REDIS_TTL_SECONDS, get_redis

logger = logging.getLogger(__name__)

# 30-day retention; GitHub OAuth tokens are long-lived but we still want a
# bounded at-rest window.
TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

_fernet: Fernet | None = None


def _get_fernet() -> Fernet:
    """Lazy-init the Fernet instance from the env var."""
    global _fernet
    if _fernet is None:
        _fernet = Fernet(TOKEN_ENCRYPTION_KEY.encode())
    return _fernet


def _key(user_id: str) -> str:
    return f"user:{user_id}:encrypted_token"


async def store_token(user_id: str, access_token: str) -> None:
    """
    Encrypt and persist the user's access token. Idempotent — calling twice
    with the same token is a no-op; calling with a rotated token overwrites.
    """
    r = await get_redis()
    encrypted = _get_fernet().encrypt(access_token.encode())
    await r.set(_key(user_id), encrypted.decode(), ex=TOKEN_TTL_SECONDS)


async def get_token(user_id: str) -> str | None:
    """
    Decrypt and return the stored access token, or None if missing /
    undecryptable (e.g. the Fernet key was rotated). Callers must handle
    the None case by treating the user as logged out.
    """
    r = await get_redis()
    encrypted = await r.get(_key(user_id))
    if not encrypted:
        return None
    try:
        return _get_fernet().decrypt(encrypted.encode()).decode()
    except InvalidToken:
        logger.warning(
            "Failed to decrypt stored token for user %s — Fernet key may "
            "have been rotated. The user will need to sign in again.",
            user_id,
        )
        return None


async def delete_token(user_id: str) -> None:
    """Remove the stored token (e.g. on user sign-out)."""
    r = await get_redis()
    await r.delete(_key(user_id))
