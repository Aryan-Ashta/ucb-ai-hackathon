"""Sync endpoints (auth-gated)."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends

from backend.dependencies.auth import get_current_user
from backend.services.redis_client import get_last_sync
from backend.services.sync import sync_user_prs

router = APIRouter()


@router.post("/sync")
async def trigger_sync(user=Depends(get_current_user)):
    """
    Pull all merged PRs in repos the signed-in user can access, since the
    last sync, and ingest each new one. Idempotent: a re-run with no new
    PRs returns immediately.
    """
    summary = await sync_user_prs(user["token"], user["id"])
    return {
        "user": {"id": user["id"], "login": user["login"]},
        "summary": summary,
    }


@router.get("/sync/status")
async def sync_status(user=Depends(get_current_user)):
    """Last successful sync time (or null) for the signed-in user."""
    last = await get_last_sync(user["id"])
    return {
        "user": {"id": user["id"], "login": user["login"]},
        "last_sync": last,
        "last_sync_iso": (
            datetime.fromtimestamp(last, tz=timezone.utc).isoformat()
            if last
            else None
        ),
    }
