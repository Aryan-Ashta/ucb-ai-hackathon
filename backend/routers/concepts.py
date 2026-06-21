from fastapi import APIRouter, Depends, HTTPException

from backend.dependencies.auth import get_current_user
from backend.services.redis_client import get_due_concepts, get_quiz_content

router = APIRouter()


@router.get("/concepts")
async def list_due_concepts(user=Depends(get_current_user)):
    """Return all concepts currently due for review for the signed-in user."""
    due = await get_due_concepts(user["id"])
    return {"user_id": user["id"], "due": due, "count": len(due)}


@router.get("/concepts/{concept_id}")
async def get_concept_by_id(
    concept_id: str,
    user=Depends(get_current_user),
):
    """Return a single concept by id, regardless of due status. Used by the quiz page.

    Auth-gated; uses the signed-in user's id (NOT the URL) so a caller can't
    read another user's concept by guessing IDs.
    """
    quiz = await get_quiz_content(user["id"], concept_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Concept not found")
    return {"user_id": user["id"], "concept": quiz}
