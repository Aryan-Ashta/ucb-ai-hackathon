"""
Claude tests.

Pure helper tests (fence stripping) run anywhere. The live extraction test runs only
when a real ANTHROPIC_API_KEY and a reachable Redis are present.
"""
import os

from backend.services.claude import _strip_fences


def _has_real_key() -> bool:
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    return bool(key) and not key.startswith("placeholder")


def test_strip_plain_json():
    assert _strip_fences('[{"a": 1}]') == '[{"a": 1}]'


def test_strip_json_fence():
    assert _strip_fences('```json\n[{"a": 1}]\n```') == '[{"a": 1}]'


def test_strip_bare_fence():
    assert _strip_fences('```\n[{"a": 1}]\n```') == '[{"a": 1}]'


async def test_live_extraction():
    """Only runs with a real Anthropic key + Redis — asserts a concept is produced."""
    if not _has_real_key():
        return  # skipped without credentials

    from backend.services.claude import extract_concepts_and_cache

    sample_diff = (
        "diff --git a/fib.py b/fib.py\n"
        "+def fib(n):\n"
        "+    if n <= 1:\n"
        "+        return n\n"
        "+    return fib(n-1) + fib(n-2)\n"
    )
    concepts = await extract_concepts_and_cache(
        sample_diff, user_id="test_user", pr_number=999
    )
    assert len(concepts) >= 1, "Expected at least 1 concept"
    for c in concepts:
        assert c.concept
        assert c.roast_text
        assert c.question_text
        assert c.answer_hint
