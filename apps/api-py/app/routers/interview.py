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

PERSISTENCE, IN TWO PLACES THAT MUST NOT DISAGREE. Every turn still lands in the
SAME conversations/messages tables the text agent and the LiveKit voice worker
use, through app/conversations.py, so GET /api/agent/history returns them
unchanged and the AGENTS.md runbook query
    select channel, count(*), max(created_at) from messages group by channel;
grows an `interview` row. That contract does not bend.

ALONGSIDE it -- never instead of it -- each turn also writes an `interview_turns`
row carrying what a shared `messages` row cannot: the phase it happened in,
whether the transcriber actually heard it, and whether it advanced the arc. The
two inserts share ONE transaction (interview-engine-v3 §6.5). A second
fire-and-forget writer was considered and rejected: it doubles the pool pressure
at interview_max_sessions, and it can PARTIALLY succeed -- `messages` has the
turn and `interview_turns` does not, or the reverse -- which puts the runbook
query in the position of reporting "saved fine" while the reviewable record is
missing turns. That is the exact silent failure the runbook exists to catch,
reintroduced somewhere new.

An `interview_sessions` row is opened beside the conversation and closed by
whichever of three layers gets there first: the relay's own finalizer (Layer 1),
this module's `finally` backstop (Layer 2), and retention's orphan sweeper
(Layer 3, for the process that was killed). A `running` row that is never closed
is worse than no row -- it is a record that lies.

CONSENT IS ENFORCED HERE, and it is the last gate the socket passes. No live
`interview_consents` row for the CURRENT version -> the interview never opens and
the socket closes 4013; the grant revoked while the interview is running -> the
heartbeat notices within a minute and the socket closes 4014. Both gates read a
row, never a client claim, and the exact grant is pinned on
`interview_sessions.consent_id` so "was this student consented, to what wording,
at the time of interview X" survives every later revocation. The gate could only
be turned on AFTER the browser started posting grants (interview-engine-v3 §8.3),
which is why it arrived a step later than the table it reads.

