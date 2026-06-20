import hashlib
import hmac

import sentry_sdk
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request

from backend.config import GITHUB_WEBHOOK_SECRET
from backend.services.claude import extract_concepts_and_cache
from backend.services.diff_parser import fetch_and_parse_diff

router = APIRouter()


def verify_signature(payload: bytes, sig_header: str) -> bool:
    expected = "sha256=" + hmac.new(
        GITHUB_WEBHOOK_SECRET.encode(), payload, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, sig_header)


@router.post("/webhook/github")
async def github_webhook(request: Request, background_tasks: BackgroundTasks):
    payload_bytes = await request.body()
    sig = request.headers.get("X-Hub-Signature-256", "")

    if not verify_signature(payload_bytes, sig):
        raise HTTPException(status_code=401, detail="Invalid signature")

    payload = await request.json()

    # Only process merged PRs.
    if payload.get("action") != "closed" or not payload.get("pull_request", {}).get(
        "merged"
    ):
        return {"status": "ignored"}

    pr = payload["pull_request"]
    repo_full_name = payload["repository"]["full_name"]
    pr_number = pr["number"]
    user_id = str(pr["user"]["id"])

    sentry_sdk.add_breadcrumb(
        category="webhook",
        message=f"Received merged PR #{pr_number} from {repo_full_name}",
        level="info",
    )

    background_tasks.add_task(
        run_ingestion_pipeline,
        repo_full_name=repo_full_name,
        pr_number=pr_number,
        user_id=user_id,
    )

    return {"status": "accepted"}


async def run_ingestion_pipeline(repo_full_name: str, pr_number: int, user_id: str):
    with sentry_sdk.start_transaction(op="ingestion", name=f"PR #{pr_number}"):
        diff_text = await fetch_and_parse_diff(repo_full_name, pr_number)
        if diff_text:
            await extract_concepts_and_cache(diff_text, user_id, pr_number)
