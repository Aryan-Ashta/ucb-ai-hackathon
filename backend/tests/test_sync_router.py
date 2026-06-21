"""Tests for the sync router (auth-gated)."""
import asyncio
import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.dependencies.auth import get_current_user
from backend.tests.conftest import fake_gh_token


@pytest.fixture(autouse=True)
def _clear_user_cache():
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
    yield
    app.dependency_overrides.clear()


def test_post_sync_requires_auth():
    client = TestClient(app)
    r = client.post("/api/sync")
    assert r.status_code == 401


def test_get_sync_status_requires_auth():
    client = TestClient(app)
    r = client.get("/api/sync/status")
    assert r.status_code == 401


def test_get_sync_status_returns_null_when_never_synced(fake_redis):
    _override_user({"id": "99", "login": "alice", "token": fake_gh_token()})
    client = TestClient(app)
    r = client.get("/api/sync/status", headers={"Authorization": "Bearer x"})
    assert r.status_code == 200
    body = r.json()
    assert body["user"] == {"id": "99", "login": "alice"}
    assert body["last_sync"] is None
    assert body["last_sync_iso"] is None


def test_get_sync_status_returns_iso_when_synced(fake_redis):
    asyncio.run(_seed_last_sync("5", 1_700_000_000))
    _override_user({"id": "5", "login": "bob", "token": fake_gh_token()})
    client = TestClient(app)
    r = client.get("/api/sync/status", headers={"Authorization": "Bearer x"})
    assert r.status_code == 200
    body = r.json()
    assert body["last_sync"] == 1_700_000_000
    assert body["last_sync_iso"].startswith("2023-")  # 1_700_000_000 == 2023-11-14


def test_post_sync_runs_orchestrator_and_returns_summary(fake_redis, monkeypatch):
    from backend.routers import sync as sync_router

    async def fake_sync(token, user_id):
        return {
            "status": "ok",
            "repos_seen": 2,
            "prs_seen": 5,
            "prs_processed": 3,
            "prs_skipped": 2,
            "errors": [],
        }

    monkeypatch.setattr(sync_router, "sync_user_prs", fake_sync)
    _override_user({"id": "5", "login": "bob", "token": fake_gh_token()})

    client = TestClient(app)
    r = client.post("/api/sync", headers={"Authorization": "Bearer x"})
    assert r.status_code == 200
    body = r.json()
    assert body["user"] == {"id": "5", "login": "bob"}
    assert body["summary"]["prs_processed"] == 3


async def _seed_last_sync(user_id: str, ts: int) -> None:
    from backend.services.redis_client import set_last_sync
    await set_last_sync(user_id, ts)
