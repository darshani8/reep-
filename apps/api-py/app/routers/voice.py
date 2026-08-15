"""Voice assistant readiness + server-owned LiveKit tokens (Assistant V2 Phase A).

Three endpoints, one rule: the client never names the conversation.

  POST /api/voice/heartbeat  { worker_id }         -> the voice worker checks in
  GET  /api/voice/status                           -> is voice usable right now? (STUDENT)
  POST /api/voice/token                            -> mint a short-lived LiveKit JWT

The participant identity and room are BOTH derived from the caller's server-owned
conversation (get_or_create by session userId) — never a client-supplied id. The
background voice worker reads the identity back as the conversation id and, in
Phase C, persists turns via the same Postgres conversation the text chat uses
(conversations.append_message on that id) — one memory bank across text + voice.

A token is only issued when GET /status reports `available` (provider configured
AND a worker heartbeat is fresh). Handing out a token while no worker is running
would drop the student into a silent room, so we refuse instead.
"""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, status
from livekit import api
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import conversations as convo
from ..config import settings
from ..db import get_db
from ..deps import get_current_session
from ..models.user import Role
from ..models.voice_worker import VoiceWorkerHeartbeat

router = APIRouter(prefix="/api/voice", tags=["voice"])

# A worker is "healthy" only if it has checked in within this window. It should
# heartbeat well inside it (e.g. every 10s) so one missed beat is not an outage.
HEARTBEAT_FRESH_SECONDS = 30
# Voice tokens are short-lived: the room is joined immediately after minting, so
# a 10-minute expiry bounds the blast radius of a leaked token.
TOKEN_TTL = timedelta(minutes=10)


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# 1) Worker heartbeat                                                         #
# --------------------------------------------------------------------------- #


class HeartbeatIn(BaseModel):
    worker_id: str = Field(min_length=1, max_length=200)


@router.post("/heartbeat")
def voice_heartbeat(
    body: HeartbeatIn,
    db: Session = Depends(get_db),
    x_voice_worker_secret: str | None = Header(default=None),
) -> dict:
    """The voice worker pings this to say it is alive. No user session — the
    caller is a backend process. If VOICE_WORKER_SECRET is set, the worker must
    present it in the X-Voice-Worker-Secret header; blank means open (dev)."""
    if settings.voice_worker_secret:
        if x_voice_worker_secret != settings.voice_worker_secret:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid voice worker secret.",
            )

    now = _now()
    row = db.scalar(
        select(VoiceWorkerHeartbeat).where(
            VoiceWorkerHeartbeat.worker_id == body.worker_id
        )
    )
    if row is None:
        row = VoiceWorkerHeartbeat(worker_id=body.worker_id, last_seen=now)
        db.add(row)
    else:
        row.last_seen = now
    db.commit()
    return {"ok": True, "last_seen": now.isoformat()}


# --------------------------------------------------------------------------- #
# 2) Readiness                                                                #
# --------------------------------------------------------------------------- #


class StatusOut(BaseModel):
    available: bool
    reason: str
    worker_healthy: bool
    provider_ready: bool
    maintenance_message: str | None


def _worker_healthy(db: Session) -> bool:
    cutoff = _now() - timedelta(seconds=HEARTBEAT_FRESH_SECONDS)
    fresh = db.scalar(
        select(VoiceWorkerHeartbeat)
        .where(VoiceWorkerHeartbeat.last_seen >= cutoff)
        .limit(1)
    )
    return fresh is not None


def _compute_status(db: Session) -> StatusOut:
    """Single source of truth for readiness — used by GET /status and reused by
    POST /token to decide whether a token may be issued."""
    provider_ready = settings.livekit_ready and settings.gemini_key_present
    worker_healthy = _worker_healthy(db)
    maintenance = settings.voice_maintenance_message.strip() or None

    available = provider_ready and worker_healthy and maintenance is None

    if maintenance is not None:
        reason = maintenance
    elif not provider_ready:
        if not settings.livekit_ready:
            reason = "Voice not configured — LIVEKIT_URL / API_KEY / API_SECRET missing."
        else:
            reason = "Voice not configured — no Gemini/Google API key."
    elif not worker_healthy:
        reason = "Voice worker offline."
    else:
        reason = "Voice is available."

    return StatusOut(
        available=available,
        reason=reason,
        worker_healthy=worker_healthy,
        provider_ready=provider_ready,
        maintenance_message=maintenance,
    )


@router.get("/status", response_model=StatusOut)
def voice_status(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> StatusOut:
    """Whether voice is usable right now. STUDENT-only — voice is a student
    surface; staff have no voice assistant."""
    if session.get("role") != Role.STUDENT.value:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Voice is a student feature.",
        )
    return _compute_status(db)


# --------------------------------------------------------------------------- #
# 3) Server-owned token                                                       #
# --------------------------------------------------------------------------- #


class TokenOut(BaseModel):
    token: str
    url: str
    room: str
    identity: str
    conversation_id: str


@router.post("/token", response_model=TokenOut)
def voice_token(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> TokenOut:
    """Mint a short-lived LiveKit JWT for the caller's OWN conversation.

    No session_id / conversation_id is accepted from the client: the conversation
    is derived from the authenticated session (get_or_create). The room and the
    participant identity are both that conversation id, so the voice worker joins
    the same Postgres conversation the text chat writes to.
    """
    if session.get("role") != Role.STUDENT.value:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Voice is a student feature.",
        )

    # Never hand out a token that leads to a silent room: gate on readiness first.
    st = _compute_status(db)
    if not st.available:
        # 503 when the provider is not configured / maintenance; 409 when the
        # provider is fine but no worker is listening (a transient conflict).
        code = (
            status.HTTP_409_CONFLICT
            if (st.provider_ready and st.maintenance_message is None)
            else status.HTTP_503_SERVICE_UNAVAILABLE
        )
        raise HTTPException(status_code=code, detail=st.reason)

    conversation = convo.get_or_create(db, session["userId"], Role(session["role"]))
    room = f"reep-conversation-{conversation.id}"

    token = (
        api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        # Identity = conversation id: the worker reads it back to resolve the same
        # Postgres conversation and persist turns via conversations.append_message.
        .with_identity(conversation.id)
        .with_name(session.get("name") or conversation.id)
        .with_ttl(TOKEN_TTL)
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room,
                can_publish=True,
                can_subscribe=True,
            )
        )
        .to_jwt()
    )
    return TokenOut(
        token=token,
        url=settings.livekit_url,
        room=room,
        identity=conversation.id,
        conversation_id=conversation.id,
    )
