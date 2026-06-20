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
GITHUB_WEBHOOK_SECRET = _require("GITHUB_WEBHOOK_SECRET")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")  # optional; unauth is rate-limited
ANTHROPIC_API_KEY = _require("ANTHROPIC_API_KEY")
TOKEN_COMPANY_API_KEY = _require("TOKEN_COMPANY_API_KEY")
DEEPGRAM_API_KEY = _require("DEEPGRAM_API_KEY")

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

# Fernet key for at-rest encryption of user OAuth tokens in Redis.
# Generate with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
TOKEN_ENCRYPTION_KEY = _require("TOKEN_ENCRYPTION_KEY")

# P1 — optional
BROWSERBASE_API_KEY = os.environ.get("BROWSERBASE_API_KEY", "")
BROWSERBASE_PROJECT_ID = os.environ.get("BROWSERBASE_PROJECT_ID", "")

# GitHub API base. Overridable for GitHub Enterprise (same OAuth flow).
GITHUB_API_BASE = os.environ.get("GITHUB_API_BASE", "https://api.github.com")
