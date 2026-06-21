import httpx
import sentry_sdk
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from backend.dependencies.auth import get_current_user
from backend.services.claude import grade_answer
from backend.services.deepgram_stt import transcribe_audio
from backend.services.deepgram_tts import synthesize_speech
from backend.services.redis_client import get_quiz_content, update_sm2_state

router = APIRouter()

# --- /api/transcribe limits -------------------------------------------------
# Cap body size so a runaway client can't push a huge file at a Deepgram-billed
# endpoint (P1-S3 in STATUS.md). Whitelist content-types because the route
# forwards `audio.content_type` to Deepgram and unknown types would just be
# rejected upstream — fail fast with a clear error instead.
MAX_AUDIO_BYTES: int = 10 * 1024 * 1024  # 10 MB
ALLOWED_MIME_TYPES: set[str] = {"audio/webm", "audio/wav", "audio/mpeg", "audio/ogg", "audio/mp4"}
MAX_TTS_CHARS: int = 2000


def _normalize_audio_mime(raw: str | None) -> str:
    """Strip codec params (e.g. audio/webm;codecs=opus) before allowlist check."""
    base = (raw or "audio/webm").split(";", 1)[0].strip().lower()
    if base not in ALLOWED_MIME_TYPES:
        raise HTTPException(
            status_code=415,
            detail=(
                f"Unsupported audio format: {raw or 'unknown'}. "
                "Use webm, wav, mp3, or ogg."
            ),
        )
    return base


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
    mime = _normalize_audio_mime(audio.content_type)

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
            transcript = await transcribe_audio(audio_bytes, mimetype=mime)
        except (httpx.HTTPError, httpx.RequestError, ValueError, KeyError) as e:
            sentry_sdk.capture_exception(e)
            return {
                "transcript": "",
                "error": f"Transcription service unavailable: {type(e).__name__}",
            }

    if not transcript:
        return {"transcript": "", "error": "No speech detected -- please try again"}

    return {"transcript": transcript}


class TtsRequest(BaseModel):
    text: str = Field(..., max_length=MAX_TTS_CHARS)


@router.post("/tts")
async def tts(req: TtsRequest, user=Depends(get_current_user)):
    """Synthesize speech for roast/question playback. Auth-gated."""
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required")

    with sentry_sdk.start_span(op="deepgram.tts", name="Synthesize speech"):
        try:
            audio_bytes = await synthesize_speech(text)
        except (httpx.HTTPError, httpx.RequestError, ValueError) as e:
            sentry_sdk.capture_exception(e)
            raise HTTPException(
                status_code=502,
                detail=f"Speech synthesis unavailable: {type(e).__name__}",
            ) from e

    return StreamingResponse(
        iter([audio_bytes]),
        media_type="audio/mpeg",
    )


class GradeRequest(BaseModel):
    concept_id: str
    transcript: str


@router.post("/grade")
async def grade(req: GradeRequest, user=Depends(get_current_user)):
    """Grade a spoken answer and update SM-2 state for the signed-in user."""
    # Trace 2 H4 (Quiz #4): soft IDOR. Concept IDs are encoded as
    # "{user_id}:{pr_or_commit}:{slug}" — verify the user_id segment
    # matches the signed-in user before we hand them the quiz content.
    # parse_concept_id returns parts with the canonical user_id; if the
    # caller is asking about someone else's concept, 403.
    from backend.services.concept_ids import parse_concept_id
    parts = parse_concept_id(req.concept_id)
    if not parts.source_type:
        # parse_concept_id returns "pr" as the default — only an empty
        # source_type (malformed input) gives back "". Treat as 403.
        raise HTTPException(status_code=403, detail="concept does not belong to this user")
    # Reconstruct the user_id segment from the concept_id directly
    # (parse_concept_id doesn't surface it for commit-sourced rows).
    user_segment = req.concept_id.split(":", 1)[0]
    if user_segment != user["id"]:
        raise HTTPException(status_code=403, detail="concept does not belong to this user")

    quiz = await get_quiz_content(user["id"], req.concept_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Concept not found in Redis")

    with sentry_sdk.start_span(op="claude.grade", name="Grade answer"):
        result = await grade_answer(
            question_text=quiz["question_text"],
            answer_hint=quiz["answer_hint"],
            transcript=req.transcript,
        )

    new_state = await _safe_update_sm2_state(user["id"], req.concept_id, result["quality"])

    return {
        "passed": result["passed"],
        "quality": result["quality"],
        "explanation": result["explanation"],
        "next_review": datetime.fromtimestamp(new_state["next_review"], tz=timezone.utc).isoformat(),
        # SM-2 interval (logical days, independent of demo/prod time scaling) and
        # repetitions count let the frontend compute mastery % correctly regardless
        # of whether DEMO_MODE is active (where next_review is minutes, not days).
        "interval": new_state["interval"],
        "repetitions": new_state["repetitions"],
    }


async def _safe_update_sm2_state(user_id: str, concept_id: str, quality: int) -> dict:
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
