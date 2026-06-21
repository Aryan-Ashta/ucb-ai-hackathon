"""Tests for /api/transcribe size + content-type limits (P1-S3)."""
import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.dependencies.auth import get_current_user
from backend.tests.conftest import fake_gh_token


@pytest.fixture(autouse=True)
def _clear_user_cache():
    """Reset the in-process user cache between tests so we do not leak state."""
    from backend.dependencies import auth

    auth._USER_CACHE.clear()
    yield
    auth._USER_CACHE.clear()


@pytest.fixture(autouse=True)
def _reset_overrides():
    """Drop any dependency overrides installed by individual tests."""
    yield
    app.dependency_overrides.clear()


def _override_user(user_dict):
    """Install a stub get_current_user for the duration of one test."""
    async def _fake():
        return user_dict
    app.dependency_overrides[get_current_user] = _fake
    return _fake


def _audio_bytes() -> bytes:
    # Tiny non-empty payload — the route only checks length + content-type before
    # delegating to Deepgram, which we mock away in these tests.
    return b"\x1a\x45\xdf\xa3" + b"\x00" * 64


def _mock_transcribe(monkeypatch, transcript: str = "memoization caches the result of expensive calls"):
    """Patch the Deepgram-backed transcribe_audio to return a fake transcript."""
    async def fake_transcribe(audio_bytes, mimetype="audio/webm"):
        assert mimetype == "audio/webm"
        assert len(audio_bytes) > 0
        return transcript

    from backend.routers import quiz as quiz_router
    monkeypatch.setattr(quiz_router, "transcribe_audio", fake_transcribe)


# --- /api/transcribe size + mime limits ------------------------------------

def test_post_transcribe_413_when_too_large(fake_redis, monkeypatch):
    # Any 11 MB payload comfortably exceeds the 10 MB cap; we never let the
    # request reach Deepgram, so the mock should not be invoked.
    def should_not_be_called(*args, **kwargs):  # pragma: no cover - defensive
        raise AssertionError("transcribe_audio must not run for oversized uploads")

    from backend.routers import quiz as quiz_router
    monkeypatch.setattr(quiz_router, "transcribe_audio", should_not_be_called)

    _override_user({"id": "7", "login": "alice", "token": fake_gh_token()})
    client = TestClient(app)
    r = client.post(
        "/api/transcribe",
        headers={"Authorization": f"Bearer {fake_gh_token()}"},
        files={"audio": ("answer.webm", b"\x00" * (11 * 1024 * 1024), "audio/webm")},
    )
    assert r.status_code == 413
    assert "too large" in r.json()["detail"].lower()


def test_post_transcribe_400_when_empty(fake_redis, monkeypatch):
    # Empty body is a separate, pre-existing case — pin the behaviour so the
    # new size + mime checks don't accidentally swallow it.
    _mock_transcribe(monkeypatch)
    _override_user({"id": "7", "login": "alice", "token": fake_gh_token()})
    client = TestClient(app)
    r = client.post(
        "/api/transcribe",
        headers={"Authorization": f"Bearer {fake_gh_token()}"},
        files={"audio": ("answer.webm", b"", "audio/webm")},
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "Empty audio file"


def test_post_transcribe_415_when_unsupported_mime(fake_redis, monkeypatch):
    # Unknown content-type must be rejected before any audio bytes are read.
    def should_not_be_called(*args, **kwargs):  # pragma: no cover - defensive
        raise AssertionError("transcribe_audio must not run for unsupported mime types")

    from backend.routers import quiz as quiz_router
    monkeypatch.setattr(quiz_router, "transcribe_audio", should_not_be_called)

    _override_user({"id": "7", "login": "alice", "token": fake_gh_token()})
    client = TestClient(app)
    r = client.post(
        "/api/transcribe",
        headers={"Authorization": f"Bearer {fake_gh_token()}"},
        files={"audio": ("answer.bin", _audio_bytes(), "audio/x-fake")},
    )
    assert r.status_code == 415
    assert "unsupported audio format" in r.json()["detail"].lower()


def test_post_transcribe_200_when_webm_codecs_opus(fake_redis, monkeypatch):
    """Browsers send audio/webm;codecs=opus — normalize before allowlist check."""
    seen_mime = {}

    async def fake_transcribe(audio_bytes, mimetype="audio/webm"):
        seen_mime["value"] = mimetype
        assert mimetype == "audio/webm"
        return "heard you"

    from backend.routers import quiz as quiz_router
    monkeypatch.setattr(quiz_router, "transcribe_audio", fake_transcribe)

    _override_user({"id": "7", "login": "alice", "token": fake_gh_token()})
    client = TestClient(app)
    r = client.post(
        "/api/transcribe",
        headers={"Authorization": f"Bearer {fake_gh_token()}"},
        files={"audio": ("answer.webm", _audio_bytes(), "audio/webm;codecs=opus")},
    )
    assert r.status_code == 200
    assert r.json() == {"transcript": "heard you"}
    assert seen_mime["value"] == "audio/webm"


def test_post_transcribe_200_when_allowed_mime(fake_redis, monkeypatch):
    # Happy path: webm content-type + valid body still transcribes successfully.
    _mock_transcribe(monkeypatch)
    _override_user({"id": "7", "login": "alice", "token": fake_gh_token()})
    client = TestClient(app)
    r = client.post(
        "/api/transcribe",
        headers={"Authorization": f"Bearer {fake_gh_token()}"},
        files={"audio": ("answer.webm", _audio_bytes(), "audio/webm")},
    )
    assert r.status_code == 200
    assert r.json() == {"transcript": "memoization caches the result of expensive calls"}
