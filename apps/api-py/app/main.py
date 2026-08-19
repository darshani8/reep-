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
    interview,
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
    # A HARD FLOOR, not a preference. At DEBUG the `websockets` library prints
    # the outbound handshake header by header (ClientProtocol.send_request,
    # guarded by Protocol.debug = logger.isEnabledFor(DEBUG)) and redacts
    # nothing -- and one of those headers is
    # `Authorization: Bearer <OPENAI_API_KEY>` on the interview relay's upstream
    # socket (app/interview_relay.py). Running uvicorn with --log-level debug is
    # a documented troubleshooting step, so without this the operator following
    # the manual is the one who prints the credential into the API log, beside
    # student traffic, in whatever aggregator this deployment ships to. That
    # would defeat the containment the relay exists to provide.
    # Protocol.debug is evaluated per connection at connect time, i.e. after
    # this runs, and websockets.client/.server are NOTSET so they inherit it.
    logging.getLogger("websockets").setLevel(logging.INFO)

    if settings.is_prod and not settings.voice_worker_secret.strip():
        log.warning(
            "VOICE_WORKER_SECRET is blank in production: /api/voice/heartbeat and "
            "/api/voice/transcript are unauthenticated. A forged heartbeat makes "
            "voice report itself available with no worker behind it. Set the same "
            "value on the API and the voice worker."
        )
    try:
        yield
    finally:
        # Ask live interviews to close with a real code and reason rather than
        # being torn down as a bare 1006.
        #
        # BACKSTOP ONLY, and honestly so: uvicorn's Server.shutdown() closes
        # every live WebSocket (queueing websocket.disconnect(1012)) BEFORE it
        # sends the lifespan shutdown event, so under uvicorn this set is
        # already empty here. The standalone relay hijacked SIGINT/SIGTERM to
        # get ahead of that; this process serves the whole dashboard and taking
        # over its signals to improve one feature's close code is a bad trade --
        # especially as the client already has a sentence for 1012 ("the
        # interview server is restarting"). This covers an ASGI server whose
        # shutdown ordering differs, and a shutdown with no signal at all.
        interview.shutdown_interviews()


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
# agent + voice + interview already carry /api in their own prefix
# (/api/agent, /api/voice, /api/interview).
app.include_router(agent.router)
app.include_router(voice.router)
app.include_router(interview.router)
# Domain routers mount under a single /api prefix, so the whole surface the
# Angular client calls lives under /api — matching environment.apiBase and the
# dev proxy (apps/web/proxy.conf.json), with no path rewriting.
app.include_router(auth.router, prefix="/api")
app.include_router(student.router, prefix="/api")
app.include_router(mentor.router, prefix="/api")
app.include_router(director.router, prefix="/api")
app.include_router(leave.router, prefix="/api")
app.include_router(registration.router, prefix="/api")
