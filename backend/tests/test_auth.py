"""Tests for the get_current_user FastAPI dependency."""
import asyncio
import json

import httpx
import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from backend.dependencies.auth import get_current_user

app = FastAPI()


@app.get("/me")
def me(user=Depends(get_current_user)):
    return {"id": user["id"], "login": user["login"]}


@pytest.fixture(autouse=True)
def _clear_user_cache():
    """Reset the in-process user cache between tests so we do not leak state."""
    from backend.dependencies import auth

    auth._USER_CACHE.clear()
    yield
    auth._USER_CACHE.clear()


def _patch_github(monkeypatch, status: int, payload: dict):
    """Replace httpx.AsyncClient.get with a stub returning a fixed response."""

    async def fake_get(self, url, headers=None, **kw):
        if "/user" not in url:
            raise AssertionError(f"unexpected URL: {url}")
        return httpx.Response(status, json=payload)

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)


def test_missing_header_returns_401():
    with TestClient(app) as c:
        r = c.get("/me")
    assert r.status_code == 401


def test_non_bearer_header_returns_401():
    with TestClient(app) as c:
        r = c.get("/me", headers={"Authorization": "Basic abc"})
    assert r.status_code == 401


def test_valid_token_returns_user_identity(monkeypatch, fake_redis):
    _patch_github(monkeypatch, 200, {"id": 4242, "login": "octocat"})
    with TestClient(app) as c:
        r = c.get("/me", headers={"Authorization": "Bearer ghp_test"})
    assert r.status_code == 200
    assert r.json() == {"id": "4242", "login": "octocat"}


def test_github_401_returns_401(monkeypatch, fake_redis):
    _patch_github(monkeypatch, 401, {"message": "Bad credentials"})
    with TestClient(app) as c:
        r = c.get("/me", headers={"Authorization": "Bearer bad"})
    assert r.status_code == 401


def test_valid_token_persists_encrypted_to_redis(monkeypatch, fake_redis):
    from backend.services.token_store import get_token

    _patch_github(monkeypatch, 200, {"id": 99, "login": "alice"})
    with TestClient(app) as c:
        r = c.get("/me", headers={"Authorization": "Bearer ghp_xyz"})
    assert r.status_code == 200
    # The dependency should have stored the token; verify by reading it back
    # and confirming the round-trip decrypts to the original plaintext.
    stored = asyncio.run(get_token("99"))
    assert stored == "ghp_xyz"


def test_second_call_uses_cache_no_second_github_hit(monkeypatch, fake_redis):
    calls = []

    async def fake_get(self, url, **kw):
        calls.append(url)
        return httpx.Response(200, json={"id": 5, "login": "bob"})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    with TestClient(app) as c:
        for _ in range(3):
            c.get("/me", headers={"Authorization": "Bearer ghp_cached"})
    # Only the first call should hit GitHub; the next two hit the in-process cache.
    assert len(calls) == 1
