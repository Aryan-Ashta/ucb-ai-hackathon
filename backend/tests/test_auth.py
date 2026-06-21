"""Tests for the get_current_user FastAPI dependency."""
import asyncio
import json

import httpx
import pytest
import sentry_sdk
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from backend.dependencies.auth import get_current_user
from backend.tests.conftest import fake_gh_token

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
        r = c.get("/me", headers={"Authorization": f"Bearer {fake_gh_token()}"})
    assert r.status_code == 200
    assert r.json() == {"id": "4242", "login": "octocat"}


def test_github_401_returns_401(monkeypatch, fake_redis):
    _patch_github(monkeypatch, 401, {"message": "Bad credentials"})
    with TestClient(app) as c:
        r = c.get("/me", headers={"Authorization": "Bearer bad"})
    assert r.status_code == 401


def test_valid_token_persists_encrypted_to_redis(monkeypatch, fake_redis):
    from backend.services.token_store import get_token

    token = fake_gh_token("xyz")
    _patch_github(monkeypatch, 200, {"id": 99, "login": "alice"})
    with TestClient(app) as c:
        r = c.get("/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    # The dependency should have stored the token; verify by reading it back
    # and confirming the round-trip decrypts to the original plaintext.
    stored = asyncio.run(get_token("99"))
    assert stored == token


def test_second_call_uses_cache_no_second_github_hit(monkeypatch, fake_redis):
    calls = []
    token = fake_gh_token("cached")

    async def fake_get(self, url, **kw):
        calls.append(url)
        return httpx.Response(200, json={"id": 5, "login": "bob"})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    with TestClient(app) as c:
        for _ in range(3):
            c.get("/me", headers={"Authorization": f"Bearer {token}"})
    # Only the first call should hit GitHub; the next two hit the in-process cache.
    assert len(calls) == 1


# --- P1-B2: cache eviction on maxsize ---------------------------------------

def test_user_cache_is_bounded(monkeypatch, fake_redis):
    """P1-B2: The auth cache must be bounded so a flood of distinct tokens
    cannot exhaust memory. We instantiate a fresh small cache (maxsize=3) for
    this test to avoid coupling to the 10k production setting.
    """
    import cachetools
    from backend.dependencies import auth

    # Swap the production cache for a tiny one so we can hit the limit fast.
    monkeypatch.setattr(
        auth, "_USER_CACHE", cachetools.TTLCache(maxsize=3, ttl=60)
    )

    async def fake_get(self, url, **kw):
        # Different login per call so the response body changes; we only need
        # _some_ 200 response to populate the cache, but distinct payloads
        # prove each new token created its own entry.
        token = kw.get("headers", {}).get("Authorization", "")
        return httpx.Response(200, json={"id": hash(token) & 0xFFFF, "login": token[-4:]})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    with TestClient(app) as c:
        # Push 5 distinct tokens through; cache maxsize is 3.
        for i in range(5):
            r = c.get("/me", headers={"Authorization": f"Bearer {fake_gh_token(f'b2_{i}')}"})
            assert r.status_code == 200

    # After 5 inserts on a maxsize=3 cache, the cache must hold at most 3.
    assert len(auth._USER_CACHE) <= 3


def test_user_cache_ttl_expires_entries(monkeypatch, fake_redis):
    """P1-B2: TTL eviction works — an entry past its TTL must not be returned.

    We use a TTL of 0.05s and sleep past it to confirm the next read goes
    back to GitHub.
    """
    import time as _time
    import cachetools
    from backend.dependencies import auth

    monkeypatch.setattr(
        auth, "_USER_CACHE", cachetools.TTLCache(maxsize=10, ttl=0.05)
    )

    calls = []

    async def fake_get(self, url, **kw):
        calls.append(1)
        return httpx.Response(200, json={"id": 7, "login": "ttl"})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    token = fake_gh_token("ttl_1")
    with TestClient(app) as c:
        r1 = c.get("/me", headers={"Authorization": f"Bearer {token}"})
        assert r1.status_code == 200
        # Same token, should hit cache → no second GitHub call.
        r2 = c.get("/me", headers={"Authorization": f"Bearer {token}"})
        assert r2.status_code == 200
        assert len(calls) == 1
        # Sleep past TTL, then re-call → cache miss → second GitHub call.
        _time.sleep(0.1)
        r3 = c.get("/me", headers={"Authorization": f"Bearer {token}"})
        assert r3.status_code == 200
        assert len(calls) == 2


# --- P1-B3: store_token failures must be visible ----------------------------

def test_store_token_failure_captured_to_sentry(monkeypatch, fake_redis):
    """P1-B3: A Redis blip during token persistence must not block the request
    (still 200), but MUST be visible — captured to Sentry + breadcrumb.
    """
    from backend.dependencies import auth

    async def fake_get(self, url, **kw):
        return httpx.Response(200, json={"id": 11, "login": "alice"})

    async def fake_store_token_raises(user_id, token):
        raise ConnectionError("redis down")

    captured = []
    breadcrumbs = []

    def fake_capture_exception(exc):
        captured.append(exc)

    def fake_add_breadcrumb(*, category, message, level, data=None):
        breadcrumbs.append({"category": category, "message": message, "data": data})

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(auth, "store_token", fake_store_token_raises)
    monkeypatch.setattr(sentry_sdk, "capture_exception", fake_capture_exception)
    monkeypatch.setattr(sentry_sdk, "add_breadcrumb", fake_add_breadcrumb)

    with TestClient(app) as c:
        r = c.get("/me", headers={"Authorization": f"Bearer {fake_gh_token('persist_fail')}"})

    # The request still succeeds — Redis blip must not block auth.
    assert r.status_code == 200
    assert r.json() == {"id": "11", "login": "alice"}

    # But the failure IS visible: Sentry sees the exception + a breadcrumb
    # with the user id + error class so the team can debug it.
    assert len(captured) == 1
    assert isinstance(captured[0], ConnectionError)
    assert any(
        b["message"] == "token_persistence_failed"
        and b["data"]["user_id"] == "11"
        and b["data"]["error_class"] == "ConnectionError"
        for b in breadcrumbs
    )
