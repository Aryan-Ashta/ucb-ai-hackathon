"""Webhook router tests using FastAPI TestClient — no external calls exercised."""
import hashlib
import hmac
import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.config import GITHUB_WEBHOOK_SECRET
from backend.main import app
from backend.routers.webhook import verify_signature

client = TestClient(app)
PAYLOAD = (Path(__file__).parent / "fixtures" / "pr_payload.json").read_bytes()


def _sign(body: bytes) -> str:
    return "sha256=" + hmac.new(
        GITHUB_WEBHOOK_SECRET.encode(), body, hashlib.sha256
    ).hexdigest()


def test_verify_signature_roundtrip():
    body = b'{"hello": "world"}'
    assert verify_signature(body, _sign(body)) is True
    assert verify_signature(body, "sha256=deadbeef") is False


def test_invalid_signature_returns_401():
    resp = client.post(
        "/api/webhook/github",
        content=PAYLOAD,
        headers={"X-Hub-Signature-256": "sha256=bad", "Content-Type": "application/json"},
    )
    assert resp.status_code == 401


def test_non_merged_pr_is_ignored():
    body = json.dumps(
        {
            "action": "opened",
            "pull_request": {"number": 1, "merged": False, "user": {"id": 1}},
            "repository": {"full_name": "octocat/hello-world"},
        }
    ).encode()
    resp = client.post(
        "/api/webhook/github",
        content=body,
        headers={"X-Hub-Signature-256": _sign(body), "Content-Type": "application/json"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"status": "ignored"}
