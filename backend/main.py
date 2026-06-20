import backend.sentry_init  # noqa: F401  — MUST be the first import (Sentry init)
from fastapi import FastAPI

from backend.routers import concepts, enrich, quiz, schedule, sync

app = FastAPI(title="VibeSchool Backend")
app.include_router(sync.router, prefix="/api")
app.include_router(concepts.router, prefix="/api")
app.include_router(quiz.router, prefix="/api")
app.include_router(schedule.router, prefix="/api")
app.include_router(enrich.router, prefix="/api")  # P1


@app.get("/health")
async def health():
    return {"status": "ok"}
