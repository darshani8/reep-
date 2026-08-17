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

import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, status
from livekit import api
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import conversations as convo
from ..config import settings
from ..db import get_db
from ..deps import get_current_session
from ..models.conversation import Message
from ..models.user import Role
from ..models.voice_worker import VoiceWorkerHeartbeat

router = APIRouter(prefix="/api/voice", tags=["voice"])

# A worker is "healthy" only if it has checked in within this window. It should
# heartbeat well inside it (e.g. every 10s) so one missed beat is not an outage.
HEARTBEAT_FRESH_SECONDS = 30
# How long a silent worker's row is kept before it is reaped. Far longer than
# HEARTBEAT_FRESH_SECONDS so the row survives long enough to be diagnosed ("the
# worker last checked in 4 minutes ago") rather than vanishing the instant it
# goes stale, but short enough that dead workers never accumulate.
HEARTBEAT_REAP_AFTER = timedelta(hours=1)
# Voice tokens are short-lived: the room is joined immediately after minting, so
# a 10-minute expiry bounds the blast radius of a leaked token.
TOKEN_TTL = timedelta(minutes=10)

# MUST match the agent_name the worker registers under (@server.rtc_session in
# voice_agent.py). Naming an agent opts it OUT of LiveKit's automatic dispatch:
# a named worker never joins a room on its own, so the token has to request it
# explicitly via RoomConfiguration.agents. Without this the student joins, the
# worker sits idle with no job, and the call is silence with no error anywhere.
VOICE_AGENT_NAME = "reep-voice"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def require_voice_worker(
    x_voice_worker_secret: str | None = Header(default=None),
) -> None:
    """Authenticate a backend voice-worker caller (no user session).

    FAILS CLOSED IN PRODUCTION. A blank VOICE_WORKER_SECRET leaves /heartbeat and
    /transcript open to anyone who can reach the API — they could forge a
    heartbeat to make voice look available, or write fabricated turns into any
    conversation whose id they can guess or observe. That is tolerable on a dev
    laptop and unacceptable deployed, so with ENV=prod a missing secret is a 500
    rather than a silent open door.

    Rejecting at request time rather than refusing to boot is deliberate: the
    API serves the whole dashboard, and a misconfigured voice secret should
    disable voice ingestion, not take the site down. The startup check in
    app/main.py logs the same condition loudly at boot."""
    if not settings.voice_worker_secret:
        if settings.is_prod:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Voice worker authentication is not configured.",
            )
        return  # dev: open, as documented in .env.example

    if x_voice_worker_secret != settings.voice_worker_secret:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid voice worker secret.",
        )


# --------------------------------------------------------------------------- #
# 1) Worker heartbeat                                                         #
# --------------------------------------------------------------------------- #


class HeartbeatIn(BaseModel):
    worker_id: str = Field(min_length=1, max_length=200)
    # Set once by the worker, after its beat loop has exited on SIGTERM, to
    # withdraw readiness IMMEDIATELY rather than waiting out HEARTBEAT_FRESH_SECONDS.
    # Going quiet alone would leave /status reporting the worker healthy — and
    # tokens being minted at it — for that whole window after it began draining.
    draining: bool = False


