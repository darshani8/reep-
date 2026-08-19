"""Realtime AI mock interviewer — the student-facing assistant (Assistant V2).

  GET /api/interview/status   -> is an interview usable right now? (STUDENT)
  WS  /api/interview          -> one interview, relayed (STUDENT)

The relay engine itself is app/interview_relay.py; this module is the boundary:
authentication, the STUDENT check, the concurrency cap, the server-owned
conversation, and the turn writer. It replaces POST /api/agent/ask as the
assistant screen's entry point — see the header on app/routers/agent.py, which
stays mounted and working as the rollback path.

AUTH IS REEP'S. The socket authenticates with the same httpOnly `reep_session`
cookie and the same verify_session_token as every HTTP route; no second token
scheme exists here. A browser WebSocket cannot set headers, but it DOES send
cookies on a SAME-ORIGIN handshake, and /api is same-origin by construction —
apps/web/proxy.conf.json forwards /api to this process with `"ws": true` in dev,
and there is one origin in production. The cookie is SameSite=Lax
(app/routers/auth.py), which is also why a cross-site page cannot carry it onto
this handshake at all.

RULE 1 (AGENTS.md). The Realtime session is a REMOTE provider, so no student
record enters it. This module reads the session ONLY to answer "who owns the
conversation these turns are written to" — that id never leaves the process. The
sole thing sent upstream is the fixed persona in app/interview_relay.py plus the
student's microphone. Nothing here imports app.assistant_tools, app.knowledge or
app.ai.llm, and no student field is ever placed on the uplink.

PERSISTENCE. Turns land in the SAME conversations/messages tables the text agent
and the LiveKit voice worker use, through app/conversations.py, so
GET /api/agent/history returns them unchanged and the AGENTS.md runbook query
    select channel, count(*), max(created_at) from messages group by channel;
grows an `interview` row. There is no parallel transcript store.
"""

import asyncio
import logging
import uuid

from fastapi import APIRouter, Depends, WebSocket, WebSocketException
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError

from .. import conversations as convo
from ..config import settings
from ..db import SessionLocal
from ..deps import get_current_session, get_ws_session
from ..interview_matrix import get_specialization
from ..interview_relay import (
    _CLOSE_FORBIDDEN_ORIGIN,
    _CLOSE_GOING_AWAY,
    _CLOSE_INTERNAL,
    _CLOSE_NOT_CONFIGURED,
    _CLOSE_OVERLOADED,
    _CLOSE_UNKNOWN_SPECIALIZATION,
    _ConnectionLimiter,
    _RelaySession,
    _close_downstream,
    ask_all_sessions_to_stop,
)
from ..models.user import Role

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/interview", tags=["interview"])

# 1008 is the code FastAPI's own WebSocket validation handler uses for a policy
# refusal, and get_ws_session already raises with it. "Not signed in" and "not a
# student" deliberately SHARE it: both are "you are not allowed here", the client
# has one sentence covering both (CLOSE_MESSAGES in interview.service.ts), and a
# private-use code the client did not map would degrade to "closed unexpectedly".
_CLOSE_NOT_A_STUDENT = 1008

# The channel this surface writes under. "interview", NOT "voice": both are
# spoken, but they are different products with different retention questions, and
# folding them together would leave the runbook unable to answer "did the
# interviewer save anything" independently of LiveKit. Message.channel is a plain
# String column (app/models/conversation.py), so this needs no migration, and
# conversations.history() filters on is_final only — never on channel — so
# GET /api/agent/history returns these turns like any other.
_CHANNEL = "interview"

# PER-WORKER, for the reason app/config.py gives on interview_max_sessions: one
# CPython process cannot carry the full student body's audio, so N uvicorn
# workers give N times this. Module-level rather than app.state because the cap
# is a property of the process, and a second FastAPI app in one process (tests)
# must not silently double it.
_LIMITER = _ConnectionLimiter(settings.interview_max_sessions)

# Live sessions, so shutdown can ask each to close with a real code and reason
# instead of being torn down as a bare 1006. Not keyed by student, room or id —
# which is what lets this process be replicated with no shared registry.
_LIVE_SESSIONS: set[_RelaySession] = set()


class StatusOut(BaseModel):
    available: bool
    reason: str | None = None
    active_sessions: int
    max_sessions: int


