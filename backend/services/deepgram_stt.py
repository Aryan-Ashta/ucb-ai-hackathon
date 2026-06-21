import httpx
import sentry_sdk

from backend.config import DEEPGRAM_API_KEY
from backend.services.http_client import shared_client

DEEPGRAM_STT_URL = "https://api.deepgram.com/v1/listen"

_client = shared_client("deepgram_stt")


async def transcribe_audio(audio_bytes: bytes, mimetype: str = "audio/webm") -> str:
    """
    Transcribe audio bytes using Deepgram nova-2.
    Returns the transcript string. Raises on failure.
    """
    params = {
        "model": "nova-2",
        "smart_format": "true",
        "punctuate": "true",
        "language": "en-US",
    }

    response = await _client.post(
        DEEPGRAM_STT_URL,
        params=params,
        headers={
            "Authorization": f"Token {DEEPGRAM_API_KEY}",
            "Content-Type": mimetype,
        },
        content=audio_bytes,
        timeout=30.0,
    )
    response.raise_for_status()
    data = response.json()

    transcript = (
        data.get("results", {})
        .get("channels", [{}])[0]
        .get("alternatives", [{}])[0]
        .get("transcript", "")
        .strip()
    )

    sentry_sdk.add_breadcrumb(
        category="deepgram_stt",
        message=f"Transcribed {len(audio_bytes)} bytes → '{transcript[:80]}'",
        level="info",
    )

    return transcript
