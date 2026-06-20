import sentry_sdk
from fastapi import APIRouter
from pydantic import BaseModel

from backend.services.browserbase import enrich_concept

router = APIRouter()


class EnrichRequest(BaseModel):
    user_id: str
    concept_id: str
    concept: str


@router.post("/enrich")
async def enrich(req: EnrichRequest):
    """P1: scrape authoritative docs for a concept and cache the snippet."""
    with sentry_sdk.start_span(op="browserbase.enrich", description="Enrich concept"):
        snippet = await enrich_concept(
            concept=req.concept,
            concept_id=req.concept_id,
            user_id=req.user_id,
        )
    return {"snippet": snippet}
