import json

import httpx
import sentry_sdk

from backend.config import BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID
from backend.services.redis_client import REDIS_TTL_SECONDS, get_redis

BROWSERBASE_API_BASE = "https://api.browserbase.com/v1"  # confirm from Browserbase docs

AUTHORITATIVE_SOURCES = [
    "developer.mozilla.org",
    "docs.python.org",
    "en.wikipedia.org/wiki/",
    "docs.rust-lang.org",
    "go.dev/doc",
]


async def enrich_concept(concept: str, concept_id: str, user_id: str) -> str:
    """
    Scrape a documentation page for the given concept via Browserbase.
    Appends enrichment to Redis quiz content. Returns the snippet string.
    Returns "" on any failure (never propagates exceptions to the core loop).
    """
    try:
        async with httpx.AsyncClient() as client:
            # Step 1: create a session.
            session_resp = await client.post(
                f"{BROWSERBASE_API_BASE}/sessions",
                headers={
                    "x-bb-api-key": BROWSERBASE_API_KEY,
                    "Content-Type": "application/json",
                },
                json={"projectId": BROWSERBASE_PROJECT_ID},
                timeout=10.0,
            )
            session_resp.raise_for_status()
            session_id = session_resp.json()["id"]

            # Step 2: navigate to MDN search.
            mdn_url = (
                f"https://developer.mozilla.org/en-US/search?q={concept.replace(' ', '+')}"
            )
            fetch_resp = await client.post(
                f"{BROWSERBASE_API_BASE}/sessions/{session_id}/fetch",
                headers={
                    "x-bb-api-key": BROWSERBASE_API_KEY,
                    "Content-Type": "application/json",
                },
                json={"url": mdn_url},
                timeout=20.0,
            )
            fetch_resp.raise_for_status()
            page_text = fetch_resp.json().get("text", "")

            # Extract first meaningful paragraph (heuristic: long, not a nav item).
            lines = [l.strip() for l in page_text.split("\n") if len(l.strip()) > 80]
            snippet = lines[0] if lines else f"A core CS concept: {concept}."
            snippet = snippet[:300]
    except Exception as e:
        sentry_sdk.capture_exception(e)
        sentry_sdk.add_breadcrumb(
            category="browserbase",
            message=f"Enrichment failed: {e}",
            level="warning",
        )
        return ""

    r = await get_redis()
    enrich_key = f"concept:{user_id}:{concept_id}:enrichment"
    await r.set(
        enrich_key,
        json.dumps({"snippet": snippet, "source": "MDN"}),
        ex=REDIS_TTL_SECONDS,
    )

    sentry_sdk.add_breadcrumb(
        category="browserbase",
        message=f"Enriched concept '{concept}': {snippet[:80]}",
        level="info",
    )

    return snippet
