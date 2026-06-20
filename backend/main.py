import backend.sentry_init  # noqa: F401  — MUST be the first import (Sentry init)
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.routers import concepts, enrich, quiz, schedule, sync

app = FastAPI(title="VibeSchool Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",          # local Next.js dev (browser on the laptop)
        "http://127.0.0.1:3000",          # ditto, IPv4 form
    ],
    # cloudflared quick-tunnel URLs rotate per session (xxx-yyy.trycloudflare.com),
    # so we can't list them — match by hostname pattern instead.
    allow_origin_regex=r"https://[a-z0-9-]+\.trycloudflare\.com",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(sync.router, prefix="/api")
app.include_router(concepts.router, prefix="/api")
app.include_router(quiz.router, prefix="/api")
app.include_router(schedule.router, prefix="/api")
app.include_router(enrich.router, prefix="/api")  # P1


@app.get("/health")
async def health():
    return {"status": "ok"}