@router.get("/status", response_model=StatusOut)
def interview_status(session: dict = Depends(get_current_session)) -> StatusOut:
    """Why the socket would refuse, in words — the ONLY place a student learns it.

    A rejected WebSocket handshake reaches the browser as a bare 1006 with no
    code and no reason, so this probe is the client's one chance to say "not
    configured" or "not a student" instead of "check your network".

    Deliberately 200-with-a-reason for a non-student, where GET /api/voice/status
    raises 403: the interview client treats ANY non-2xx as "probe unavailable"
    and falls through to the socket (interview.service.ts), so a 403 here would
    throw away the very explanation this endpoint exists to give. Nothing about
    a student's data is disclosed either way.
    """
    if session.get("role") != Role.STUDENT.value:
        return StatusOut(
            available=False,
            reason="Mock interviews are a student feature.",
            active_sessions=_LIMITER.active,
            max_sessions=_LIMITER.limit,
        )
    if not settings.realtime_ready:
        log.warning(
            "GET /api/interview/status -> unavailable: OPENAI_API_KEY is not set"
        )
        return StatusOut(
            available=False,
            reason="Mock interviews are not configured on this server yet.",
            active_sessions=_LIMITER.active,
            max_sessions=_LIMITER.limit,
        )
    if _LIMITER.active >= _LIMITER.limit:
        return StatusOut(
            available=False,
            reason="Too many interviews are running right now. Try again shortly.",
            active_sessions=_LIMITER.active,
            max_sessions=_LIMITER.limit,
        )
    return StatusOut(
        available=True,
        reason=None,
        active_sessions=_LIMITER.active,
        max_sessions=_LIMITER.limit,
    )


def _make_turn_writer(conversation_id: str):
    """A SYNCHRONOUS writer for one interview's turns, bound to its conversation.

    Synchronous on purpose: app/conversations.py is synchronous SQLAlchemy, and
    the relay runs this on a worker thread (asyncio.to_thread) so a round trip to
    Postgres never stalls the event loop carrying every other student's audio.

    It opens its OWN short-lived Session per turn rather than holding one for the
    call. An interview runs up to 15 minutes; a Session held that long pins a
    pooled connection and keeps an idle transaction open, which blocks autovacuum
    and — at interview_max_sessions — would starve every HTTP request on this
    worker. This is also why the WebSocket route has no Depends(get_db).

    It deliberately does NOT catch the general case. The relay calls this
    fire-and-forget and logs a failure with its cause against the connection id
    (_RelaySession._run_turn_write), so catching here would only lose the one
    identifier that makes the line diagnosable. IntegrityError is the exception,
    because it is not a failure at all — see below.
    """

    def write(sender: str, text: str, provider_turn_id: str) -> None:
        db = SessionLocal()
        try:
            convo.append_message(
                db,
                conversation_id,
                sender,
                text,
                channel=_CHANNEL,
                is_final=True,
                provider_turn_id=provider_turn_id,
            )
        except IntegrityError:
            # append_message's read-then-insert dedup is a CHECK, not a
            # guarantee: two writes for one turn can both pass it before either
            # commits, and the unique index on
            # (conversation_id, provider_turn_id) then fires. The turn IS
            # stored — by the other writer — so this is the idempotent no-op it
            # looks like, not a failure. Same handling as /api/voice/transcript.
            db.rollback()
        finally:
            db.close()

    return write


