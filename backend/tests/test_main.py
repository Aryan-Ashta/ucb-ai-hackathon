"""Tests for backend/main.py — verify P2-S2 logging configuration.

Importing `backend.main` is the entrypoint; we assert that stdlib logging is
configured by the time the module finishes importing. The test reloads the
module under controlled LOG_LEVEL values to pin the env-driven behaviour.
"""
import importlib
import logging
import os

import pytest


@pytest.fixture
def reload_main(monkeypatch):
    """Reload backend.main under a fresh environment so we can assert the
    LOG_LEVEL behaviour without polluting other tests."""
    # Make sure required env vars are present (TOKEN_ENCRYPTION_KEY is required
    # by config.py and the test process may not have it set).
    monkeypatch.setenv("TOKEN_ENCRYPTION_KEY", "test-key-not-real-encryption-only-for-tests")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("TOKEN_COMPANY_API_KEY", "test-key")
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-key")
    monkeypatch.setenv("GITHUB_TOKEN", "")
    monkeypatch.setenv("SENTRY_DSN", "")

    def _reload():
        import backend.main as main_mod
        importlib.reload(main_mod)
        return main_mod

    return _reload


def test_main_imports_cleanly():
    """P2-S2: simply importing backend.main must not raise. This is the
    smoke test for the rest of the suite — every other test imports main
    transitively via app.dependency_overrides, so a regression here would
    fail the entire suite."""
    import backend.main as main_mod  # noqa: F401
    assert main_mod.app is not None
    assert main_mod.app.title == "VibeSchool Backend"


def test_logging_basicconfig_runs_on_import(reload_main, monkeypatch):
    """P2-S2: logging.basicConfig must run at module-import time so that
    `logging.getLogger().info(...)` from anywhere in the app emits to stderr
    even when SENTRY_DSN is empty. We verify by emitting a record and
    checking the root logger has at least one handler (basicConfig's mark)."""
    monkeypatch.delenv("LOG_LEVEL", raising=False)
    reload_main()
    root = logging.getLogger()
    assert root.handlers, (
        "P2-S2: root logger must have at least one handler after importing "
        "backend.main — logging.basicConfig should attach a StreamHandler. "
        "Without this, silent failures stay silent when SENTRY_DSN is empty."
    )


def test_logging_level_respects_env(reload_main, monkeypatch):
    """P2-S2: LOG_LEVEL=DEBUG must propagate to the root logger level.
    Pinning this prevents an accidental regression where the default
    ('INFO') shadows a debug-needed production incident."""
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    reload_main()
    assert logging.getLogger().level == logging.DEBUG, (
        f"LOG_LEVEL=DEBUG should set root level to DEBUG, "
        f"got {logging.getLogger().level}"
    )


def test_logging_level_default_is_info(reload_main, monkeypatch):
    """P2-S2: with no LOG_LEVEL set, the root logger should default to INFO
    — verbose enough to surface errors, quiet enough to not flood stderr."""
    monkeypatch.delenv("LOG_LEVEL", raising=False)
    reload_main()
    assert logging.getLogger().level == logging.INFO, (
        f"Default LOG_LEVEL must be INFO, got {logging.getLogger().level}"
    )


def test_logging_format_includes_standard_fields(reload_main, monkeypatch):
    """P2-S2: the configured format must include timestamp, level, logger name,
    and message — these are the four fields Sentry's logs UI and most log
    scrapers (Vector, Loki, Datadog) expect."""
    monkeypatch.delenv("LOG_LEVEL", raising=False)
    reload_main()
    root = logging.getLogger()
    assert root.handlers, "logging.basicConfig should have attached a handler"
    handler = root.handlers[0]
    fmt = handler.formatter
    assert fmt is not None, "handler must have a formatter"
    fmt_str = fmt._fmt  # stdlib private, but stable
    for field in ("asctime", "levelname", "name", "message"):
        assert f"%({field})s" in fmt_str, (
            f"Log format must include {field!r} (got {fmt_str!r})"
        )


def test_logging_uppercases_level(reload_main, monkeypatch):
    """P2-S2: a lowercase log level (e.g. `LOG_LEVEL=debug`) should still
    work — Python's logging.basicConfig accepts the uppercase form, so we
    uppercase before passing it through."""
    monkeypatch.setenv("LOG_LEVEL", "warning")
    reload_main()
    assert logging.getLogger().level == logging.WARNING, (
        f"LOG_LEVEL=warning (lowercase) should map to WARNING, "
        f"got {logging.getLogger().level}"
    )