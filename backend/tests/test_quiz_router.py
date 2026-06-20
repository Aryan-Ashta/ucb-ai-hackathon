"""Tests for the quiz router (transcribe + grade), all auth-gated."""
import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.dependencies.auth import get_current_user


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
    # Tiny non-empty payload — the route only checks length > 0 before
    # delegating to Deepgram, which we mock away in these tests.
    return b"\x1a\x45\xdf\xa3" + b"\x00" * 64


# --- /api/transcribe --------------------------------------------------------

def test_post_transcribe_requires_auth():
    client = TestClient(app)
    r = client.post(
        "/api/transcribe",
        files={"audio": ("answer.webm", _audio_bytes(), "audio/webm")},
    )
    assert r.status_code == 401


def test_post_transcribe_with_auth_returns_transcript(fake_redis, monkeypatch):
    async def fake_transcribe(audio_bytes, mimetype="audio/webm"):
        assert mimetype == "audio/webm"
        assert len(audio_bytes) > 0
        return "memoization caches the result of expensive calls"

    from backend.routers import quiz as quiz_router
    monkeypatch.setattr(quiz_router, "transcribe_audio", fake_transcribe)

    _override_user({"id": "7", "login": "alice", "token": "ghp_test"})
    client = TestClient(app)
    r = client.post(
        "/api/transcribe",
        headers={"Authorization": "Bearer ghp_test"},
        files={"audio": ("answer.webm", _audio_bytes(), "audio/webm")},
    )
    assert r.status_code == 200
    assert r.json() == {"transcript": "memoization caches the result of expensive calls"}


def test_post_transcribe_empty_audio_returns_400(fake_redis):
    _override_user({"id": "7", "login": "alice", "token": "ghp_test"})
    client = TestClient(app)
    r = client.post(
        "/api/transcribe",
        headers={"Authorization": "Bearer ghp_test"},
        files={"audio": ("answer.webm", b"", "audio/webm")},
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "Empty audio file"


def test_post_transcribe_no_speech_returns_error_payload(fake_redis, monkeypatch):
    async def fake_transcribe(audio_bytes, mimetype="audio/webm"):
        return ""

    from backend.routers import quiz as quiz_router
    monkeypatch.setattr(quiz_router, "transcribe_audio", fake_transcribe)

    _override_user({"id": "7", "login": "alice", "token": "ghp_test"})
    client = TestClient(app)
    r = client.post(
        "/api/transcribe",
        headers={"Authorization": "Bearer ghp_test"},
        files={"audio": ("answer.webm", _audio_bytes(), "audio/webm")},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["transcript"] == ""
    assert "try again" in body["error"].lower()