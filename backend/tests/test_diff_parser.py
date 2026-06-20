"""Pure-logic tests for clean_diff — no network, no secrets required."""
from pathlib import Path

from backend.services.diff_parser import clean_diff

FIXTURE = Path(__file__).parent / "fixtures" / "sample.diff"


def test_keeps_allowed_extensions():
    cleaned = clean_diff(FIXTURE.read_text())
    assert "fib.py" in cleaned, "Should keep .py files"
    assert "utils.py" in cleaned, "Should keep .py files"
    assert "def fib(n):" in cleaned
    assert "def add(a, b):" in cleaned


def test_strips_lock_files():
    cleaned = clean_diff(FIXTURE.read_text())
    assert "package-lock.json" not in cleaned, "Lock files must be stripped"
    assert "registry.npmjs.org" not in cleaned


def test_strips_binary_and_non_code():
    cleaned = clean_diff(FIXTURE.read_text())
    assert "logo.png" not in cleaned, "Non-code files must be stripped"
    assert "Binary files" not in cleaned


def test_strips_whitespace_only_lines():
    raw = (
        "diff --git a/x.py b/x.py\n"
        "+real line\n"
        "+\n"
        "- \n"
        "+another\n"
    )
    cleaned = clean_diff(raw)
    assert "+real line" in cleaned
    assert "+another" in cleaned
    # The bare "+" and "- " whitespace-only markers should be gone.
    lines = cleaned.split("\n")
    assert "+" not in lines
    assert "- " not in lines


def test_empty_diff_returns_empty():
    assert clean_diff("") == ""
