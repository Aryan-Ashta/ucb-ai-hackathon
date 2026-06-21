"""Tests for backend/sentry_init (P2-B10).

The module is imported as a side effect of `import backend.main`, so we reload
it under controlled env + mocked sentry_sdk.init to pin the env-driven
behaviour without actually talking to Sentry.
"""
import importlib

import pytest

import backend.sentry_init as sentry_init


@pytest.fixture
def reload_sentry_init(monkeypatch):
    """Reload sentry_init under a fresh environment and a stubbed sentry_sdk.init.

    Captures the kwargs passed to the SDK so each test can assert what the
    module computed. Returns the list of captured init calls.
    """
    captured: list[dict] = []

    def fake_init(**kwargs):
        captured.append(kwargs)

    monkeypatch.setattr("sentry_sdk.init", fake_init)
    importlib.reload(sentry_init)
    return captured


def test_sentry_init_defaults_when_env_unset(reload_sentry_init, monkeypatch):
    """P2-B10: without env vars, sample rates must default to conservative
    values (0.1 traces, 0.0 profiles), NOT 1.0/1.0 like before."""
    monkeypatch.delenv("SENTRY_TRACES_SAMPLE_RATE", raising=False)
    monkeypatch.delenv("SENTRY_PROFILES_SAMPLE_RATE", raising=False)
    importlib.reload(sentry_init)

    assert reload_sentry_init, "sentry_sdk.init was not called on reload"
    last = reload_sentry_init[-1]
    assert last["traces_sample_rate"] == 0.1, (
        f"Default traces_sample_rate must be 0.1, got {last['traces_sample_rate']}"
    )
    assert last["profiles_sample_rate"] == 0.0, (
        f"Default profiles_sample_rate must be 0.0, got {last['profiles_sample_rate']}"
    )


def test_sentry_init_reads_env_values(reload_sentry_init, monkeypatch):
    """P2-B10: explicit env values must propagate to sentry_sdk.init."""
    monkeypatch.setenv("SENTRY_TRACES_SAMPLE_RATE", "0.25")
    monkeypatch.setenv("SENTRY_PROFILES_SAMPLE_RATE", "0.05")
    importlib.reload(sentry_init)

    last = reload_sentry_init[-1]
    assert last["traces_sample_rate"] == 0.25
    assert last["profiles_sample_rate"] == 0.05


def test_sentry_init_handles_invalid_env_values(monkeypatch):
    """P2-B10: a malformed env value must NOT crash SDK init — fall back to
    the default rather than breaking the deploy."""
    monkeypatch.setenv("SENTRY_TRACES_SAMPLE_RATE", "not-a-number")
    monkeypatch.setenv("SENTRY_PROFILES_SAMPLE_RATE", "")

    captured: list[dict] = []

    def fake_init(**kwargs):
        captured.append(kwargs)

    monkeypatch.setattr("sentry_sdk.init", fake_init)
    importlib.reload(sentry_init)

    last = captured[-1]
    # Invalid → fall back to default (0.1 / 0.0).
    assert last["traces_sample_rate"] == 0.1
    assert last["profiles_sample_rate"] == 0.0


def test_sentry_init_clamps_out_of_range_values(monkeypatch):
    """P2-B10: Sentry accepts rates in [0.0, 1.0]. Out-of-range inputs (e.g.
    someone setting 2.5 for 'definitely catch all of them') must be clamped
    rather than silently ignored — this keeps the value usable and prevents
    a confused deploy from accidentally leaving the prior 1.0 in effect."""
    monkeypatch.setenv("SENTRY_TRACES_SAMPLE_RATE", "2.5")
    monkeypatch.setenv("SENTRY_PROFILES_SAMPLE_RATE", "-0.5")

    captured: list[dict] = []

    def fake_init(**kwargs):
        captured.append(kwargs)

    monkeypatch.setattr("sentry_sdk.init", fake_init)
    importlib.reload(sentry_init)

    last = captured[-1]
    assert last["traces_sample_rate"] == 1.0, (
        f"traces_sample_rate must clamp to 1.0, got {last['traces_sample_rate']}"
    )
    assert last["profiles_sample_rate"] == 0.0, (
        f"profiles_sample_rate must clamp to 0.0, got {last['profiles_sample_rate']}"
    )


def test_sentry_init_module_exposes_rates_for_inspection():
    """P2-B10: TRACES_SAMPLE_RATE / PROFILES_SAMPLE_RATE are module-level
    constants so an operator can `print(backend.sentry_init.TRACES_SAMPLE_RATE)`
    in a shell to verify the value the SDK is using without reading the env."""
    assert hasattr(sentry_init, "TRACES_SAMPLE_RATE")
    assert hasattr(sentry_init, "PROFILES_SAMPLE_RATE")
    assert isinstance(sentry_init.TRACES_SAMPLE_RATE, float)
    assert isinstance(sentry_init.PROFILES_SAMPLE_RATE, float)
    assert 0.0 <= sentry_init.TRACES_SAMPLE_RATE <= 1.0
    assert 0.0 <= sentry_init.PROFILES_SAMPLE_RATE <= 1.0