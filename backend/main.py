import backend.sentry_init  # noqa: F401  — MUST be the first import (Sentry init)
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.routers import concepts, enrich, quiz, schedule, sync

app = FastAPI(title="VibeSchool Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://vibeschool.vercel.app",
        "https://*.vercel.app",
        "http://localhost:3000",
    ],
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
