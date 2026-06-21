"""
Claude tests.

Pure helper tests (fence stripping) run anywhere. The live extraction test runs only
when a real TOKENROUTER_API_KEY and a reachable Redis are present.

The `grade_answer` tests mock `backend.services.claude.client` with unittest.mock
(AsyncMock + MagicMock) so they run without a real TOKENROUTER_API_KEY. They cover the
happy path, graceful handling of malformed JSON, and clamping of out-of-range quality
scores.
"""
import json
import os
from unittest.mock import AsyncMock, MagicMock

from backend.services.claude import _strip_fences, grade_answer


def _has_real_key() -> bool:
    key = os.environ.get("TOKENROUTER_API_KEY", "")
    return bool(key) and not key.startswith("placeholder")


def test_strip_plain_json():
    assert _strip_fences('[{"a": 1}]') == '[{"a": 1}]'


def test_strip_json_fence():
    assert _strip_fences('```json\n[{"a": 1}]\n```') == '[{"a": 1}]'


def test_strip_bare_fence():
    assert _strip_fences('```\n[{"a": 1}]\n```') == '[{"a": 1}]'


async def test_live_extraction():
    """Only runs with a real TokenRouter key + Redis — asserts a concept is produced."""
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
        sample_diff, user_id="test_user", source_id=999
    )
    assert len(concepts) >= 1, "Expected at least 1 concept"
    for c in concepts:
        assert c.concept
        assert c.roast_text
        assert c.question_text
        assert c.answer_hint


# ---------------------------------------------------------------------------
# grade_answer tests — all run without a real TOKENROUTER_API_KEY by patching
# `backend.services.claude.client` with an AsyncMock. These tests cover the
# post-fix contract: AsyncOpenAI client (await), try/except around json.loads
# (graceful default on malformed JSON), quality clamping to [0, 5], and bool
# coercion of `passed`.
# ---------------------------------------------------------------------------


def _make_fake_message(text: str) -> MagicMock:
    """Build a fake OpenAI ChatCompletion: `.choices[0].message.content == text`."""
    msg = MagicMock()
    msg.choices = [MagicMock(message=MagicMock(content=text))]
    return msg


def _patch_client(monkeypatch, fake_message: MagicMock) -> AsyncMock:
    """Replace `backend.services.claude.client` with a mock whose async
    `chat.completions.create` returns `fake_message`. Returns the AsyncMock so callers
    can assert on call args if desired.
    """
    fake_client = MagicMock()
    create_mock = AsyncMock(return_value=fake_message)
    fake_client.chat.completions.create = create_mock
    monkeypatch.setattr("backend.services.claude.client", fake_client)
    return create_mock


async def test_grade_answer_happy_path(monkeypatch):
    """Happy path: model returns well-formed JSON; grade_answer returns it parsed."""
    payload = {"quality": 3, "passed": True, "explanation": "good answer"}
    _patch_client(monkeypatch, _make_fake_message(json.dumps(payload)))

    result = await grade_answer(
        "What technique eliminates redundant recomputation in your recursive fib?",
        "memoization, caching, dynamic programming",
        "you cache the results so you don't recompute",
    )

    assert isinstance(result, dict)
    assert result["quality"] == 3
    assert result["passed"] is True
    assert result["explanation"] == "good answer"


async def test_grade_answer_malformed_json_graceful_default(monkeypatch):
    """Malformed JSON from the model must not raise — grade_answer returns a
    graceful default with passed=False, quality=0, and a non-empty explanation.
    """
    _patch_client(monkeypatch, _make_fake_message("not valid json {{{"))

    # Must not raise
    result = await grade_answer("question", "hint", "student transcript")

    assert isinstance(result, dict)
    assert result["passed"] is False
    assert result["quality"] == 0
    explanation = result.get("explanation", "")
    assert isinstance(explanation, str)
    assert len(explanation) > 0


async def test_grade_answer_quality_clamped_high(monkeypatch):
    """Out-of-range high quality (7) must clamp down to 5."""
    payload = {"quality": 7, "passed": True, "explanation": "great"}
    _patch_client(monkeypatch, _make_fake_message(json.dumps(payload)))

    result = await grade_answer("question", "hint", "student transcript")

    assert result["quality"] == 5


async def test_grade_answer_quality_clamped_low(monkeypatch):
    """Negative quality (-2) must clamp up to 0."""
    payload = {"quality": -2, "passed": True, "explanation": "off"}
    _patch_client(monkeypatch, _make_fake_message(json.dumps(payload)))

    result = await grade_answer("question", "hint", "student transcript")

    assert result["quality"] == 0
