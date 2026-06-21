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
            "user_calendar_id": "cal-xyz",
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
            "user_calendar_id": "cal-xyz",
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
        assert concept_name == "memoization"
        assert concept_id == "abc:1:memoization"
        assert next_review_timestamp == 1_719_000_000
        assert user_calendar_id == "cal-xyz"
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
            "user_calendar_id": "cal-xyz",
        },
        headers={"Authorization": "Bearer ghp_test"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "scheduled"
    assert body["event"] == fake_event


def test_post_schedule_review_validation_error_on_missing_field():
    """Missing concept_id (and the other required fields) → 422 from Pydantic."""
    _override_user({"id": "99", "login": "alice", "token": "ghp_test"})
    client = TestClient(app)
    r = client.post(
        "/api/schedule-review",
        json={},
        headers={"Authorization": "Bearer ghp_test"},
    )
    assert r.status_code == 422
    # Pydantic's 422 payload lists the missing fields by name.
    missing = {err["loc"][-1] for err in r.json()["detail"]}
    assert "concept_id" in missing
    assert "next_review_timestamp" in missing
    assert "user_calendar_id" in missing
