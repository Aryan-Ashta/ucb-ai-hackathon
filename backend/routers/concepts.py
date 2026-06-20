from fastapi import APIRouter, Depends

from backend.dependencies.auth import get_current_user
from backend.services.redis_client import get_due_concepts

router = APIRouter()


@router.get("/concepts")
async def list_due_concepts(user=Depends(get_current_user)):
    """Return all concepts currently due for review for the signed-in user."""
    due = await get_due_concepts(user["id"])
    return {"user_id": user["id"], "due": due, "count": len(due)}
