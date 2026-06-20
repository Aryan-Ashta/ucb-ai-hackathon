from datetime import datetime, timezone

import httpx
import sentry_sdk

from backend.config import POKE_API_KEY

POKE_API_BASE = "https://api.interaction.co/v1"  # confirm exact URL from Interaction Co docs


async def schedule_review_block(
    concept_name: str,
    concept_id: str,
    next_review_timestamp: int,
    user_calendar_id: str,
) -> dict:
    """
    Schedule a 10-minute review block on the user's calendar via the Poke API.
    Returns the created event object.
    """
    review_dt = datetime.fromtimestamp(next_review_timestamp, tz=timezone.utc)

    event_payload = {
        "title": f"VibeSchool: review {concept_name}",
        "description": (
            f"Review concept: {concept_name}\n"
            f"Quiz link: https://vibeschool.app/quiz/{concept_id}"
        ),
        "start": review_dt.isoformat(),
        "duration_minutes": 10,
        "calendar_id": user_calendar_id,
    }

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{POKE_API_BASE}/events",
            headers={
                "Authorization": f"Bearer {POKE_API_KEY}",
                "Content-Type": "application/json",
            },
            json=event_payload,
            timeout=10.0,
        )
        response.raise_for_status()
        event = response.json()

    sentry_sdk.add_breadcrumb(
        category="poke",
        message=f"Scheduled review block for '{concept_name}' at {review_dt.isoformat()}",
        level="info",
        data={"event_id": event.get("id"), "concept_id": concept_id},
    )

    return event
