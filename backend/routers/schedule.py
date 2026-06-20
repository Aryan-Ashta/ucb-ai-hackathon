import sentry_sdk
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.dependencies.auth import get_current_user
from backend.services.poke import schedule_review_block
from backend.services.redis_client import get_quiz_content

router = APIRouter()


class ScheduleRequest(BaseModel):
    concept_id: str
    next_review_timestamp: int
    user_calendar_id: str  # from Poke API user auth


@router.post("/schedule-review")
async def schedule_review(req: ScheduleRequest, user=Depends(get_current_user)):
    quiz = await get_quiz_content(user["id"], req.concept_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Concept not found")

    with sentry_sdk.start_span(op="poke.schedule", name="Schedule calendar block"):
        event = await schedule_review_block(
            concept_name=quiz["concept"],
            concept_id=req.concept_id,
            next_review_timestamp=req.next_review_timestamp,
            user_calendar_id=req.user_calendar_id,
        )

    return {"status": "scheduled", "event": event}
