import httpx
import sentry_sdk

from backend.config import DEEPGRAM_API_KEY
from backend.services.http_client import shared_client

DEEPGRAM_TTS_URL = "https://api.deepgram.com/v1/speak"

_client = shared_client("deepgram_tts")


async def synthesize_speech(text: str) -> bytes:
    """
    Synthesize speech using Deepgram Aura.
    Returns audio/mpeg bytes. Raises on failure.
    """
    response = await _client.post(
        DEEPGRAM_TTS_URL,
        params={"model": "aura-asteria-en"},
        headers={
            "Authorization": f"Token {DEEPGRAM_API_KEY}",
            "Content-Type": "application/json",
        },
        json={"text": text},
        timeout=30.0,
    )
    response.raise_for_status()

    audio_bytes = response.content
    sentry_sdk.add_breadcrumb(
        category="deepgram_tts",
        message=f"Synthesized {len(text)} chars → {len(audio_bytes)} bytes",
        level="info",
    )
    return audio_bytes
