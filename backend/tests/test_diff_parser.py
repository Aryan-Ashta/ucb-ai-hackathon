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


# ── P2-B9: SKIP_PATTERNS must use real glob matching (fnmatch), not substring ─


def test_skip_pattern_glob_matches_suffix():
    """P2-B9: `*.min.js` must skip a file ending in `.min.js` regardless of
    how deep the path is. The old substring-match approach (stripping `*` and
    looking for `.min.js`) coincidentally worked for suffix patterns but
    silently failed for prefix patterns like `vendor/*`."""
    raw = (
        "diff --git a/static/app.min.js b/static/app.min.js\n"
        "+alert(1);\n"
    )
    cleaned = clean_diff(raw)
    assert "alert(1);" not in cleaned, (
        "min.js files must be skipped — fnmatch.glob must match *.min.js"
    )
    assert "diff --git a/static/app.min.js" not in cleaned


def test_skip_pattern_glob_does_not_over_skip():
    """P2-B9: an allowed file must NOT be skipped just because its name
    contains a substring that the old broken matcher would have caught.
    e.g. `locker.py` does not match `*.lock` under real fnmatch, even though
    the old substring code would have flagged anything containing 'lock'."""
    raw = (
        "diff --git a/locker.py b/locker.py\n"
        "+def open_locker():\n"
        "+    pass\n"
    )
    cleaned = clean_diff(raw)
    assert "def open_locker():" in cleaned, (
        "locker.py must NOT be skipped — fnmatch must treat `*.lock` literally"
    )


def test_skip_pattern_glob_exact_match_still_works():
    """P2-B9: non-glob entries in SKIP_PATTERNS (e.g. `__pycache__`,
    `.pyc`) must still match — fnmatch treats them as exact substrings."""
    raw = (
        "diff --git a/__pycache__/foo.pyc b/__pycache__/foo.pyc\n"
        "+binary blob\n"
    )
    cleaned = clean_diff(raw)
    assert "binary blob" not in cleaned, (
        "__pycache__ entries must be skipped"
    )


def test_skip_pattern_glob_prefix_pattern():
    """P2-B9: prefix patterns like `vendor/*` (if added later) would have
    silently no-oped under the old substring code (since stripping `*` gives
    `vendor/`, which wouldn't appear at the start of a path-only comparison
    in any meaningful way). Confirm fnmatch honours the prefix glob now."""
    # Inject a prefix-glob pattern that the old matcher could not have handled.
    from backend.services import diff_parser as dp
    original = dp.SKIP_PATTERNS
    dp.SKIP_PATTERNS = list(original) + ["vendor/*"]
    try:
        raw = (
            "diff --git a/vendor/jquery.js b/vendor/jquery.js\n"
            "+$ = window;\n"
        )
        cleaned = clean_diff(raw)
        assert "$ = window;" not in cleaned, (
            "vendor/jquery.js must be skipped under `vendor/*` glob"
        )
    finally:
        dp.SKIP_PATTERNS = original