@router.websocket("")
async def interview(websocket: WebSocket) -> None:
    """One interview, relayed.

    ACCEPT FIRST, then check. A close sent BEFORE accept fails the HTTP upgrade,
    and the browser WebSocket API surfaces neither code nor reason for that — the
    student would see an opaque 1006 and "not signed in" would be
    indistinguishable from "the wifi dropped". Every refusal below is therefore a
    close on an accepted socket, which is the only way the cause reaches them.
    """
    conn_id = uuid.uuid4().hex[:12]
    await websocket.accept()

    # Defence in depth, not the gate. The cookie is SameSite=Lax, so a cross-site
    # page cannot carry reep_session onto this handshake in the first place; this
    # refuses the mismatched browser before it costs an upstream connection. Only
    # a PRESENT-and-wrong Origin is refused: a non-browser client omitting the
    # header is stopped by the session check below, and refusing on absence would
    # break nothing an attacker relies on while risking a same-origin deployment.
    origin = websocket.headers.get("origin")
    if origin is not None and origin != settings.web_origin:
        log.warning(
            "[conn=%s] WS /api/interview -> %d: origin %r is not %s",
            conn_id,
            _CLOSE_FORBIDDEN_ORIGIN,
            origin,
            settings.web_origin,
        )
        await _close_downstream(
            websocket, _CLOSE_FORBIDDEN_ORIGIN, "Origin not allowed"
        )
        return

    try:
        session = get_ws_session(websocket)
    except WebSocketException as exc:
        log.warning(
            "[conn=%s] WS /api/interview -> %d: no valid reep_session cookie",
            conn_id,
            exc.code,
        )
        await _close_downstream(websocket, exc.code, exc.reason or "Sign in required.")
        return

    # Role scoping is the ROUTER's job in this repo (require_mentor +
    # _assert_can_access_student, and voice.py's own STUDENT check), so
    # get_ws_session authenticates and this authorises. Hiding the Start button
    # in the Angular component is not a gate: a MENTOR or DIRECTOR holding a
    # valid cookie can open this socket from devtools in one line, and each open
    # costs a billed upstream Realtime session.
    if session.get("role") != Role.STUDENT.value:
        log.warning(
            "[conn=%s] WS /api/interview -> %d: role %s is not STUDENT",
            conn_id,
            _CLOSE_NOT_A_STUDENT,
            session.get("role"),
        )
        await _close_downstream(
            websocket,
            _CLOSE_NOT_A_STUDENT,
            "Mock interviews are a student feature.",
        )
        return

    if not settings.realtime_ready:
        log.error(
            "[conn=%s] WS /api/interview -> %d: OPENAI_API_KEY is not set",
            conn_id,
            _CLOSE_NOT_CONFIGURED,
        )
        await _close_downstream(
            websocket, _CLOSE_NOT_CONFIGURED, "Voice service not configured"
        )
        return

    if not _LIMITER.try_acquire():
        log.warning(
            "[conn=%s] WS /api/interview -> %d: %d/%d interviews on this worker",
            conn_id,
            _CLOSE_OVERLOADED,
            _LIMITER.active,
            _LIMITER.limit,
        )
        await _close_downstream(
            websocket, _CLOSE_OVERLOADED, "Too many interviews in progress"
        )
        return

    # The Specialization Matrix row, chosen by the student in the UI and carried
    # as a query param because a browser WebSocket cannot set headers. ABSENT is
    # the generic interview that predates the matrix; PRESENT-but-unknown is a
    # client bug or a hand-rolled socket, and is refused outright rather than
    # silently downgraded -- a student who asked for an HR interview and got a
    # generic one was assessed against the wrong bar with no sign of it.
    # Checked AFTER the limiter so a bad param never holds a slot.
    spec_key = websocket.query_params.get("specialization")
    specialization = get_specialization(spec_key)
    if spec_key and specialization is None:
        log.warning(
            "[conn=%s] WS /api/interview -> %d: unknown specialization %r",
            conn_id,
            _CLOSE_UNKNOWN_SPECIALIZATION,
            spec_key,
        )
        _LIMITER.release()
        await _close_downstream(
            websocket,
            _CLOSE_UNKNOWN_SPECIALIZATION,
            f"Unknown specialization: {spec_key}",
        )
        return

    # From here on the slot is HELD, so every exit path must release it.
    try:
        # The conversation is derived from the SESSION, never from the client —
        # the same rule POST /api/agent/ask and POST /api/voice/token follow.
        # to_thread because get_or_create is synchronous SQLAlchemy and this
        # coroutine is on the loop shared with every other live interview.
        conversation_id = await asyncio.to_thread(
            _open_conversation, session["userId"], Role(session["role"])
        )
    except Exception:
        _LIMITER.release()
        log.exception(
            "[conn=%s] WS /api/interview -> %d: cannot open a conversation",
            conn_id,
            _CLOSE_INTERNAL,
        )
        await _close_downstream(websocket, _CLOSE_INTERNAL, "Internal error")
        return

    relay = _RelaySession(
        websocket,
        conn_id,
        on_turn=_make_turn_writer(conversation_id),
        specialization=specialization,
    )
    _LIVE_SESSIONS.add(relay)
    code, reason = _CLOSE_INTERNAL, "Internal error"
    try:
        code, reason = await relay.run()
    except asyncio.CancelledError:
        # App shutdown that outran the graceful drain. Reported honestly and
        # re-raised: swallowing CancelledError breaks the shutdown it belongs to.
        code, reason = _CLOSE_GOING_AWAY, "Server shutting down"
        raise
    except Exception:
        # Nothing in relay.run() matched, so this is a bug here rather than peer
        # behaviour. The traceback is the point; the student gets a generic 1011.
        log.exception("[conn=%s] Unhandled error in the interview relay", conn_id)
        code, reason = _CLOSE_INTERNAL, "Internal error"
    finally:
        _LIVE_SESSIONS.discard(relay)
        _LIMITER.release()
        await _close_downstream(websocket, code, reason)


def _open_conversation(user_id: str, role: Role) -> str:
    """The caller's server-owned conversation id. Opened and closed in one go."""
    db = SessionLocal()
    try:
        return convo.get_or_create(db, user_id, role).id
    finally:
        db.close()


def shutdown_interviews() -> None:
    """Ask every live interview to close itself. Called from app/main.py lifespan."""
    ask_all_sessions_to_stop(_LIVE_SESSIONS)
