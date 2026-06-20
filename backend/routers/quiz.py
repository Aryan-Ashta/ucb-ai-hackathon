import sentry_sdk
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from backend.dependencies.auth import get_current_user
from backend.services.claude import grade_answer
from backend.services.deepgram_stt import transcribe_audio
from backend.services.redis_client import get_quiz_content, update_sm2_state

router = APIRouter()


@router.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    user=Depends(get_current_user),
):
    """
    Accept audio/webm from a browser MediaRecorder, return the transcript.

    Auth-gated: requires `Authorization: Bearer <github_access_token>`.
    The signed-in user is resolved by `get_current_user` but the endpoint
    itself does not need `user["id"]` (transcription is per-request, not
    per-user); the dependency exists so unauthenticated callers cannot
    burn the Deepgram API key.
    """
    audio_bytes = await audio.read()

    if len(audio_bytes) == 0:
        raise HTTPException(status_code=400, detail="Empty audio file")

    with sentry_sdk.start_span(op="deepgram.stt", name="Transcribe audio"):
        transcript = await transcribe_audio(
            audio_bytes, mimetype=audio.content_type or "audio/webm"
        )

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

    next_review = await update_sm2_state(user["id"], req.concept_id, result["quality"])

    return {
        "passed": result["passed"],
        "quality": result["quality"],
        "explanation": result["explanation"],
        "next_review": next_review,
    }
