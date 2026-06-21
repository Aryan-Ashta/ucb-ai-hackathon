"""Tests for the enrich router (auth-gated)."""
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


def test_post_enrich_requires_auth():
    client = TestClient(app)
    r = client.post(
        "/api/enrich",
        json={"concept_id": "abc:1:memoization", "concept": "memoization"},
    )
    assert r.status_code == 401


def test_post_enrich_returns_snippet(monkeypatch):
    from backend.routers import enrich as enrich_router

    async def fake_enrich_concept(concept, concept_id, user_id):
        assert concept == "memoization"
        assert concept_id == "abc:1:memoization"
        assert user_id == "99"
        return {"snippet": "MDN snippet text", "ok": True, "error": None}

    monkeypatch.setattr(enrich_router, "enrich_concept", fake_enrich_concept)

    _override_user({"id": "99", "login": "alice", "token": "ghp_test"})
    client = TestClient(app)
    r = client.post(
        "/api/enrich",
        json={"concept_id": "abc:1:memoization", "concept": "memoization"},
        headers={"Authorization": "Bearer ghp_test"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["snippet"] == "MDN snippet text"
    assert body["ok"] is True
    assert body["error"] is None


def test_post_enrich_returns_error_envelope_on_service_failure(monkeypatch):
    """P1-B8: enrich_concept returns a structured {snippet, ok, error}
    envelope on any failure. The router propagates it as-is so the UI can
    distinguish "no docs found" from "Browserbase is down".
    """
    from backend.routers import enrich as enrich_router

    async def fake_enrich_concept(concept, concept_id, user_id):
        return {"snippet": "", "ok": False, "error": "ConnectError"}

    monkeypatch.setattr(enrich_router, "enrich_concept", fake_enrich_concept)

    _override_user({"id": "99", "login": "alice", "token": "ghp_test"})
    client = TestClient(app)
    r = client.post(
        "/api/enrich",
        json={"concept_id": "abc:1:memoization", "concept": "memoization"},
        headers={"Authorization": "Bearer ghp_test"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["snippet"] == ""
    assert body["ok"] is False
    assert body["error"] == "ConnectError"
