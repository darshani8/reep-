"""FastAPI application entrypoint.

Run (dev):  uvicorn app.main:app --port 3300
Docs:       http://localhost:3300/docs

(No --reload: on Windows it has wedged a stale worker here. See AGENTS.md.)
"""

import logging
from contextlib import asynccontextmanager

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

log = logging.getLogger("reep.startup")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Say plainly, once, when production is running with voice unauthenticated.

    A blank VOICE_WORKER_SECRET leaves BOTH worker endpoints open to anyone who
    can reach this port. The reachable abuse is the forged HEARTBEAT: the body
    accepts any worker_id, so a stranger can make _worker_healthy() true and
    students are then handed tokens into rooms no agent ever joins — voice looks
    available and silently is not. (Forged TRANSCRIPTS are much harder: an
    unknown conversation id 404s, and ids are uuid4 hex.)

    A WARNING, not a hard failure. Most REEP deployments never enable voice, and
    refusing to boot over an unset optional secret would take the whole dashboard
    down over a feature the operator is not using. require_voice_worker already
    fails closed at request time when ENV=prod — this exists so the operator
    learns at deploy rather than from a confused student.
    """
    if settings.is_prod and not settings.voice_worker_secret.strip():
        log.warning(
            "VOICE_WORKER_SECRET is blank in production: /api/voice/heartbeat and "
            "/api/voice/transcript are unauthenticated. A forged heartbeat makes "
            "voice report itself available with no worker behind it. Set the same "
            "value on the API and the voice worker."
        )
    yield


app = FastAPI(title="REEP API (Python / FastAPI)", version="0.1.0", lifespan=lifespan)

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
