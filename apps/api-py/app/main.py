"""FastAPI application entrypoint.

Run (dev):  uvicorn app.main:app --reload --port 3300
Docs:       http://localhost:3300/docs
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .routers import (
    agent,
    auth,
    director,
    health,
    leave,
    mentor,
    registration,
    student,
    voice,
)

app = FastAPI(title="REEP API (Python / FastAPI)", version="0.1.0")

# Credentials are sent (the session cookie), so the origin must be explicit, not "*".
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.web_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Health is infra liveness — unprefixed at /health.
app.include_router(health.router)
# agent + voice already carry /api in their own prefix (/api/agent, /api/voice).
app.include_router(agent.router)
app.include_router(voice.router)
# Domain routers mount under a single /api prefix, so the whole surface the
# Angular client calls lives under /api — matching environment.apiBase and the
# dev proxy (apps/web/proxy.conf.json), with no path rewriting.
app.include_router(auth.router, prefix="/api")
app.include_router(student.router, prefix="/api")
app.include_router(mentor.router, prefix="/api")
app.include_router(director.router, prefix="/api")
app.include_router(leave.router, prefix="/api")
app.include_router(registration.router, prefix="/api")