AUDIO IS OFF, AND "OFF" IS TWO INDEPENDENT SWITCHES. This module is where the
recorder is constructed (app.interview_audio.recorder_for), and it hands back
None unless INTERVIEW_RECORDING_ENABLED is true AND the student holds a live
`scope_store_audio` grant. Neither is true in a default deployment, so nothing is
written. When both are true, the five `audio_*` columns written by the Layer 1
finalizer are the ONLY record that a file exists -- retention deletes recordings
by reading them -- which is why they are set in the same UPDATE as the terminal
status and not in a second write that could fail on its own.
"""

import asyncio
import logging
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, WebSocket, WebSocketException
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from .. import conversations as convo
from ..config import settings
from ..db import SessionLocal, engine
from ..identity import get_current_session, get_ws_session
from ..interview_audio import recorder_for
from ..interview_matrix import Specialization, get_specialization
from ..interview_relay import (
    _CLOSE_CONSENT_REQUIRED,
    _CLOSE_CONSENT_REVOKED,
    _CLOSE_DAILY_CAP,
    _CLOSE_FORBIDDEN_ORIGIN,
    _CLOSE_GOING_AWAY,
    _CLOSE_IDLE,
    _CLOSE_INTERNAL,
    _CLOSE_NOT_CONFIGURED,
    _CLOSE_OK,
    _CLOSE_OVERLOADED,
    _CLOSE_SESSION_CAP,
    _CLOSE_UNKNOWN_SPECIALIZATION,
    _CLOSE_USER_SESSION_CAP,
    _REFUSED_BY_USER,
    _ConnectionLimiter,
    _RelaySession,
    _ReportRecord,
    _SessionOutcome,
    _TurnRecord,
    _TurnWriteRefused,
    _close_downstream,
    ask_all_sessions_to_stop,
)
from ..models.interview import (
    InterviewConsent,
    InterviewEvaluation,
    InterviewSession,
    InterviewTurn,
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
#
# The second number is the per-USER cap (audit H1): the worker cap counts
# sessions and never asks whose they are, so one student looping
# `new WebSocket('/api/interview')` from devtools took every slot and everyone
# else was answered 1013 -- each of those sockets billing an upstream Realtime
# session from the handshake's response.create with no microphone input at all.
_LIMITER = _ConnectionLimiter(
    settings.interview_max_sessions, settings.interview_max_sessions_per_user
)

# The model's raw scorecard text kept on the evaluation row for a DIRECTOR to
# read when a parse goes wrong. Truncated because it is unbounded model output
# on a row nobody paginates; 8000 characters is an order of magnitude past the
# 800-token response the relay asks for, so a healthy report is never clipped and
# a runaway one cannot become the largest column in the database.
_MAX_RAW_RESPONSE_CHARS = 8000

# Interviews the sweeper will never see, because they never ran: a `running` row
# is only honest while a socket is actually holding it.
_TERMINAL_ABANDONED = "abandoned"
_TERMINAL_FAILED = "failed"

# Live sessions, so shutdown can ask each to close with a real code and reason
# instead of being torn down as a bare 1006. Not keyed by student, room or id —
# which is what lets this process be replicated with no shared registry.
_LIVE_SESSIONS: set[_RelaySession] = set()


class _ConsentRequired(Exception):
    """This student holds no live grant for the current terms, so 4013.

    A type rather than a sentinel return, because the alternative is a
    `(conversation_id, interview_session_id, ok)` triple whose third element one
    caller eventually forgets to read — and the failure mode of forgetting is an
    interview that runs without consent, which is the one thing this gate exists
    to make impossible. An exception cannot be ignored by accident.

    Raised from `_open_records` BEFORE anything is written, so a refusal leaves
    no conversation, no `interview_sessions` row for the sweeper to trip over,
    and nothing for a mentor to read as an interview that happened.
    """


class _DailyCapReached(Exception):
    """This student has already run today's quota of interviews, so 4015.

    The VOLUME half of the per-user cap (the _LIMITER's 4012 is the concurrency
    half): 2 concurrent slots with no volume ceiling was ~96 billable sessions a
    day from one looping account, invisible until the invoice. A type rather
    than a sentinel return for the same reason as _ConsentRequired above — an
    exception cannot be ignored by accident — and raised from `_open_records`
    BEFORE anything is written or any upstream socket opens, so a refused
    attempt costs nothing and records nothing.
    """


class _UserSessionCapReached(Exception):
    """This student already holds their concurrency quota of LIVE interviews
    somewhere in the fleet, so 4012 — the cross-worker half of the check the
    per-process _LIMITER can only make for its own worker.

    With one worker the _LIMITER's answer WAS the fleet's answer. WEB_CONCURRENCY
    workers each carry their own limiter, so without this a student could hold
    interview_max_sessions_per_user live interviews PER WORKER — the review of
    the 2026-08 fix wave caught exactly that. The database is the only party
    that sees every worker, so `_open_records` counts `running` rows there,
    inside the same advisory-locked transaction as the daily cap.

    Only rows with a FRESH heartbeat count (see _LIVE_ELSEWHERE_GRACE_S): a
    worker that was kill -9'd leaves rows stamped `running` until the next boot
    sweep, and a hard count of those would lock its students out of interviews
    through no act of their own. A stale-heartbeat row is a dead session,
    whatever its status column still claims.
    """


# A `running` row whose heartbeat is older than this is treated as dead for the
# cross-worker concurrency count above. 3x the relay's 60 s heartbeat interval:
# one missed beat is a busy loop, two is suspicious, three is a process that is
# not coming back — and deliberately far below interview_orphan_grace_seconds
# (1200), which answers the different question of when to REWRITE the row.
_LIVE_ELSEWHERE_GRACE_S = 180


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
    if not settings.interview_ready:
        # ENGINE-AWARE, and it has to be: `realtime_ready` asks the OpenAI
        # question alone, so a deployment running INTERVIEW_ENGINE=nova (signed
        # by an IAM role) or =local (nothing leaves the machine) was told its
        # interviews were unconfigured until somebody pasted an OpenAI key it
        # would never spend.
        log.warning(
            "GET /api/interview/status -> unavailable: engine %r is not configured",
            settings.interview_engine,
        )
        return StatusOut(
            available=False,
            reason=settings.interview_unready_reason,
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
    if _LIMITER.active_for(session["userId"]) >= _LIMITER.per_user_limit:
        # Asked here as well as at the socket so the student reads a sentence
        # instead of watching a Start button fail. The two caps get DIFFERENT
        # words on purpose: "the server is busy" and "your own last interview is
        # still open" lead to opposite actions, and the second one is fixed by
        # closing the other tab rather than by waiting.
        return StatusOut(
            available=False,
            reason=(
                "You already have a mock interview open in another tab. "
                "Close it, or wait a moment for it to time out."
            ),
            active_sessions=_LIMITER.active,
            max_sessions=_LIMITER.limit,
        )
    return StatusOut(
        available=True,
        reason=None,
        active_sessions=_LIMITER.active,
        max_sessions=_LIMITER.limit,
    )


def _make_turn_writer(conversation_id: str, interview_session_id: str):
    """A SYNCHRONOUS writer for one interview's turns, bound to BOTH its records.

    Synchronous on purpose: app/conversations.py is synchronous SQLAlchemy, and
    the relay runs this on a worker thread (asyncio.to_thread) so a round trip to
    Postgres never stalls the event loop carrying every other student's audio.

    It takes its OWN short-lived connection and Session per turn rather than
    holding one for the call. An interview runs up to 15 minutes; a Session held
    that long pins a pooled connection and keeps an idle transaction open, which
    blocks autovacuum and — at interview_max_sessions — would starve every HTTP
    request on this worker. This is also why the WebSocket route has no
    Depends(get_db).

    It deliberately does NOT catch the general case. The relay calls this
    fire-and-forget and logs a failure with its cause against the connection id
    (_RelaySession._run_turn_write), so catching here would only lose the one
    identifier that makes the line diagnosable. The two exceptions below are
    handled because neither is that: one is not a failure at all, and the other
    is a failure only the relay can act on.

    TWO INSERTS, ONE TRANSACTION (§6.5), AND THAT COSTS ONE UNUSUAL LINE. The
    Session is bound to a Connection that already has a transaction open, with
    `join_transaction_mode="create_savepoint"`, because `append_message` ends
    with its own `db.commit()` — and inside a joined transaction that commit
    releases a SAVEPOINT instead of ending the real one. So both rows land in a
    single COMMIT to Postgres, and `interview_turns.message_id` can be filled in
    from a Message that has an id only after that flush.

    Two traps in that arrangement, both silent if got wrong:

      * `db.close()` ROLLS BACK the open savepoint. The explicit `db.commit()`
        before the `finally` is what releases it; without that line the FK
        back-link is written and then quietly discarded, and the only symptom is
        a `message_id` column that is always NULL.
      * an IntegrityError on EITHER table rolls back BOTH. That is deliberate,
        not a cost we failed to avoid: `interview_turns` carries the same
        `(session, provider_turn_id)` unique shape as `messages`, so a retry of
        one turn is a no-op either way — the turn is already stored by the
        winner. The alternative, two independent writers, can leave the two
        records disagreeing about which turns happened, and a record that can
        silently disagree with `messages` has no value at all.
    """

    def write(
        sender: str, text: str, provider_turn_id: str, record: _TurnRecord
    ) -> None:
        try:
            with engine.connect() as conn, conn.begin():
                db = SessionLocal(
                    bind=conn, join_transaction_mode="create_savepoint"
                )
                try:
                    turn = InterviewTurn(
                        interview_session_id=interview_session_id,
                        seq=record.seq,
                        # The DB vocabulary is student/interviewer where the
                        # messages vocabulary is user/assistant. Translated HERE,
                        # at the boundary that owns the schema, so the relay
                        # never has to know a second set of words for the two
                        # parties in the room.
                        speaker="student" if sender == "user" else "interviewer",
                        phase=record.phase,
                        content=text,
                        transcription_status=record.transcription_status,
                        answer_quality=record.answer_quality,
                        counted_as_answer=record.counted_as_answer,
                        is_partial=record.is_partial,
                        provider_turn_id=provider_turn_id,
                    )
                    db.add(turn)
                    if text.strip():
                        # THE BLANK-TEXT CARVE-OUT (L4), and it is this `if`.
                        # A transcription that timed out or failed arrives as ""
                        # — and those are exactly the turns
                        # `transcription_status` exists to record, so the
                        # interview_turns row above is written REGARDLESS. What
                        # is skipped is only the `messages` row: an empty chat
                        # bubble in GET /api/agent/history says "the student said
                        # nothing", which is the opposite of what happened.
                        message = convo.append_message(
                            db,
                            conversation_id,
                            sender,
                            text,
                            channel=_CHANNEL,
                            is_final=True,
                            provider_turn_id=provider_turn_id,
                        )
                        turn.message_id = message.id
                    db.commit()
                finally:
                    db.close()
        except convo.ConversationGone as exc:
            # L5, and the contract append_message's docstring sets out. The
            # student cleared this chat thread from another tab (or retention
            # purged it) mid-call, so every remaining turn of a 15-minute session
            # would be refused identically. Translated into the relay's own
            # vocabulary rather than raised across the module boundary, because
            # app/interview_relay.py imports no ORM model and no database code at
            # all and that containment is the point — see _TurnWriteRefused. It
            # is NOT swallowed and NOT folded into the IntegrityError branch
            # below, which is precisely what that contract forbids: the relay
            # logs it against the connection id and ends the session.
            raise _TurnWriteRefused(str(exc)) from exc
        except IntegrityError:
            # append_message's read-then-insert dedup is a CHECK, not a
            # guarantee: two writes for one turn can both pass it before either
            # commits, and the unique index on
            # (conversation_id, provider_turn_id) then fires. The turn IS
            # stored — by the other writer — so this is the idempotent no-op it
            # looks like, not a failure. Same handling as /api/voice/transcript,
            # and `uq_interview_turn_provider` gives the second table the same
            # property for the same reason. Nothing to roll back by hand: the
            # transaction above already unwound on its way out.
            #
            # ONE OTHER THING CAN LAND HERE, and it is worth knowing about: a
            # foreign-key violation, if the Student row was deleted mid-call and
            # took interview_sessions with it by CASCADE. Swallowed too, and
            # acceptably so — that student's whole record is gone by design, so
            # there is nothing left for this turn to belong to. Any NEW cause of
            # IntegrityError on this path would be silent, so add its own branch
            # rather than widening this one.
            pass

    return write


def _make_report_writer(interview_session_id: str):
    """The one evaluation row for this interview. AWAITED by the relay, not fired.

    Called exactly once, after the interview is over, which is why the relay
    waits for it (L3): left on the fire-and-forget path it would be the last
    write scheduled and therefore the first one the teardown drain cancels — the
    scorecard would be the piece most likely to be missing.

    A row is written for EVERY outcome, including the failures. `report_status`
    of 'unparseable', 'timeout' or 'rejected' is a record that a report was
    attempted and did not arrive; a missing row says nothing at all, and a mentor
    cannot tell it from an interview that predates the feature.
    """

    def write(record: _ReportRecord) -> None:
        db = SessionLocal()
        try:
            # Present only on success — and on success every key exists, because
            # the relay's parser coerces the whole shape before it gets here.
            report = record.report or {}
            raw = record.raw_response[:_MAX_RAW_RESPONSE_CHARS]
            db.add(
                InterviewEvaluation(
                    interview_session_id=interview_session_id,
                    report_status=record.status,
                    # NULLABLE EVEN WHEN report_status='ok', and never
                    # substituted with 0: a missing score and a zero mean
                    # opposite things to the person reading them. The parser
                    # returns None for a score the model did not give, and that
                    # None travels all the way to the screen.
                    overall_score=report.get("overall"),
                    communication_score=report.get("communication"),
                    domain_score=report.get("domain"),
                    structure_score=report.get("structure"),
                    # None rather than [] when there is no report at all: an
                    # empty list would claim the model listed no strengths.
                    strengths=report.get("strengths") if record.report else None,
                    improvements=(
                        report.get("improvements") if record.report else None
                    ),
                    drill=report.get("drill"),
                    summary=report.get("summary"),
                    raw_response=raw or None,
                    model=record.model or None,
                )
            )
            db.commit()
        except IntegrityError:
            # DF6. The report deadline and a late response.done can both settle
            # once each in a pathological ordering, and the UNIQUE constraint on
            # interview_session_id makes the second one a no-op. FIRST WRITE
            # WINS, deliberately: the earlier row is the one whose status matches
            # what the student was actually told.
            db.rollback()
        finally:
            db.close()

    return write


def _make_finalizer(interview_session_id: str):
    """LAYER 1's database half: close the record, and record that no report came.

    The UPDATE carries `AND status = 'running'`, which is what makes all three
    finalization layers idempotent against each other with no coordination: the
    loser updates zero rows and says nothing.

    Two commits, in this order, and the order is the decision. The terminal
    status MUST land — a row stuck at `running` is a record that lies, and it is
    the failure this whole mechanism exists to prevent. The 'unavailable'
    evaluation row is a courtesy to whoever reads the screen afterwards. Sharing
    one transaction would let the courtesy's failure roll back the necessity.
    """

    def finalize(outcome: _SessionOutcome) -> None:
        db = SessionLocal()
        try:
            now = datetime.now(timezone.utc)
            result = db.execute(
                update(InterviewSession)
                .where(
                    InterviewSession.id == interview_session_id,
                    InterviewSession.status == "running",
                )
                .values(
                    status=outcome.status,
                    terminal_reason=outcome.terminal_reason,
                    final_phase=outcome.final_phase,
                    answers_accepted=outcome.answers_accepted,
                    turns_emitted=outcome.turns_emitted,
                    turns_persisted=outcome.turns_persisted,
                    close_code=outcome.close_code,
                    upstream_session_id=outcome.upstream_session_id,
                    # WHAT WAS KEPT OF THE STUDENT'S VOICE — written here and
                    # NOWHERE else. These five columns are the only record that
                    # a file exists, and `retention.purge_expired` destroys
                    # recordings by reading them, so a recording whose row never
                    # received them is a recording nothing will ever delete: a
                    # named student's voice on disk, past its retention window,
                    # invisible to every query. The relay has already closed and
                    # flushed the files by the time this runs (_close_recorder is
                    # awaited before the outcome is composed), which is what
                    # makes audio_bytes a final number rather than a snapshot.
                    #
                    # In every deployment today all five are the defaults —
                    # recording needs INTERVIEW_RECORDING_ENABLED *and* a live
                    # scope_store_audio grant (app/interview_audio.py) — and the
                    # defaults say "we know nothing was kept" rather than
                    # leaving the row ambiguous. Branch on `audio_recorded`,
                    # never on `audio_path IS NOT NULL`.
                    audio_recorded=outcome.audio_recorded,
                    audio_path=outcome.audio_path,
                    audio_bytes=outcome.audio_bytes,
                    audio_duration_ms=outcome.audio_duration_ms,
                    audio_truncated=outcome.audio_truncated,
                    heartbeat_at=now,
                    ended_at=now,
                )
            )
            db.commit()
            if not result.rowcount:
                # Somebody finalized first — normally impossible, since Layer 2
                # only runs after this returns. Worth a line rather than silence:
                # if it starts happening, two layers are racing and the row's
                # terminal status is whichever of them is less informed.
                log.info(
                    "Interview session %s was already finalized; "
                    "left as it stands",
                    interview_session_id,
                )

            if outcome.report_status is None:
                # WRAP_UP was never reached, so no scorecard was ever requested.
                # The row says `unavailable` so a mentor reads "no report — this
                # interview hit the cap" instead of a blank panel they cannot
                # distinguish from a bug.
                db.add(
                    InterviewEvaluation(
                        interview_session_id=interview_session_id,
                        report_status="unavailable",
                    )
                )
                try:
                    db.commit()
                except IntegrityError:
                    # An evaluation already exists, so the scorecard did settle
                    # and this session simply did not know. The real row wins.
                    db.rollback()
        finally:
            db.close()

    return finalize


def _make_heartbeat(
    interview_session_id: str,
    *,
    consent_id: str | None = None,
    on_consent_revoked: Callable[[], None] | None = None,
):
    """Stamp heartbeat_at — and notice a consent grant that has gone away (4014).

    Scoped to `status = 'running'` so a heartbeat still in flight when the
    session finalizes cannot touch a row that is already closed — the sweeper
    keys on status anyway, but a closed row with a moving timestamp is the kind
    of thing that costs somebody an afternoon.

    THE SECOND STATEMENT IS 4014, AND IT IS A POLL, NOT THE PUSH §7.1 SKETCHES.
    Having `DELETE /api/interview/consent` call a `stop_sessions_for_user()`
    would be immediate, and it would also be wrong most of the time: any
    registry it could consult — `_LIVE_SESSIONS` here included — is per-PROCESS,
    so with N uvicorn workers the revoking request lands on a worker that is not
    holding the socket in (N-1)/N of cases, and the push then does nothing at
    all while looking like it worked. Re-reading the grant on a heartbeat the
    session is already issuing catches a revocation from any worker, any tab and
    any future code path that stamps `revoked_at`, for one indexed SELECT a
    minute per live interview. The cost is up to _HEARTBEAT_WRITE_INTERVAL_S of
    delay, and that is a backstop's delay rather than a student watching a
    button: the assistant screen refuses to offer "Withdraw" while an interview
    is running (assistant.component.ts).

    IT WATCHES THE EXACT GRANT THE INTERVIEW OPENED UNDER, by id, never "is
    there a live grant for the current version". An operator bumping
    INTERVIEW_CONSENT_VERSION mid-session would otherwise end every interview in
    progress with "you withdrew consent", which is a sentence the student did
    not earn and an event nobody could explain afterwards.

    IT FAILS OPEN, and that asymmetry against the gate in `_open_records` is
    deliberate. Opening an interview fails CLOSED because "we could not check
    whether they agreed" must never start one. Ending an interview must not:
    a transient database error here would kill a live call that a real grant
    authorised, so the stop runs only on a query that came back and said the row
    is gone. Anything that raises propagates to the relay's own "heartbeat not
    written" warning, and the interview continues.

    Both new arguments are keyword-only and default to None, which means "stamp
    the heartbeat and watch nothing". That is the shape the relay's own tests
    want, and it is honest for them: they have no consent row to watch. It is
    never the shape a real interview gets — `_open_records` refuses without a
    grant, so a live session always has an id to pass here.
    """

    def beat() -> None:
        db = SessionLocal()
        try:
            db.execute(
                update(InterviewSession)
                .where(
                    InterviewSession.id == interview_session_id,
                    InterviewSession.status == "running",
                )
                .values(heartbeat_at=datetime.now(timezone.utc))
            )
            db.commit()
            if consent_id is None or on_consent_revoked is None:
                return
            still_live = db.scalar(
                select(InterviewConsent.id)
                .where(
                    InterviewConsent.id == consent_id,
                    InterviewConsent.revoked_at.is_(None),
                )
                .limit(1)
            )
            if still_live is None:
                on_consent_revoked()
        finally:
            db.close()

    return beat


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
        # to_thread because verify_session_token's revocation check runs a
        # SELECT on a cache miss (security.py says so itself), and this
        # coroutine is on the loop shared with every live interview's audio —
        # the audit found a pool-starved handshake could park the loop for the
        # whole pool timeout, silencing every interview at once.
        session = await asyncio.to_thread(get_ws_session, websocket)
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

    # A STUDENT with no `studentId` claim — a User row with no Student row, which
    # the roster seed does not produce but a hand-made account can — cannot have
    # an interview record, because interview_sessions.student_id is NOT NULL and
    # rule 2's gate is written against that column. Refused HERE, sharing 1008
    # with the role check, so the student reads "you are not allowed here"
    # instead of meeting the NOT NULL violation as an opaque 1011 thirty seconds
    # later with an upstream session already billed.
    student_id = session.get("studentId")
    if not student_id:
        log.error(
            "[conn=%s] WS /api/interview -> %d: STUDENT session has no studentId",
            conn_id,
            _CLOSE_NOT_A_STUDENT,
        )
        await _close_downstream(
            websocket,
            _CLOSE_NOT_A_STUDENT,
            "Your student profile is incomplete; ask the placement cell.",
        )
        return

    if not settings.interview_ready:
        # Asked of the ENGINE this deployment actually runs — see the same
        # check in the status probe above. The close reason stays generic
        # because it is read by a student; the log line names the engine,
        # because it is read by the operator who can fix it.
        log.error(
            "[conn=%s] WS /api/interview -> %d: engine %r is not configured",
            conn_id,
            _CLOSE_NOT_CONFIGURED,
            settings.interview_engine,
        )
        await _close_downstream(
            websocket, _CLOSE_NOT_CONFIGURED, "Voice service not configured"
        )
        return

    # ONE acquire, TWO caps, and which one refused decides the close code. A
    # two-step acquire is a slot leak waiting to happen: the first step succeeds,
    # the second refuses, and the slot the first one took is released only on the
    # paths somebody remembered.
    user_id = session["userId"]
    refused_by = _LIMITER.try_acquire(user_id)
    if refused_by == _REFUSED_BY_USER:
        # Audit H1. The worker cap never asked WHOSE sessions it was counting, so
        # one student could open them all — each socket authenticating, opening
        # an upstream Realtime session and billing from the handshake's
        # response.create with no microphone input at all, while every other
        # student was answered 1013 and the graph read as a capacity incident.
        # 4012 rather than 1013 so the student is told the true cause: their own
        # other interview is still open, and closing that tab fixes it.
        log.warning(
            "[conn=%s] WS /api/interview -> %d: user already holds %d/%d interviews",
            conn_id,
            _CLOSE_USER_SESSION_CAP,
            _LIMITER.active_for(user_id),
            _LIMITER.per_user_limit,
        )
        await _close_downstream(
            websocket,
            _CLOSE_USER_SESSION_CAP,
            "You already have a mock interview open. Close it and try again.",
        )
        return
    if refused_by:
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
        _LIMITER.release(user_id)
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
        conversation_id, interview_session_id, consent_id = await asyncio.to_thread(
            _open_records,
            user_id,
            Role(session["role"]),
            student_id,
            conn_id,
            specialization,
        )
    except _ConsentRequired as exc:
        # 4013, and BEFORE the generic handler below on purpose: this is a
        # refusal, not a fault, and reporting it as 1011 "Internal error" would
        # tell a student to contact support about a panel they can tick
        # themselves. WARNING rather than exception() for the same reason —
        # there is no traceback worth printing.
        #
        # Note this is NOT mirrored into GET /api/interview/status. The client
        # treats `available: false` there as "do not start", which would hide
        # the very consent panel that fixes it; the panel is driven by
        # GET /api/interview/consent instead, and 4013 is what catches the cases
        # the panel cannot see (a cached bundle, a hand-rolled socket, a tab
        # left open across a revocation).
        _LIMITER.release(user_id)
        log.warning(
            "[conn=%s] WS /api/interview -> %d: no live consent for version %s",
            conn_id,
            _CLOSE_CONSENT_REQUIRED,
            exc,
        )
        await _close_downstream(
            websocket,
            _CLOSE_CONSENT_REQUIRED,
            "Interview consent required",
        )
        return
    except _UserSessionCapReached as exc:
        # 4012 from the DATABASE's view of the fleet: the student's other live
        # interview is on a different worker, where this process's _LIMITER
        # cannot see it. Same close code and same sentence as the in-process
        # refusal above — which worker spotted the duplicate is an
        # implementation detail the student must never need to care about.
        _LIMITER.release(user_id)
        log.warning(
            "[conn=%s] WS /api/interview -> %d: student %s already holds %s "
            "live interview(s) fleet-wide (per-user cap %d)",
            conn_id,
            _CLOSE_USER_SESSION_CAP,
            student_id,
            exc,
            settings.interview_max_sessions_per_user,
        )
        await _close_downstream(
            websocket,
            _CLOSE_USER_SESSION_CAP,
            "You already have a mock interview open. Close it and try again.",
        )
        return
    except _DailyCapReached as exc:
        # 4015: a refusal with a schedule, not a fault. WARNING because a
        # student meeting this cap honestly is rare — the expected causes are a
        # retry loop, a shared cookie, or a script, and the operator should see
        # which student id it is.
        _LIMITER.release(user_id)
        log.warning(
            "[conn=%s] WS /api/interview -> %d: student %s has run %s "
            "interviews in 24 h (cap %d)",
            conn_id,
            _CLOSE_DAILY_CAP,
            student_id,
            exc,
            settings.interview_max_per_student_per_day,
        )
        await _close_downstream(
            websocket,
            _CLOSE_DAILY_CAP,
            "You've reached today's mock interview limit. Try again tomorrow.",
        )
        return
    except Exception:
        _LIMITER.release(user_id)
        log.exception(
            "[conn=%s] WS /api/interview -> %d: cannot open the interview records",
            conn_id,
            _CLOSE_INTERNAL,
        )
        await _close_downstream(websocket, _CLOSE_INTERNAL, "Internal error")
        return

    # THE AUDIO RECORDER, or None — and None is the answer in every deployment
    # today. Both gates live inside recorder_for(): INTERVIEW_RECORDING_ENABLED
    # (false by default) AND a live `scope_store_audio` grant of the current
    # version. It is called HERE rather than inside the relay because
    # app/interview_relay.py imports no ORM model and no database code at all,
    # and a recording feature is not what that containment gets spent on. It is
    # total by its own contract — a bad id, an unwritable root or an unreachable
    # database all return None and the interview runs without a recording — so
    # there is deliberately no try around it. to_thread because the consent
    # check it performs is a query, and this coroutine shares a loop with every
    # other live interview's audio.
    recorder = await asyncio.to_thread(recorder_for, interview_session_id, user_id)

    # Captured on the loop, because the only thread that may hand work back to
    # an event loop is one holding a reference to it — asyncio.get_running_loop()
    # from the heartbeat's worker thread raises.
    loop = asyncio.get_running_loop()

    # Breaking one construction cycle, in the smallest place it can be broken:
    # the heartbeat hook has to be able to stop the relay (4014), and the relay
    # is constructed with its hooks. The closure reads this list at call time,
    # which is always after the append two lines below — the first heartbeat is
    # a minute away, and the relay is not even running yet.
    relay_box: list[_RelaySession] = []

    def _consent_withdrawn() -> None:
        """4014, from the heartbeat's worker thread back onto the event loop.

        `call_soon_threadsafe` rather than calling `request_stop` directly: that
        method sets an asyncio.Event, and setting one from another thread pokes
        loop internals without waking the selector. The session would still end
        (the watchdog re-enters `wait()` every _WATCHDOG_INTERVAL_S and Event
        short-circuits on an already-set flag) but it would end by accident, and
        under asyncio debug mode it would raise instead. One hop makes it
        correct rather than lucky.
        """
        try:
            loop.call_soon_threadsafe(
                relay_box[0].request_stop,
                _CLOSE_CONSENT_REVOKED,
                "Consent withdrawn",
            )
        except RuntimeError:
            # The loop is already closing, which means the session is ending
            # anyway and with a better-informed code than this one.
            log.info(
                "[conn=%s] Consent was withdrawn while the loop was closing; "
                "the session is already ending",
                conn_id,
            )

    # WHICH ENGINE. Chosen here and nowhere else: all three classes take this
    # constructor and all three return (code, reason) from run(), so every
    # writer, the limiter, the recorder and all three finalization layers below
    # are identical whichever one runs and never learn which one spoke.
    engine_cls = _RelaySession
    engine_name = settings.interview_engine.strip().lower()
    if engine_name == "local":
        from ..interview_local import LocalSession

        engine_cls = LocalSession
    elif engine_name == "nova":
        # Imported HERE and not at module scope, like the local engine above:
        # aws-sdk-bedrock-runtime pulls aiohttp and the whole smithy stack in,
        # and a deployment on another engine should not pay that at boot.
        from ..interview_nova import NovaSonicSession

        engine_cls = NovaSonicSession

    relay = engine_cls(
        websocket,
        conn_id,
        on_turn=_make_turn_writer(conversation_id, interview_session_id),
        specialization=specialization,
        on_report=_make_report_writer(interview_session_id),
        on_finalize=_make_finalizer(interview_session_id),
        on_heartbeat=_make_heartbeat(
            interview_session_id,
            consent_id=consent_id,
            on_consent_revoked=_consent_withdrawn,
        ),
        recorder=recorder,
    )
    relay_box.append(relay)
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
        _LIMITER.release(user_id)
        await _close_downstream(websocket, code, reason)
        # LAYER 2 of finalization, and it exists for the exits Layer 1 cannot
        # reach: the relay raising before its own finalizer ran, and shutdown
        # cancelling this coroutine (CancelledError re-raises AFTER this block,
        # so this still runs). Idempotent by predicate, not by flag — one UPDATE
        # with `AND status = 'running'`, so when the relay already finalized this
        # touches zero rows and says nothing.
        #
        # Bounded honesty about cancellation: under CancelledError the await
        # below may itself be cancelled, in which case the thread's UPDATE
        # usually still lands and Layer 3's sweeper covers the case where it does
        # not. That is the correct shape — a deploy must not be held open by a
        # bookkeeping write, and there is a third layer for exactly this.
        try:
            await asyncio.to_thread(
                _finalize_if_running, interview_session_id, conn_id, code, reason
            )
        except Exception:
            # Never allowed to replace the outcome with a teardown detail: the
            # student's close frame has already gone out with the real code, and
            # _close_downstream documents the same discipline one line above.
            log.exception(
                "[conn=%s] Interview backstop finalization failed", conn_id
            )


def _open_records(
    user_id: str,
    role: Role,
    student_id: str,
    conn_id: str,
    specialization: Specialization | None,
) -> tuple[str, str, str]:
    """The conversation AND the interview_sessions row, in one session, one hop.

    Opened together because a turn write needs both ids and because
    `interview_turns.interview_session_id` is NOT NULL — the session row must
    exist BEFORE the first turn, which is one extra insert per interview and not
    one per turn. A failure of either fails the socket the same way (1011), which
    is the honest answer: an interview whose record cannot be opened would be an
    interview nobody can review afterwards.

    THE CONSENT GATE IS NOW ENFORCED, and it is the FIRST statement — §8.3's
    ordering constraint is satisfied: `apps/web` posts to
    POST /api/interview/consent before it starts an interview and maps 4013 and
    4014, so turning this on no longer locks every existing student out of the
    feature on the deploy that ships it. It reads and it refuses; there is no
    "record whatever happened to be live" path left, because a grant that is not
    required is not a grant.

    IT REFUSES BEFORE IT WRITES. Nothing is created on this path — no
    conversation, no `interview_sessions` row — so a student who has not agreed
    leaves behind no record of an interview that never happened, and the orphan
    sweeper never meets a `running` row that had no socket.

    IT FAILS CLOSED by construction: an unreachable database raises out of this
    function and the socket closes 1011, which refuses the interview. "We could
    not check whether they agreed" and "they agreed" are not the same sentence,
    and only one of them may put a student's voice on a remote provider's wire.

    `consent_id` still pins the exact grant, and that remains the whole point of
    the column: "was this student consented, to what wording, at the time of
    interview X" stays answerable years later, after the grant has been revoked
    and re-given twice.
    """
    db = SessionLocal()
    try:
        # Serialize concurrent opens FOR THIS STUDENT across every worker for
        # the few milliseconds this transaction lives. The two caps below are
        # count-then-insert, and without a lock a burst of simultaneous
        # handshakes (2 per worker x WEB_CONCURRENCY workers) all read the
        # pre-insert count and all pass — the review of the 2026-08 fix wave
        # demonstrated the overshoot. pg_advisory_xact_lock releases itself at
        # COMMIT/ROLLBACK, so there is no unlock path to forget, and keying on
        # hashtext(student_id) scopes the queueing to one student — two
        # different students never wait on each other.
        db.execute(select(func.pg_advisory_xact_lock(func.hashtext(student_id))))
        consent = db.scalar(
            select(InterviewConsent)
            .where(
                InterviewConsent.user_id == user_id,
                InterviewConsent.version == settings.interview_consent_version,
                InterviewConsent.revoked_at.is_(None),
            )
            .order_by(InterviewConsent.granted_at.desc())
            .limit(1)
        )
        if consent is None:
            # Scoped to the CURRENT version, so terms that changed since the
            # student last agreed put them back in front of the new copy rather
            # than carrying them on an old yes. `GET /api/interview/consent`
            # answers the same question the same way, which is why the client
            # shows the panel instead of ever meeting this close code — 4013 is
            # for the stale bundle, the hand-rolled socket and the tab that sat
            # open across a revocation.
            raise _ConsentRequired(settings.interview_consent_version)
        now = datetime.now(timezone.utc)
        # The daily VOLUME cap (audit H: unbounded Realtime spend), checked
        # AFTER consent — a student who has not agreed should meet the consent
        # panel, not a quota sentence — and BEFORE any write, so a refused
        # attempt leaves no row. One COUNT on the exact composite index
        # ix_interview_session_student_started; a rolling 24 h window rather
        # than a calendar day, so midnight is not a reset button. EVERY row
        # counts — abandoned and failed included — because each one billed an
        # upstream handshake, and a cap that only counts clean finishes is a
        # cap a crash loop never hits.
        ran_today = db.scalar(
            select(func.count())
            .select_from(InterviewSession)
            .where(
                InterviewSession.student_id == student_id,
                InterviewSession.started_at >= now - timedelta(days=1),
            )
        )
        if (ran_today or 0) >= settings.interview_max_per_student_per_day:
            raise _DailyCapReached(ran_today)
        # The CROSS-WORKER concurrency check (see _UserSessionCapReached): the
        # per-process _LIMITER already refused same-worker duplicates before we
        # got here, so this catches the tab that landed on ANOTHER worker.
        # Checked after the daily cap on purpose — a student at both walls
        # should hear the daily one, because it is the one no closed tab fixes.
        live_now = db.scalar(
            select(func.count())
            .select_from(InterviewSession)
            .where(
                InterviewSession.student_id == student_id,
                InterviewSession.status == "running",
                InterviewSession.heartbeat_at
                >= now - timedelta(seconds=_LIVE_ELSEWHERE_GRACE_S),
            )
        )
        if (live_now or 0) >= settings.interview_max_sessions_per_user:
            raise _UserSessionCapReached(live_now)
        conversation_id = convo.get_or_create(db, user_id, role).id
        row = InterviewSession(
            student_id=student_id,
            conversation_id=conversation_id,
            specialization=specialization.key if specialization else None,
            conn_id=conn_id,
            consent_id=consent.id,
            started_at=now,
            heartbeat_at=now,
            # STORED rather than computed at read time, so changing the setting
            # never retroactively re-dates an interview a student was already
            # promised 180 days for.
            retention_until=now
            + timedelta(days=settings.interview_retention_days),
        )
        db.add(row)
        db.commit()
        return conversation_id, row.id, consent.id
    finally:
        db.close()


def _finalize_if_running(
    interview_session_id: str, conn_id: str, code: int, reason: str
) -> None:
    """LAYER 2: close a record whose relay never got to close it itself.

    Knows strictly less than Layer 1 — it has the close code and nothing else, so
    it cannot tell a completed interview from an abandoned one and does not
    pretend to. It only ever runs when Layer 1 did not, and a row it wrote is
    already a sign that something went wrong on the way out.
    """
    db = SessionLocal()
    try:
        now = datetime.now(timezone.utc)
        result = db.execute(
            update(InterviewSession)
            .where(
                InterviewSession.id == interview_session_id,
                InterviewSession.status == "running",
            )
            .values(
                status=_backstop_status(code),
                terminal_reason=f"{code} {reason}",
                close_code=code,
                ended_at=now,
            )
        )
        db.commit()
        if result.rowcount:
            log.warning(
                "[conn=%s] Interview record %s was closed by the router backstop; "
                "the relay's own finalizer did not run",
                conn_id,
                interview_session_id,
            )
    finally:
        db.close()


def _backstop_status(code: int) -> str:
    """Terminal status from a close code ALONE — Layer 2's whole vocabulary.

    Deliberately not shared with the relay's mapping: that one also knows whether
    the scorecard settled, which is what separates `completed` from `abandoned`,
    and this one cannot. Rather than guess `completed` from a 1000 (which also
    covers a student pressing End at minute three), it takes the conservative
    reading. A record that under-claims is arguable; one that claims an interview
    completed when nobody heard a verdict is not.
    """
    if code in (_CLOSE_OK, _CLOSE_GOING_AWAY, _CLOSE_IDLE, _CLOSE_SESSION_CAP):
        return _TERMINAL_ABANDONED
    return _TERMINAL_FAILED


def shutdown_interviews() -> None:
    """Ask every live interview to close itself. Called from app/main.py lifespan."""
    ask_all_sessions_to_stop(_LIVE_SESSIONS)
