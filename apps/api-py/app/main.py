"""FastAPI application entrypoint.

Run (dev):  uvicorn app.main:app --reload --port 3300
Docs:       http://localhost:3300/docs
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .routers import agent, auth, director, health, mentor, student, voice

app = FastAPI(title="REEP API (Python / FastAPI)", version="0.1.0")

# Credentials are sent (the session cookie), so the origin must be explicit, not "*".
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.web_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(auth.router)
app.include_router(agent.router)
app.include_router(voice.router)
app.include_router(student.router)
app.include_router(mentor.router)
app.include_router(director.router)
