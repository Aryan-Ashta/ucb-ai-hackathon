import json
from typing import TypedDict

import httpx
import sentry_sdk

from backend.config import BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID
from backend.services.http_client import shared_client
from backend.services.redis_client import REDIS_TTL_SECONDS, get_redis

BROWSERBASE_API_BASE = "https://api.browserbase.com/v1"  # confirm from Browserbase docs

AUTHORITATIVE_SOURCES = [
    "developer.mozilla.org",
    "docs.python.org",
    "en.wikipedia.org/wiki/",
    "docs.rust-lang.org",
    "go.dev/doc",
]

_client = shared_client("browserbase")


class EnrichmentResult(TypedDict):
    """P1-B8: structured result so callers can distinguish success from failure.

    - ok=True:  snippet is populated (may be the fallback "A core CS concept: X"
      string if the scrape succeeded but no paragraph was long enough).
    - ok=False: snippet is empty; error is a short, non-PII string naming the
      exception class. The full exception is captured to Sentry separately.
    """

    snippet: str
    ok: bool
    error: str | None


async def enrich_concept(concept: str, concept_id: str, user_id: str) -> EnrichmentResult:
    """
    Scrape a documentation page for the given concept via Browserbase.
    Appends enrichment to Redis quiz content.

    Returns a structured result (P1-B8): on any failure returns
    `{snippet: "", ok: False, error: <class-name>}` instead of silently
    returning an empty string. The router surfaces this shape to the client.
    """
    try:
        # Step 1: create a session.
        session_resp = await _client.post(
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
        fetch_resp = await _client.post(
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
            message=f"Enrichment failed: {type(e).__name__}",
            level="warning",
        )
        return {"snippet": "", "ok": False, "error": type(e).__name__}

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

    return {"snippet": snippet, "ok": True, "error": None}
