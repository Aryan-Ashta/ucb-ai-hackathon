"""Tests for the concepts router (single-concept lookup, auth-gated)."""
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


def _override_user(user_dict):
    """Install a stub get_current_user for the duration of one test."""
    async def _fake():
        return user_dict
    app.dependency_overrides[get_current_user] = _fake
    return _fake


@pytest.fixture(autouse=True)
def _reset_overrides():
    """Drop any dependency overrides installed by individual tests."""
    yield
    app.dependency_overrides.clear()


# --- GET /api/concepts/{concept_id} -----------------------------------------

def test_get_concept_by_id_requires_auth():
    client = TestClient(app)
    r = client.get("/api/concepts/abc:1:memoization")
    assert r.status_code == 401


async def test_get_concept_by_id_returns_concept_when_found(fake_redis):
    """Verify the real get_quiz_content path returns the flattened Concept shape."""
    from backend.models import QuizConcept
    from backend.services.redis_client import cache_quiz_content

    concept = QuizConcept(
        concept_id="99:1:memoization",
        concept="Memoization",
        roast_text="You're caching results like a squirrel hoards nuts.",
        question_text="What does memoization do?",
        answer_hint="cache, lookup, repeated",
        repo="alice/repo",
        pr_title="Add caching layer",
    )
    await cache_quiz_content("99", concept)

    _override_user({"id": "99", "login": "alice", "token": "ghp_test"})
    client = TestClient(app)
    r = client.get(
        "/api/concepts/99:1:memoization",
        headers={"Authorization": "Bearer x"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["user_id"] == "99"
    c = body["concept"]
    # Verify the flattened frontend-compatible Concept shape
    assert c["id"] == "99:1:memoization"
    assert c["concept"] == "Memoization"
    assert c["repo"] == "alice/repo"
    assert c["pr_title"] == "Add caching layer"
    assert c["pr_number"] == 1
    assert isinstance(c["next_review"], str) and "T" in c["next_review"]  # ISO string
    assert isinstance(c["ease_factor"], float)
    assert isinstance(c["interval"], int)
    assert isinstance(c["repetitions"], int)
    assert "concept_id" not in c, "legacy concept_id key must not leak to frontend"
    assert "state" not in c, "nested state must not leak to frontend"


def test_get_concept_by_id_404_when_missing(fake_redis, monkeypatch):
    async def fake_get_quiz_content(user_id, concept_id):
        return None

    from backend.routers import concepts as concepts_router
    monkeypatch.setattr(concepts_router, "get_quiz_content", fake_get_quiz_content)

    _override_user({"id": "99", "login": "alice", "token": "ghp_test"})
    client = TestClient(app)
    r = client.get(
        "/api/concepts/nope:nope:nope",
        headers={"Authorization": "Bearer x"},
    )
    assert r.status_code == 404
    assert r.json() == {"detail": "Concept not found"}
