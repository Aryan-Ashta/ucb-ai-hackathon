import httpx
import sentry_sdk
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from backend.dependencies.auth import get_current_user
from backend.services.claude import grade_answer
from backend.services.deepgram_stt import transcribe_audio
from backend.services.redis_client import get_quiz_content, update_sm2_state

router = APIRouter()

# --- /api/transcribe limits -------------------------------------------------
# Cap body size so a runaway client can't push a huge file at a Deepgram-billed
# endpoint (P1-S3 in STATUS.md). Whitelist content-types because the route
# forwards `audio.content_type` to Deepgram and unknown types would just be
# rejected upstream — fail fast with a clear error instead.
MAX_AUDIO_BYTES: int = 10 * 1024 * 1024  # 10 MB
ALLOWED_MIME_TYPES: set[str] = {"audio/webm", "audio/wav", "audio/mpeg", "audio/ogg"}


@router.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    user=Depends(get_current_user),
):
    """
    Accept audio/webm from a browser MediaRecorder, return the transcript.

    Auth-gated: requires `Authorization: Bearer <githu...n>`.
    The signed-in user is resolved by `get_current_user` but the endpoint
    itself does not need `user["id"]` (transcription is per-request, not
    per-user); the dependency exists so unauthenticated callers cannot
    burn the Deepgram API key.
    """
    if audio.content_type and audio.content_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(
            status_code=415,
            detail=(
                f"Unsupported audio format: {audio.content_type}. "
                "Use webm, wav, mp3, or ogg."
            ),
        )

    audio_bytes = await audio.read()

    if len(audio_bytes) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Audio file too large (max {MAX_AUDIO_BYTES // (1024 * 1024)} MB)",
        )

    if len(audio_bytes) == 0:
        raise HTTPException(status_code=400, detail="Empty audio file")

    # P1-DG: transcribe_audio raises on any Deepgram failure (auth, network, 5xx,
    # timeout, malformed JSON). We surface those as a clean error envelope
    # instead of letting httpx.HTTPError propagate to a 500 — the UI already
    # handles {transcript: "", error: "..."} (matches the no-speech shape).
    with sentry_sdk.start_span(op="deepgram.stt", name="Transcribe audio"):
        try:
            transcript = await transcribe_audio(
                audio_bytes, mimetype=audio.content_type or "audio/webm"
            )
        except (httpx.HTTPError, httpx.RequestError, ValueError, KeyError) as e:
            sentry_sdk.capture_exception(e)
            return {
                "transcript": "",
                "error": f"Transcription service unavailable: {type(e).__name__}",
            }

    if not transcript:
        return {"transcript": "", "error": "No speech detected -- please try again"}

    return {"transcript": transcript}


class GradeRequest(BaseModel):
    concept_id: str
    transcript: str


@router.post("/grade")
async def grade(req: GradeRequest, user=Depends(get_current_user)):
    """Grade a spoken answer and update SM-2 state for the signed-in user."""
    quiz = await get_quiz_content(user["id"], req.concept_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Concept not found in Redis")

    with sentry_sdk.start_span(op="claude.grade", name="Grade answer"):
        result = await grade_answer(
            question_text=quiz["question_text"],
            answer_hint=quiz["answer_hint"],
            transcript=req.transcript,
        )

    next_review = await _safe_update_sm2_state(user["id"], req.concept_id, result["quality"])

    return {
        "passed": result["passed"],
        "quality": result["quality"],
        "explanation": result["explanation"],
        "next_review": datetime.fromtimestamp(next_review, tz=timezone.utc).isoformat(),
    }


async def _safe_update_sm2_state(user_id: str, concept_id: str, quality: int) -> int:
    """P2-B8: a stale concept (state key TTL'd out mid-quiz, or never seeded)
    raises ValueError from update_sm2_state. That bare ValueError previously
    surfaced as a 500 — translate it to a 404 so the UI can ask the user to
    re-sync instead of seeing a server error.
    """
    try:
        return await update_sm2_state(user_id, concept_id, quality)
    except ValueError as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(
            status_code=404,
            detail="Concept state expired; please re-sync",
        )
