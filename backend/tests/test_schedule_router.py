"""Tests for the schedule router (auth-gated)."""
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


@pytest.fixture(autouse=True)
def _poke_calendar_id(monkeypatch):
    """P1-B7: POKE_USER_CALENDAR_ID is server-side. Default to a stub for the
    happy-path tests; individual tests can override the env or patch the
    config module directly to exercise the unset / set / mismatch paths.
    """
    import backend.config as cfg

    monkeypatch.setattr(cfg, "POKE_USER_CALENDAR_ID", "cal-server-default", raising=False)


def _override_user(user_dict):
    """Install a stub get_current_user for the duration of one test."""
    async def _fake():
        return user_dict
    app.dependency_overrides[get_current_user] = _fake
    return _fake


def test_post_schedule_review_requires_auth():
    client = TestClient(app)
    r = client.post(
        "/api/schedule-review",
        json={
            "concept_id": "abc:1:memoization",
            "next_review_timestamp": 1_719_000_000,
        },
    )
    assert r.status_code == 401


def test_post_schedule_review_404_when_concept_not_in_redis(monkeypatch):
    from backend.routers import schedule as schedule_router

    async def fake_get_quiz_content(user_id, concept_id):
        assert user_id == "99"
        assert concept_id == "abc:1:memoization"
        return None

    monkeypatch.setattr(schedule_router, "get_quiz_content", fake_get_quiz_content)

    _override_user({"id": "99", "login": "alice", "token": "ghp_test"})
    client = TestClient(app)
    r = client.post(
        "/api/schedule-review",
        json={
            "concept_id": "abc:1:memoization",
            "next_review_timestamp": 1_719_000_000,
        },
        headers={"Authorization": "Bearer ghp_test"},
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "Concept not found"


def test_post_schedule_review_returns_scheduled_event(monkeypatch):
    from backend.routers import schedule as schedule_router

    fake_event = {
        "id": "evt-123",
        "title": "VibeSchool: review memoization",
        "start": "2026-06-25T10:00:00+00:00",
    }

    async def fake_get_quiz_content(user_id, concept_id):
        return {
            "concept": "memoization",
            "roast_text": "cached, like your brain on second thought",
            "question_text": "What does memoization trade?",
            "answer_hint": "memory for speed",
        }

    async def fake_schedule_review_block(
        concept_name, concept_id, next_review_timestamp, user_calendar_id
    ):
        # P1-B7: calendar_id now comes from config (server-side), NOT the
        # request body. Tests must pin to whatever _poke_calendar_id set.
        assert concept_name == "memoization"
        assert concept_id == "abc:1:memoization"
        assert next_review_timestamp == 1_719_000_000
        assert user_calendar_id == "cal-server-default"
        return fake_event

    monkeypatch.setattr(schedule_router, "get_quiz_content", fake_get_quiz_content)
    monkeypatch.setattr(schedule_router, "schedule_review_block", fake_schedule_review_block)

    _override_user({"id": "99", "login": "alice", "token": "ghp_test"})
    client = TestClient(app)
    r = client.post(
        "/api/schedule-review",
        json={
            "concept_id": "abc:1:memoization",
            "next_review_timestamp": 1_719_000_000,
        },
        headers={"Authorization": "Bearer ghp_test"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "scheduled"
    assert body["event"] == fake_event


def test_post_schedule_review_validation_error_on_missing_field():
    """Missing concept_id + next_review_timestamp → 422 from Pydantic.

    P1-B7: user_calendar_id is NO LONGER in the body schema; the server
    resolves it from config.POKE_USER_CALENDAR_ID.
    """
    _override_user({"id": "99", "login": "alice", "token": "ghp_test"})
    client = TestClient(app)
    r = client.post(
        "/api/schedule-review",
        json={},
        headers={"Authorization": "Bearer ghp_test"},
    )
    assert r.status_code == 422
    missing = {err["loc"][-1] for err in r.json()["detail"]}
    assert "concept_id" in missing
    assert "next_review_timestamp" in missing
    assert "user_calendar_id" not in missing  # P1-B7: gone from schema


def test_post_schedule_review_503_when_poke_calendar_unset(monkeypatch):
    """P1-B7: if POKE_USER_CALENDAR_ID is empty in the env, refuse with 503
    rather than silently dropping or letting the client supply one.
    """
    import backend.config as cfg
    monkeypatch.setattr(cfg, "POKE_USER_CALENDAR_ID", "", raising=False)

    _override_user({"id": "99", "login": "alice", "token": "ghp_test"})
    client = TestClient(app)
    r = client.post(
        "/api/schedule-review",
        json={
            "concept_id": "abc:1:memoization",
            "next_review_timestamp": 1_719_000_000,
        },
        headers={"Authorization": "Bearer ghp_test"},
    )
    assert r.status_code == 503
    assert "POKE_USER_CALENDAR_ID" in r.json()["detail"]


def test_post_schedule_review_ignores_body_supplied_calendar_id(monkeypatch):
    """P1-B7 regression guard: even if a hostile client sends a user_calendar_id
    in the body, the server must use the server-side value, not the body's.
    Pydantic drops the extra field silently; the assertion is that the
    Poke call gets `cal-server-default`, NOT whatever the client tried to send.
    """
    from backend.routers import schedule as schedule_router

    async def fake_get_quiz_content(user_id, concept_id):
        return {"concept": "memoization"}

    seen = {}

    async def fake_schedule_review_block(
        concept_name, concept_id, next_review_timestamp, user_calendar_id
    ):
        seen["calendar_id"] = user_calendar_id
        return {"id": "evt-1"}

    monkeypatch.setattr(schedule_router, "get_quiz_content", fake_get_quiz_content)
    monkeypatch.setattr(schedule_router, "schedule_review_block", fake_schedule_review_block)

    _override_user({"id": "99", "login": "alice", "token": "ghp_test"})
    client = TestClient(app)
    r = client.post(
        "/api/schedule-review",
        json={
            "concept_id": "abc:1:memoization",
            "next_review_timestamp": 1_719_000_000,
            "user_calendar_id": "cal-attacker-supplied",  # ignored
        },
        headers={"Authorization": "Bearer ghp_test"},
    )
    assert r.status_code == 200
    assert seen["calendar_id"] == "cal-server-default"


def test_post_schedule_review_poke_failure_returns_error_envelope(monkeypatch):
    """P1-PK: a Poke-side failure (HTTPError, RequestError, malformed
    response) must surface as {status: "failed", error: "..."} with status 200,
    NOT propagate to a 500. The grade + SM-2 update already happened upstream
    — this endpoint is a calendar side-effect, so failing soft is correct.
    """
    import httpx as _httpx

    from backend.routers import schedule as schedule_router

    async def fake_get_quiz_content(user_id, concept_id):
        return {
            "concept": "memoization",
            "roast_text": "cached",
            "question_text": "Q?",
            "answer_hint": "memory for speed",
        }

    async def fake_schedule_review_raises(
        concept_name, concept_id, next_review_timestamp, user_calendar_id
    ):
        raise _httpx.ConnectError("dns lookup failed for api.interaction.co")

    monkeypatch.setattr(schedule_router, "get_quiz_content", fake_get_quiz_content)
    monkeypatch.setattr(schedule_router, "schedule_review_block", fake_schedule_review_raises)

    _override_user({"id": "99", "login": "alice", "token": "ghp_test"})
    client = TestClient(app)
    r = client.post(
        "/api/schedule-review",
        json={
            "concept_id": "abc:1:memoization",
            "next_review_timestamp": 1_719_000_000,
        },
        headers={"Authorization": "Bearer ghp_test"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "failed"
    assert "unavailable" in body["error"].lower() or "service" in body["error"].lower()