@router.post("/heartbeat")
def voice_heartbeat(
    body: HeartbeatIn,
    db: Session = Depends(get_db),
    _worker: None = Depends(require_voice_worker),
) -> dict:
    """The voice worker pings this to say it is alive. No user session — the
    caller is a backend process. If VOICE_WORKER_SECRET is set, the worker must
    present it in the X-Voice-Worker-Secret header; blank means open (dev)."""
    now = _now()

    # A draining worker deregisters rather than refreshing. Deleting the row (not
    # tombstoning it) is what makes this safe to call unconditionally: the worker
    # only sends it once its beat loop has already exited, so nothing races in to
    # recreate the row afterwards.
    if body.draining:
        db.execute(
            delete(VoiceWorkerHeartbeat).where(
                VoiceWorkerHeartbeat.worker_id == body.worker_id
            )
        )
        db.commit()
        return {"ok": True, "deregistered": True}

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

    # Reap rows for workers that are long gone. Every worker process gets a
    # fresh random worker_id at startup (VOICE_WORKER_ID default), so without
    # this the table grows by one permanent row per restart, redeploy, crash and
    # local dev run — unbounded, and eventually the thing readiness scans on
    # every /status call. Done opportunistically here rather than as a cron: the
    # heartbeat is already the only writer, already runs every 15s, and this
    # keeps the cleanup impossible to forget to deploy.
    db.execute(
        delete(VoiceWorkerHeartbeat).where(
            VoiceWorkerHeartbeat.last_seen < now - HEARTBEAT_REAP_AFTER
        )
    )
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
    provider_ready = settings.livekit_ready and settings.voice_model_key_present
    worker_healthy = _worker_healthy(db)
    maintenance = settings.voice_maintenance_message.strip() or None

    available = provider_ready and worker_healthy and maintenance is None

    if maintenance is not None:
        reason = maintenance
    elif not provider_ready:
        if not settings.livekit_ready:
            reason = "Voice not configured — LIVEKIT_URL / API_KEY / API_SECRET missing."
        else:
            reason = "Voice not configured — no GROQ_API_KEY for the speech cascade."
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

    # The room name must be UNIQUE PER CALL, not per conversation. LiveKit
    # applies a token's RoomConfiguration only when the room is first created,
    # and a room lingers after the last participant leaves (empty_timeout,
    # 300s by default). A stable per-conversation name would therefore have the
    # agent dispatched on the first call and SILENTLY DROPPED on any call that
    # re-uses the still-live room — an intermittent silent call that looks like
    # a flaky provider. The conversation id stays the participant identity, so
    # the worker still resolves the same Postgres conversation either way.
    room = f"reep-conversation-{conversation.id}-{uuid.uuid4().hex[:8]}"

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
                # Narrow the grant to what a voice call actually needs. Without
                # these the token also authorises publishing VIDEO and arbitrary
                # DATA messages into the room — capabilities this product never
                # uses, but which a leaked 10-minute token would carry.
                can_publish_sources=["microphone"],
                can_publish_data=False,
                can_update_own_metadata=False,
            )
        )
        # Explicitly dispatch the voice worker into this room. See
        # VOICE_AGENT_NAME: a named agent is never auto-dispatched, so without
        # this the student joins an empty room and hears nothing back.
        .with_room_config(
            api.RoomConfiguration(
                agents=[api.RoomAgentDispatch(agent_name=VOICE_AGENT_NAME)]
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


# --------------------------------------------------------------------------- #
# 4) Consent (STUDENT)                                                        #
# --------------------------------------------------------------------------- #


class ConsentIn(BaseModel):
    consent: bool


class ConsentOut(BaseModel):
    consent_state: str


@router.post("/consent", response_model=ConsentOut)
def voice_consent(
    body: ConsentIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> ConsentOut:
    """Record the student's acknowledgement before a voice session. STUDENT-only.

    ⚠️ NOT AN ENFORCED RUNTIME CONTROL — do not read it as one.

    This writes consent_state ('voice' | 'none') and nothing else consumes it.
    The voice worker never fetches it: it runs the SAME general prompt either
    way, and revoking mid-call changes nothing. It is scaffolding for a
    record-aware voice mode that does not exist yet.

    What actually protects the student today is architectural, not this flag:
    no student record is ever placed in the voice prompt, so marks, attendance
    and CGPA cannot reach Groq or the TTS provider regardless of what is stored
    here. What DOES leave the machine is the student's speech and its
    transcript — which this endpoint does not gate either.

    If a record-aware mode is ever built, this flag must be fetched by the
    worker at session start AND re-checked on revocation; until then, treat the
    consent panel as a disclosure notice, not a permission gate.
    """
    if session.get("role") != Role.STUDENT.value:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Voice is a student feature.",
        )

    conversation = convo.get_or_create(db, session["userId"], Role(session["role"]))
    conversation.consent_state = "voice" if body.consent else "none"
    db.commit()
    return ConsentOut(consent_state=conversation.consent_state)


# --------------------------------------------------------------------------- #
# 5) Transcript ingest (WORKER)                                               #
# --------------------------------------------------------------------------- #


# A spoken turn is a sentence or two. The cap is generous enough that no real
# utterance is ever truncated, and small enough that a compromised or buggy
# worker cannot write unbounded rows into a student's conversation — the text is
# replayed into later LLM prompts and rendered in the UI, so unbounded input is
# both a storage and a prompt-injection surface.
MAX_TRANSCRIPT_CHARS = 4000
MAX_CONVERSATION_ID_CHARS = 64
MAX_PROVIDER_TURN_ID_CHARS = 200


class TranscriptIn(BaseModel):
    conversation_id: str = Field(min_length=1, max_length=MAX_CONVERSATION_ID_CHARS)
    speaker: Literal["user", "assistant"]
    text: str = Field(max_length=MAX_TRANSCRIPT_CHARS)
    is_final: bool
    provider_turn_id: str | None = Field(
        default=None, max_length=MAX_PROVIDER_TURN_ID_CHARS
    )


class TranscriptOut(BaseModel):
    stored: bool


@router.post("/transcript", response_model=TranscriptOut)
def voice_transcript(
    body: TranscriptIn,
    db: Session = Depends(get_db),
    _worker: None = Depends(require_voice_worker),
) -> TranscriptOut:
    """Persist a voice turn from the background worker. WORKER endpoint,
    authenticated by X-Voice-Worker-Secret when VOICE_WORKER_SECRET is set
    (open in dev). No user session — the worker is a trusted backend process
    and names the conversation directly (resolved from the LiveKit room /
    participant identity, both server-issued).

    Policy lives here, not in the worker:
      * ONLY final turns are persisted — interim (is_final=False) is a no-op.
      * Turns dedup on (conversation_id, provider_turn_id): a repeated
        provider_turn_id (the provider re-emitting the same turn) is a no-op.

    Returns {stored} — True only when a NEW final turn was appended; False for
    interim turns and for dedup repeats.
    """
    if not body.is_final:
        # Interim transcript — never persisted (the policy the worker relies on).
        return TranscriptOut(stored=False)

    # Dedup: a repeat provider_turn_id for this conversation is a no-op.
    if body.provider_turn_id is not None:
        existing = db.scalar(
            select(Message).where(
                Message.conversation_id == body.conversation_id,
                Message.provider_turn_id == body.provider_turn_id,
            )
        )
        if existing is not None:
            return TranscriptOut(stored=False)

    # The conversation is server-owned; a stray/unknown id is refused rather
    # than left to fail as an FK error at commit.
    #
    # A SOFT-DELETED conversation is refused for the same reason but a different
    # cause. "Clear conversation" sets deleted_at; without this check the worker
    # kept appending turns to the thread the student had just discarded. Those
    # rows were invisible in the UI (history reads only live conversations) and
    # `retention.purge_expired` would not re-scrub them, so a student's spoken
    # words survived the one action the product offers for removing them.
    #
    # 404 rather than 409, deliberately: from the worker's side "this thread no
    # longer accepts writes" is one situation with one correct response, and the
    # worker treats both by ENDING the call (see _persist_turn). That pairing is
    # the whole design — a bare 404 with no worker change would silently discard
    # every remaining turn of a live call, because the room and identity stay
    # pinned to the dead conversation for the token's full TTL and the worker has
    # no way to re-resolve.
    conversation = db.get(convo.Conversation, body.conversation_id)
    if conversation is None or conversation.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found."
        )

    # The read-then-insert above is a CHECK, not a guarantee: two workers (or one
    # worker retrying) can both pass it before either commits, and the unique
    # index on (conversation_id, provider_turn_id) then raises. Losing that race
    # is not an error — the turn IS stored, just by the other writer — so treat
    # it as the idempotent no-op the caller expects rather than surfacing a 500
    # to a worker that did nothing wrong.
    try:
        convo.append_message(
            db,
            body.conversation_id,
            body.speaker,
            body.text,
            channel="voice",
            is_final=True,
            provider_turn_id=body.provider_turn_id,
        )
    except IntegrityError:
        db.rollback()
        return TranscriptOut(stored=False)
    return TranscriptOut(stored=True)
