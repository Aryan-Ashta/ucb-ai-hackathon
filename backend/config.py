import os
from pathlib import Path

from dotenv import load_dotenv

# Load the .env that sits next to this file (backend/.env), regardless of CWD.
load_dotenv(Path(__file__).with_name(".env"))


def _require(key: str) -> str:
    """Read a required env var. Fail fast at import time if it is missing."""
    value = os.environ.get(key)
    if value is None:
        raise RuntimeError(
            f"Required environment variable {key!r} is not set. "
            f"Copy backend/.env.example to backend/.env and fill it in."
        )
    return value


# P0 — required for the core ingestion + quiz loop
# GITHUB_WEBHOOK_SECRET removed by the OAuth refactor (webhooks are gone).
# GITHUB_TOKEN is still honored as a server-wide fallback for cron / scripts,
# but the request hot path uses the per-user OAuth token from the bearer header.
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")  # optional; unauth is rate-limited
ANTHROPIC_API_KEY = _require("ANTHROPIC_API_KEY")
TOKEN_COMPANY_API_KEY = _require("TOKEN_COMPANY_API_KEY")
DEEPGRAM_API_KEY = _require("DEEPGRAM_API_KEY")

# ── AI gateway (TokenRouter) ────────────────────────────────────────────────
# Set USE_TOKENROUTER=true to route all Claude calls through tokenrouter.com
# instead of api.anthropic.com. The Anthropic Python SDK is pointed at
# tokenrouter's Anthropic-compatible endpoint (https://api.tokenrouter.com);
# the SDK auto-appends /v1/messages to base_url. Set ANTHROPIC_MODEL if
# tokenrouter expects a prefixed name (e.g. "anthropic/claude-sonnet-4-6").
# Leave USE_TOKENROUTER unset/false to use direct Anthropic (default).
USE_TOKENROUTER = os.environ.get("USE_TOKENROUTER", "").lower() in ("1", "true", "yes")
TOKENROUTER_BASE_URL = os.environ.get("TOKENROUTER_BASE_URL", "https://api.tokenrouter.com")
TOKENROUTER_API_KEY = os.environ.get("TOKENROUTER_API_KEY", "")
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")

# ── Redis Cloud ───────────────────────────────────────────────────────────
# Redis Cloud → your database → "Connect" gives you four things:
#   • a public endpoint    → REDIS_HOST + REDIS_PORT
#   • a database user      → REDIS_USERNAME ("default" unless you made an RBAC user)
#   • that user's password → REDIS_PASSWORD  (the "user key")
#   • whether TLS is on    → REDIS_TLS
# A full REDIS_URL still wins if set, which is convenient for a local server or
# for pasting a complete rediss:// connection string.
REDIS_URL = os.environ.get("REDIS_URL", "")
REDIS_HOST = os.environ.get("REDIS_HOST", "localhost")
REDIS_PORT = int(os.environ.get("REDIS_PORT") or "6379")
REDIS_USERNAME = os.environ.get("REDIS_USERNAME", "default")
REDIS_PASSWORD = os.environ.get("REDIS_PASSWORD", "")
REDIS_TLS = os.environ.get("REDIS_TLS", "").lower() in ("1", "true", "yes")

SENTRY_DSN = os.environ.get("SENTRY_DSN", "")  # empty disables Sentry transport
POKE_API_KEY = _require("POKE_API_KEY")
# P1-B7: calendar ID is server-side now (was a horizontal-privilege primitive
# when read from the request body). For the demo this is a single env-supplied
# default; production would resolve per-user from a Poke OAuth flow + Redis.
POKE_USER_CALENDAR_ID = os.environ.get("POKE_USER_CALENDAR_ID", "")

# Fernet key for at-rest encryption of user OAuth tokens in Redis.
# Generate with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
TOKEN_ENCRYPTION_KEY = _require("TOKEN_ENCRYPTION_KEY")

# Voyage AI embeddings (used by the vector_store RAG layer).
# Empty VOYAGE_API_KEY → vector_store falls back to a deterministic
# hash-based pseudo-embedding so tests + dev runs work without an
# external key. The integration is wired end-to-end either way; only
# real semantic recall requires a live API key.
VOYAGE_API_KEY = os.environ.get("VOYAGE_API_KEY", "")
VOYAGE_BASE_URL = os.environ.get("VOYAGE_BASE_URL", "https://api.voyageai.com")
VOYAGE_MODEL = os.environ.get("VOYAGE_MODEL", "voyage-3")
EMBEDDING_DIM = int(os.environ.get("EMBEDDING_DIM", "1024"))

# GitHub API base. Overridable for GitHub Enterprise (same OAuth flow).
GITHUB_API_BASE = os.environ.get("GITHUB_API_BASE", "https://api.github.com")
