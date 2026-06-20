"""
Bear-2 tests.

Without a real TOKEN_COMPANY_API_KEY the live compression call fails, so we verify
the graceful-fallback contract (A2 acceptance: unreachable/non-2xx → return raw diff,
no exception). When a real key is configured the live test asserts token reduction.
"""
import os
from pathlib import Path

from backend.services.bear2 import compress_diff, count_tokens_approx

FIXTURE = Path(__file__).parent / "fixtures" / "sample.diff"


def _has_real_key() -> bool:
    key = os.environ.get("TOKEN_COMPANY_API_KEY", "")
    return bool(key) and not key.startswith("placeholder")


async def test_count_tokens_approx():
    assert count_tokens_approx("a" * 40) == 10
    assert count_tokens_approx("") == 0


async def test_fallback_returns_raw_on_failure():
    """With no real API, compress_diff must fall back to the raw diff, not raise."""
    if _has_real_key():
        return  # covered by the live test instead
    sample = FIXTURE.read_text()
    result = await compress_diff(sample)
    assert result == sample, "Fallback must return the raw diff unchanged"


async def test_live_compression():
    """Only runs with a real key — asserts measurable token reduction."""
    if not _has_real_key():
        return  # skipped without credentials
    sample = FIXTURE.read_text()
    raw_tokens = count_tokens_approx(sample)
    compressed = await compress_diff(sample)
    compressed_tokens = count_tokens_approx(compressed)

    assert len(compressed) > 0, "Compressed output is empty"
    assert compressed_tokens < raw_tokens, "No token reduction achieved"
    assert len(compressed) > 50, "Output too short — likely stripped code semantics"
