import httpx
import sentry_sdk

from backend.config import TOKEN_COMPANY_API_KEY

BEAR2_URL = "https://api.thetokencompany.com/v1/compress"  # confirm exact URL from docs


def count_tokens_approx(text: str) -> int:
    """Rough token count: ~4 chars per token for code."""
    return len(text) // 4


async def compress_diff(raw_diff: str) -> str:
    """
    Compress diff text using Token Company Bear-2.
    Falls back to the raw diff if the API fails (do not block ingestion).
    Uses accuracy-preserving mode to avoid stripping code semantics.
    """
    raw_tokens = count_tokens_approx(raw_diff)
    compressed_tokens = count_tokens_approx("")

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                BEAR2_URL,
                headers={
                    "Authorization": f"Bearer {TOKEN_COMPANY_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "bear-2",
                    "input": raw_diff,
                },
                timeout=10.0,
            )
            response.raise_for_status()
            data = response.json()
            compressed = data["output"]
            # Use the API's BPE-based counts if available, else heuristic.
            raw_tokens = data.get("original_input_tokens") or raw_tokens
            compressed_tokens = data.get("output_tokens") or compressed_tokens
    except Exception as e:
        sentry_sdk.capture_exception(e)
        sentry_sdk.add_breadcrumb(
            category="bear2",
            message=f"Bear-2 failed, falling back to raw diff: {e}",
            level="warning",
        )
        return raw_diff  # graceful fallback

    reduction_pct = round((1 - compressed_tokens / max(raw_tokens, 1)) * 100, 1)

    sentry_sdk.add_breadcrumb(
        category="bear2",
        message=(
            f"Bear-2 compression: {raw_tokens} → {compressed_tokens} tokens "
            f"({reduction_pct}% reduction)"
        ),
        level="info",
        data={
            "raw_tokens": raw_tokens,
            "compressed_tokens": compressed_tokens,
            "reduction_pct": reduction_pct,
        },
    )

    return compressed
