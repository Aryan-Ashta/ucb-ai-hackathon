from fastapi import APIRouter

from backend.services.redis_client import get_due_concepts

router = APIRouter()


@router.get("/concepts/{user_id}")
async def list_due_concepts(user_id: str):
    """Return all concepts currently due for review for a user."""
    due = await get_due_concepts(user_id)
    return {"user_id": user_id, "due": due, "count": len(due)}
