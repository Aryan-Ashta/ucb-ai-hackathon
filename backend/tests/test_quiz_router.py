"""Tests for the quiz router (transcribe + grade), all auth-gated."""
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

    _override_user({"id": "7", "login": "alice", "token": fake_gh_token()})
    client = TestClient(app)
    r = client.post(
        "/api/transcribe",
        headers={"Authorization": f"Bearer {fake_gh_token()}"},
        files={"audio": ("answer.webm", _audio_bytes(), "audio/webm")},
    )
    assert r.status_code == 200
    assert r.json() == {"transcript": "memoization caches the result of expensive calls"}


def test_post_transcribe_empty_audio_returns_400(fake_redis):
    _override_user({"id": "7", "login": "alice", "token": fake_gh_token()})
    client = TestClient(app)
    r = client.post(
        "/api/transcribe",
        headers={"Authorization": f"Bearer {fake_gh_token()}"},
        files={"audio": ("answer.webm", b"", "audio/webm")},
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "Empty audio file"


def test_post_transcribe_no_speech_returns_error_payload(fake_redis, monkeypatch):
    async def fake_transcribe(audio_bytes, mimetype="audio/webm"):
        return ""

    from backend.routers import quiz as quiz_router
    monkeypatch.setattr(quiz_router, "transcribe_audio", fake_transcribe)

    _override_user({"id": "7", "login": "alice", "token": fake_gh_token()})
    client = TestClient(app)
    r = client.post(
        "/api/transcribe",
        headers={"Authorization": f"Bearer {fake_gh_token()}"},
        files={"audio": ("answer.webm", _audio_bytes(), "audio/webm")},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["transcript"] == ""
    assert "try again" in body["error"].lower()


def test_post_transcribe_deepgram_failure_returns_error_envelope(fake_redis, monkeypatch):
    """P1-DG: a Deepgram-side failure must surface as a clean error envelope
    with status 200, NOT a 500. The UI's existing {transcript:"", error:"..."}
    shape handles this transparently.
    """
    import httpx as _httpx

    async def fake_transcribe_raises(audio_bytes, mimetype="audio/webm"):
        # Simulate the most common Deepgram failure modes: HTTPError on 5xx,
        # RequestError on network/timeout. Both must be caught.
        raise _httpx.HTTPError("502 Bad Gateway from Deepgram")

    from backend.routers import quiz as quiz_router
    monkeypatch.setattr(quiz_router, "transcribe_audio", fake_transcribe_raises)

    _override_user({"id": "7", "login": "alice", "token": fake_gh_token()})
    client = TestClient(app)
    r = client.post(
        "/api/transcribe",
        headers={"Authorization": f"Bearer {fake_gh_token()}"},
        files={"audio": ("answer.webm", _audio_bytes(), "audio/webm")},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["transcript"] == ""
    assert "unavailable" in body["error"].lower() or "service" in body["error"].lower()


def test_post_transcribe_deepgram_malformed_json_returns_error_envelope(fake_redis, monkeypatch):
    """P1-DG: a malformed response (KeyError on parsing the transcript path)
    must also be caught — same envelope as a transport-level failure."""
    async def fake_transcribe_raises(audio_bytes, mimetype="audio/webm"):
        raise KeyError("results")

    from backend.routers import quiz as quiz_router
    monkeypatch.setattr(quiz_router, "transcribe_audio", fake_transcribe_raises)

    _override_user({"id": "7", "login": "alice", "token": fake_gh_token()})
    client = TestClient(app)
    r = client.post(
        "/api/transcribe",
        headers={"Authorization": f"Bearer {fake_gh_token()}"},
        files={"audio": ("answer.webm", _audio_bytes(), "audio/webm")},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["transcript"] == ""
    assert body["error"]  # non-empty error


# --- /api/tts -------------------------------------------------------------


def test_post_tts_requires_auth():
    client = TestClient(app)
    r = client.post("/api/tts", json={"text": "Hello from the examiner."})
    assert r.status_code == 401


def test_post_tts_with_auth_returns_audio(fake_redis, monkeypatch):
    async def fake_synthesize(text: str):
        assert text == "Hello from the examiner."
        return b"\xff\xfb\x90" + b"\x00" * 32

    from backend.routers import quiz as quiz_router
    monkeypatch.setattr(quiz_router, "synthesize_speech", fake_synthesize)

    _override_user({"id": "7", "login": "alice", "token": fake_gh_token()})
    client = TestClient(app)
    r = client.post(
        "/api/tts",
        headers={"Authorization": f"Bearer {fake_gh_token()}"},
        json={"text": "Hello from the examiner."},
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("audio/mpeg")
    assert len(r.content) > 0


# --- /api/grade -------------------------------------------------------------


def test_post_grade_requires_auth():
    client = TestClient(app)
    r = client.post(
        "/api/grade",
        json={"concept_id": "u1:42:fib", "transcript": "memoization"},
    )
    assert r.status_code == 401


def test_post_grade_unknown_concept_returns_404(fake_redis, monkeypatch):
    """The router already returns 404 if get_quiz_content is None (no quiz key)."""
    async def fake_grade(**_kwargs):
        return {"passed": True, "quality": 5, "explanation": "ok"}

    from backend.routers import quiz as quiz_router
    monkeypatch.setattr(quiz_router, "grade_answer", fake_grade)

    _override_user({"id": "7", "login": "alice", "token": fake_gh_token()})
    client = TestClient(app)
    r = client.post(
        "/api/grade",
        headers={"Authorization": f"Bearer {fake_gh_token()}"},
        json={"concept_id": "7:42:fib", "transcript": "memoization"},
    )
    assert r.status_code == 404
    assert "not found" in r.json()["detail"].lower()


def test_post_grade_idor_blocks_cross_user_concept(fake_redis, monkeypatch):
    """Trace 2 H4 (Quiz #4): a user_id segment in the concept_id that
    doesn't match the signed-in user must be rejected with 403, BEFORE
    grade_answer runs (which would leak work + spend tokens).
    """
    from backend.routers import quiz as quiz_router

    grade_called = False

    async def fake_grade(**_kwargs):
        nonlocal grade_called
        grade_called = True
        return {"passed": True, "quality": 5, "explanation": "ok"}

    monkeypatch.setattr(quiz_router, "grade_answer", fake_grade)

    _override_user({"id": "7", "login": "alice", "token": fake_gh_token()})
    client = TestClient(app)
    # User "7" tries to grade a concept belonging to user "999" —
    # the IDOR check must reject this with 403.
    r = client.post(
        "/api/grade",
        headers={"Authorization": f"Bearer {fake_gh_token()}"},
        json={"concept_id": "999:42:fib", "transcript": "memoization"},
    )
    assert r.status_code == 403
    assert "does not belong" in r.json()["detail"].lower()
    # Critical: Claude was NOT called.
    assert not grade_called, "grade_answer must not be called on cross-user concept_id"


def test_post_grade_stale_state_returns_404_instead_of_500(fake_redis, monkeypatch):
    """P2-B8: if update_sm2_state raises ValueError (e.g. the state key TTL'd
    out mid-quiz), the router must surface a 404 with a re-sync message instead
    of leaking a 500. The UI then asks the user to re-sync."""
    async def fake_grade(**_kwargs):
        return {"passed": True, "quality": 5, "explanation": "ok"}

    async def fake_get_quiz_content(_user_id, _concept_id):
        # Return a valid quiz payload so the router reaches update_sm2_state.
        # IDOR check (Quiz #4) now requires user_segment == user["id"];
        # since the test's _override_user sets id="7", use "7:42:fib" here
        # so we get past the IDOR check and reach the update_sm2_state path.
        return {
            "id": "7:42:fib",
            "concept": "fib", "roast_text": "", "question_text": "q",
            "answer_hint": "h", "repo": "x/y", "pr_title": "t",
            "pr_number": 42, "ease_factor": 2.5, "interval": 1,
            "repetitions": 0, "next_review": "1970-01-01T00:00:00+00:00",
        }

    async def fake_update_sm2_state_raises(*_args, **_kwargs):
        raise ValueError("No state found for concept 7:42:fib")

    from backend.routers import quiz as quiz_router
    monkeypatch.setattr(quiz_router, "grade_answer", fake_grade)
    monkeypatch.setattr(quiz_router, "get_quiz_content", fake_get_quiz_content)
    # P2-B8: the wrap is in the helper, which calls into update_sm2_state via
    # the redis_client symbol imported into the router module.
    monkeypatch.setattr(quiz_router, "update_sm2_state", fake_update_sm2_state_raises)

    _override_user({"id": "7", "login": "alice", "token": fake_gh_token()})
    client = TestClient(app)
    r = client.post(
        "/api/grade",
        headers={"Authorization": f"Bearer {fake_gh_token()}"},
        json={"concept_id": "7:42:fib", "transcript": "memoization"},
    )
    assert r.status_code == 404, (
        f"Stale concept state must surface as 404, got {r.status_code}: {r.text}"
    )
    assert "re-sync" in r.json()["detail"].lower()