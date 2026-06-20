import sentry_sdk
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from backend.dependencies.auth import get_current_user
from backend.services.browserbase import enrich_concept

router = APIRouter()


class EnrichRequest(BaseModel):
    concept_id: str
    concept: str


@router.post("/enrich")
async def enrich(req: EnrichRequest, user=Depends(get_current_user)):
    """P1: scrape authoritative docs for a concept and cache the snippet."""
    with sentry_sdk.start_span(op="browserbase.enrich", name="Enrich concept"):
        snippet = await enrich_concept(
            concept=req.concept,
            concept_id=req.concept_id,
            user_id=user["id"],
        )
    return {"snippet": snippet}
