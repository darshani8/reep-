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

import hmac
import logging
import math
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, status
from livekit import api
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import conversations as convo
from ..config import settings
from ..db import get_db
from ..identity import get_current_session
from ..models.conversation import Message
from ..models.user import Role
from ..models.voice_worker import VoiceWorkerHeartbeat

log = logging.getLogger(__name__)

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

    FAILS CLOSED ANYWHERE THE OPEN DOOR IS NOT DELIBERATE. A blank
    VOICE_WORKER_SECRET leaves /heartbeat and /transcript open to anyone who can
    reach the API: they can forge a heartbeat so voice reports itself available
    with no worker behind it (students are then handed tokens into silent rooms),
    or write fabricated assistant-labelled turns into any conversation whose id
    they observe, which render in the UI and replay into later LLM prompts. That
    is tolerable on a dev laptop and unacceptable deployed, so a missing secret
    is a 500 rather than a silent open door.

    THE GATE IS `worker_auth_optional`, NOT `is_prod`. It used to be `is_prod`,
    which is a match against four literal names ({prod, production, prd, live}):
    an ENV nobody anticipated -- `staging`, a typo, an empty string from a broken
    deploy -- is not one of them, so a host holding real roster rows answered
    "this is not production" and left both worker endpoints wide open, with the
    startup warning in app/main.py silent for exactly the same reason.
    `worker_auth_optional` is an ALLOWLIST of the environments where an open door
    is the intended affordance -- the shape `password_login_allowed` already uses,
    for the same reason: the failure mode of a misconfigured ENV here must be
    "voice ingestion stops", never "anyone may write into a student's
    conversation".

    Rejecting at request time rather than refusing to boot is deliberate: the
    API serves the whole dashboard, and a misconfigured voice secret should
    disable voice ingestion, not take the site down. The startup check in
    app/main.py logs the same condition loudly at boot."""
    if not settings.voice_worker_secret:
        if not settings.worker_auth_optional:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Voice worker authentication is not configured.",
            )
        return  # dev/CI only, as documented in .env.example

    # Constant-time, and over BYTES rather than str. compare_digest is the house
    # rule for every secret comparison in this codebase (app/security.py:42,
    # app/google_auth.py:319,563); `!=` short-circuits at the first differing
    # character, leaking the length of the shared prefix to anyone willing to
    # time enough requests -- and nothing rate-limits this endpoint.
    #
    # Encoding both sides sidesteps the trap google_auth.py documents at its
    # nonce compare: compare_digest RAISES TypeError on a non-ASCII str. This
    # header arrives latin-1-decoded by Starlette, so a single byte above 0x7F
    # from a hostile caller would turn a 401 into a 500 -- and an operator is
    # equally free to choose a non-ASCII secret, which would break every
    # legitimate beat the same way. Bytes compare fine either way.
    presented = (x_voice_worker_secret or "").encode("utf-8")
    if not hmac.compare_digest(presented, settings.voice_worker_secret.encode("utf-8")):
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

    # The read-then-insert above is a CHECK, not a guarantee -- the same shape
    # POST /transcript documents at the bottom of this file. Two beats for one
    # worker_id can both see None before either commits (a retry after a slow
    # POST, or two uvicorn workers serving one worker's beats), and `worker_id`
    # is UNIQUE, so the loser raises. Losing that race is not a failure: the row
    # IS registered, by the other writer, and this beat only wanted `last_seen`
    # moved forward. Left unhandled it surfaces as a 500 -- precisely the
    # alarming line the AGENTS.md voice runbook sends an operator hunting for a
    # real fault, on the one path that was working correctly.
    #
    # The retry is an UPDATE, so it cannot lose the race a second time. The
    # rollback also discards the opportunistic reap above; that is deliberate and
    # costs nothing, because the next beat is ~10s away and will reap then.
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        db.execute(
            update(VoiceWorkerHeartbeat)
            .where(VoiceWorkerHeartbeat.worker_id == body.worker_id)
            .values(last_seen=now)
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
# Per-student token cap (audit H2)                                            #
# --------------------------------------------------------------------------- #

# WHY A TOKEN TTL IS NOT A DURATION CAP -- read this before "simplifying" either
# half away.
#
# TOKEN_TTL bounds how long a minted JWT may be used to JOIN a room. LiveKit
# checks the token once, at join, and never again: a participant admitted at
# 9m59s holds the room -- and the Groq-billed cascade the worker runs for it --
# for as long as they stay connected. A forgotten browser tab is exactly that.
# So the expiry that looks like a session limit bounds nothing about a session.
#
# The two real bounds are therefore split across the two processes, because each
# one can only see half of it:
#   * HOW LONG one call may run is enforced where the call lives, in
#     voice_agent.py (VOICE_MAX_CALL_SECONDS, mirroring
#     settings.voice_max_call_seconds). The API never learns a call ended.
#   * HOW MANY calls one student may have in flight is enforced here, because
#     minting is the only moment the API sees the student at all.
#
# Neither alone is sufficient: a duration cap with unlimited tokens still lets
# one scripted account open calls until the worker OOMs (the H2 scenario), and a
# token cap with unbounded calls just makes the same spend arrive more slowly.
#
# What the pair actually guarantees, stated honestly rather than optimistically:
# a grant is held for TOKEN_TTL (after which the token cannot open anything new),
# while the call it started may run for voice_max_call_seconds. So live calls per
# student are bounded by
#     ceil(voice_max_call_seconds / TOKEN_TTL) * voice_max_sessions_per_user
# -- with the defaults, ceil(900/600) * 2 = 4. Not 2. Releasing on the real
# end-of-call would give exactly the cap, but the worker has no channel to report
# it: tests/test_voice_worker_source.py pins the worker to precisely two API
# paths (/heartbeat and /transcript), deliberately, so that it can never reach a
# student-data endpoint. A third path is not worth trading that guarantee for.
_TOKEN_GRANT_WINDOW_SECONDS = TOKEN_TTL.total_seconds()

# Sweep the whole ledger once it holds more entries than this. Without it, one
# short-lived list per student who has ever pressed "Start voice" survives for
# the life of the process. Opportunistic cleanup on the only writer, exactly like
# the heartbeat reaper above -- a cleanup that has to be deployed separately is a
# cleanup that eventually is not.
_TOKEN_LEDGER_SWEEP_AT = 512


class _TokenGrantLedger:
    """How many voice tokens one student currently holds. PER WORKER.

    Per-worker for the same reason config.py gives on interview_max_sessions: N
    uvicorn workers give N times this cap, and that is accepted. The alternative
    is a shared registry (a table, or Redis) on the hot path of a feature whose
    whole purpose is to be cheap; the cap exists to stop an unbounded loop, not
    to be exact, and N * 2 is still a bound where there was none.

    Module-level rather than app.state so a second FastAPI app in one process
    (the test client) cannot silently double the cap.

    A LOCK, unlike _ConnectionLimiter in interview_relay.py. That one is safe
    without one because it is only ever touched from the single-threaded event
    loop. This is not: POST /token is a synchronous `def`, so Starlette runs it
    in the anyio worker THREADPOOL and two of a student's requests can be in
    try_acquire at the same instant on different threads. Without the lock the
    check-then-append is a textbook TOCTOU and the cap is advisory.
    """

    __slots__ = ("_lock", "_grants")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # user_id -> monotonic timestamps of grants still inside the window.
        self._grants: dict[str, list[float]] = {}

    def try_acquire(self, user_id: str, limit: int) -> bool:
        """Record a grant for this student, or refuse. Never blocks.

        monotonic(), not wall clock: an NTP step backwards would otherwise
        resurrect expired grants and lock a student out, and a step forwards
        would release them early.
        """
        now = time.monotonic()
        cutoff = now - _TOKEN_GRANT_WINDOW_SECONDS
        with self._lock:
            if len(self._grants) > _TOKEN_LEDGER_SWEEP_AT:
                self._grants = {
                    uid: live
                    for uid, stamps in self._grants.items()
                    if (live := [t for t in stamps if t > cutoff])
                }
            held = [t for t in self._grants.get(user_id, ()) if t > cutoff]
            if len(held) >= limit:
                self._grants[user_id] = held
                return False
            held.append(now)
            self._grants[user_id] = held
            return True

    def held(self, user_id: str) -> int:
        """Grants currently counted against this student (diagnostics/tests)."""
        cutoff = time.monotonic() - _TOKEN_GRANT_WINDOW_SECONDS
        with self._lock:
            return sum(1 for t in self._grants.get(user_id, ()) if t > cutoff)


_TOKEN_GRANTS = _TokenGrantLedger()


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

    # Per-student cap, checked BEFORE the conversation round-trip so a scripted
    # mint loop costs one dict lookup rather than a DB write per attempt -- the
    # loop is the threat this is here to stop.
    #
    # This is the one place /token deliberately answers differently from
    # /status.available, and tests/test_voice_gates.py pins that invariant, so
    # the distinction has to be explicit: /status describes the SERVICE (is voice
    # up at all), this describes the CALLER (are you already holding your share).
    # Folding the cap into _compute_status would make one student's overuse look
    # like an outage to them and be untrue for everyone else.
    #
    # 429, not 409: this is a rate/quota refusal against the caller, and it is
    # retryable once a grant ages out of the window.
    max_per_user = settings.voice_max_sessions_per_user
    if not _TOKEN_GRANTS.try_acquire(session["userId"], max_per_user):
        # Logged because an anti-abuse control nobody can see is one nobody can
        # confirm is working -- the same reason the interview router logs its own
        # 1013 refusals. One line per refused MINT, which is an HTTP request a
        # human triggers, not a per-audio-frame path: this cannot become the log
        # flood the audit flags on the relay's hostile-client branches.
        log.warning(
            "POST /api/voice/token -> 429: user %s holds %d/%d voice grants",
            session["userId"],
            _TOKEN_GRANTS.held(session["userId"]),
            max_per_user,
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                f"You already have {max_per_user} voice session"
                f"{'' if max_per_user == 1 else 's'} open. End one, or wait "
                f"{math.ceil(_TOKEN_GRANT_WINDOW_SECONDS / 60)} minutes, before "
                "starting another."
            ),
        )

    # The grant is spent from here on. If the conversation lookup below fails
    # (the database is down), the student has lost one slot until it ages out --
    # a self-healing cost, and voice is unusable in that state anyway.
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
