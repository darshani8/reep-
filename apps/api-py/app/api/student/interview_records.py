"""Interview records — the READ side, plus the consent grant (Interview Engine
v3 §7).

Two routers, one module:

  student_router  /api/interview/sessions[...]   the student's OWN interviews
                  /api/interview/consent          the caller's OWN grant
  staff_router    /api/mentor/students/{student_id}/interviews[...]

They are declared here with their FULL paths and both are included from
app/main.py with **no extra prefix**::

    app.include_router(interview_records.student_router)
    app.include_router(interview_records.staff_router)

That is the same shape app/api/student/interview_session.py uses (`prefix="/api/interview"`)
and NOT the shape the domain routers use (`prefix="/mentor"` + `include_router(...,
prefix="/api")`). Mounting `staff_router` with `prefix="/api"` would silently
serve it at `/api/api/mentor/...`: every request 404s, nothing raises, and the
only symptom is a mentor screen that is permanently empty.

WHY A SECOND MODULE AND NOT THREE LINES IN mentor.py. `app/api/mentor/mentees.py`
was being edited by another track while this landed, and a staff endpoint added
there would have collided with it. Declaring a second `/api/mentor` router costs
nothing — FastAPI merges routers by path, not by module — and it means the file
that owns AGENTS.md rule 2 is not touched by this feature at all.

RULE 2 IS THE POINT OF THIS MODULE, AND IT IS NOT RE-IMPLEMENTED HERE.
`_assert_can_access_student` is imported from `app/api/mentor/mentees.py` — the one
implementation of "a MENTOR only for a student in their own group" — and called
as the FIRST LINE of every staff endpoint. app/api/mentor/leave.py already
establishes both the precedent and the reasoning: a second copy here would be
the copy that stops tracking the first. A MENTOR with NO `Mentor` group lands in
that function's own 404 branch and sees NOBODY; that is the behaviour, and
nothing here adds to it, softens it, or works around it.

The gate takes the **path's** `student_id`. It does not, and cannot, say
anything about a session id, so every by-id staff endpoint does a SECOND check:
the row's own `student_id` must equal the path's. Gating on the path and then
loading a row by an id from somewhere else is a horizontal-privilege bug wearing
a correct-looking first line (§7.3).

The student endpoints take NO `student_id` — the subject comes from the session
cookie, the same way `POST /api/agent/ask` and `POST /api/voice/token` take
theirs. Adding one "for symmetry" would turn every student endpoint into an IDOR
the moment someone forgets a `.where()`.

404, NEVER 403, for a record that belongs to somebody else. `conversations.
assert_owner` already sets that rule: a 403 confirms that the id exists, which is
exactly what an enumeration wants to learn.

RULE 1 is not in play here. Nothing in this module talks to a model; it reads
rows that the relay already wrote.
"""

import hashlib
import hmac
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.platform.identity import get_current_session
from app.platform.document_store import content_disposition
from app.interview.audio_store import (
    TRACK_MIXED,
    TRACKS,
    AudioStoreError,
    download_name,
    read_track,
)
from app.models.interview import (
    InterviewConsent,
    InterviewEvaluation,
    InterviewSession,
    InterviewTurn,
)
from app.models.user import Role

# _assert_can_access_student is private to mentor.py on purpose, and importing it
# anyway is the lesser evil — the same call app/api/mentor/leave.py makes, for the
# same reason. require_director rides along because §7.2 needs BOTH gates on the
# report: require_director says WHICH ROLE may see `raw_response`,
# _assert_can_access_student says WHICH STUDENT may be read, and neither answers
# the other's question.
from app.api.mentor.mentees import _assert_can_access_student, require_director

log = logging.getLogger(__name__)

student_router = APIRouter(prefix="/api/interview", tags=["interview-records"])
staff_router = APIRouter(prefix="/api/mentor", tags=["interview-records"])

# Newest N interviews, and no pagination. A student sits perhaps a dozen mock
# interviews in a placement season and the 180-day retention window reaps the
# rest, so this is a runaway guard rather than a page size: without it one
# scripted account could make the mentor screen fetch every row it ever wrote.
# If a real cohort ever approaches it, that is the moment to add a cursor, not
# to raise the number.
_MAX_SESSIONS_LISTED = 200

# What a `user-agent` header is worth keeping on a consent row: enough to say
# "Chrome on Android", never a header of unbounded length written by the client.
_MAX_USER_AGENT_CHARS = 300


# ---------------------------------------------------------------------------
# Payloads
#
# §5.4 DECIDED THAT STAFF SEE ONE FIELD MORE THAN THE STUDENT, AND THE SPLIT IS
# EXPRESSED AS TWO MODELS ON PURPOSE. The next editor will want to merge them
# into one payload with `raw_response: str | None` and fill it conditionally.
# Do not: a student would then receive `"raw_response": null`, which reads as
# "the model returned nothing" when it actually means "this is not yours to
# read". The KEY'S ABSENCE is the honest way to say the second thing, and it is
# only absent if there are two models.
#
# Everything else the student sees is everything staff see — including every
# score. That is also a decision and not an oversight (§5.4): the model already
# SPEAKS its verdict aloud at wrap-up, so hiding the number hides only the
# number; and a score the student cannot see while their mentor can is a secret
# file on a student, which is the one arrangement here that would be genuinely
# hard to defend. The honest fix is calibration copy next to the number ("a
# practice score generated by an AI from one 15-minute session; not a placement
# decision"), which the client renders — never concealment.
# ---------------------------------------------------------------------------


class InterviewSessionOut(BaseModel):
    """One interview, as a history row. Same shape for both audiences."""

    id: str
    specialization: str | None
    status: str
    terminal_reason: str | None
    final_phase: str | None
    answers_accepted: int
    close_code: int | None
    # READ THIS, never `audio_path`. The path is a server-side location and is
    # not exposed to anyone; the flag is the fact. app/models/interview.py sets
    # out why a NULL path cannot answer "was this recorded" — capture disabled,
    # consent refused, the write failed and "predates capture entirely" are four
    # different facts and a NULL flattens them into one.
    audio_recorded: bool
    started_at: datetime
    ended_at: datetime | None
    # From the evaluation row, via one LEFT JOIN, so a history list does not
    # fire a query per interview. NULL report_status means no evaluation row
    # exists at all — the interview is still running, or it predates the
    # scorecard. That is distinct from `report_status='unavailable'`, which is
    # the record that a report WAS attempted and did not arrive.
    report_status: str | None
    overall_score: int | None


class InterviewTurnOut(BaseModel):
    """One utterance. `content` may legitimately be an empty string — that is a
    transcription that failed or timed out, and `transcription_status` says
    which (L4). A client that renders blank turns as "nothing was said" is
    wrong; they are "we could not hear it"."""

    seq: int
    speaker: str
    phase: str
    content: str
    transcription_status: str
    answer_quality: str | None
    counted_as_answer: bool
    is_partial: bool
    created_at: datetime


class InterviewReportOut(BaseModel):
    """The scorecard as the student sees it. No `raw_response` — see above."""

    report_status: str
    # NULLABLE EVEN WHEN report_status == 'ok', and the client must be able to
    # render a blank. A missing score and a zero mean opposite things to the
    # person reading this screen, and neither the model nor this endpoint may
    # invent one to fill the gap.
    overall_score: int | None
    communication_score: int | None
    domain_score: int | None
    structure_score: int | None
    strengths: list | None
    improvements: list | None
    drill: str | None
    summary: str | None
    model: str | None
    generated_at: datetime


class StaffInterviewReportOut(InterviewReportOut):
    """DIRECTOR/ADMIN only, and the one field is the whole reason this subclass
    exists.

    `raw_response` is the model's exact output, kept for debugging a bad parse.
    It routinely contains the model's private reasoning ABOUT the student, which
    is why it does not travel to the student and why a MENTOR does not get it
    either — `require_director` decides, on top of the group gate that already
    decided which student may be read at all.
    """

    raw_response: str | None


class ConsentOut(BaseModel):
    """A live consent grant. Deliberately omits `user_agent` and
    `source_ip_hash`: those are audit fields for a disputed grant, not something
    the granting browser needs handed back to it."""

    id: str
    version: str
    scope_live_ai: bool
    scope_store_transcript: bool
    scope_store_audio: bool
    granted_at: datetime


class ConsentStateOut(BaseModel):
    """The grant AND the version the server is currently asking for.

    The version is not decoration: `POST /api/interview/consent` refuses a
    version it does not know, so the client has to learn the current string from
    somewhere, and this is the endpoint it already calls to decide whether to
    show the panel. Without it a cached SPA could only guess, and a guess that
    is wrong looks to the student like a consent button that does nothing.
    """

    version: str
    consent: ConsentOut | None


class ConsentIn(BaseModel):
    # The version string the CLIENT DISPLAYED, echoed back. That is the one job
    # a version string has here: a stale cached SPA must not be able to grant
    # against copy the student never saw, so the server 422s anything but the
    # current string rather than accepting it and back-dating the terms.
    version: str = Field(min_length=1, max_length=64)
    # All three REQUIRED, with no defaults, because a grant states each scope
    # explicitly or it is not a grant. Defaulting a missing scope to False would
    # be worse than 422-ing: it silently records a refusal the student never
    # made, on a row that is the evidence of what they agreed to.
    scope_live_ai: bool
    scope_store_transcript: bool
    scope_store_audio: bool


# ---------------------------------------------------------------------------
# Shared loaders — used by BOTH audiences, so the 404 semantics cannot drift
# ---------------------------------------------------------------------------


def _own_student_id(session: dict) -> str | None:
    """The caller's own `Student` id. 403 for anyone who is not a STUDENT.

    None means a STUDENT session carrying no `studentId` claim — a user row with
    no `Student` row behind it. Such a caller cannot own an interview at all
    (`interview_sessions.student_id` is NOT NULL), so the callers below read
    None as "no interviews", never as "no filter". A missing subject that turns
    into an unfiltered query is precisely the IDOR this module's header warns
    about.
    """
    if session.get("role") != Role.STUDENT.value:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Interview records of your own are a student feature.",
        )
    return session.get("studentId")


def _sessions_for_student(db: Session, student_id: str) -> list[InterviewSessionOut]:
    """Newest first, with the scorecard summary joined in.

    Soft-deleted rows are excluded for every audience. `retention.purge_expired`
    stamps `deleted_at` AND redacts the turn text and `raw_response` in the same
    step, so a soft-deleted interview is a hollowed-out record on its way to a
    hard delete — showing it would put an empty transcript in front of a mentor
    with nothing to say why. `conversations.assert_owner` treats a soft-deleted
    conversation the same way.
    """
    rows = db.execute(
        select(
            InterviewSession,
            InterviewEvaluation.report_status,
            InterviewEvaluation.overall_score,
        )
        .outerjoin(
            InterviewEvaluation,
            InterviewEvaluation.interview_session_id == InterviewSession.id,
        )
        .where(
            InterviewSession.student_id == student_id,
            InterviewSession.deleted_at.is_(None),
        )
        .order_by(InterviewSession.started_at.desc(), InterviewSession.id)
        .limit(_MAX_SESSIONS_LISTED)
    ).all()
    return [
        _session_out(row, report_status=report_status, overall_score=overall_score)
        for row, report_status, overall_score in rows
    ]


def _session_of_student_or_404(
    db: Session, session_id: str, student_id: str
) -> InterviewSession:
    """The interview `session_id`, ONLY if it belongs to `student_id`.

    This is §7.3's second check and it is not optional on the staff side:
    `_assert_can_access_student` was handed the PATH's student id and can say
    nothing whatsoever about a session id. Loading by session id alone, after a
    gate that passed on a different argument, is how a mentor reads another
    group's interview through a correct-looking first line.

    404 for missing, another student's, and soft-deleted alike — the caller
    cannot tell which, so no id is confirmed to exist.
    """
    row = db.get(InterviewSession, session_id)
    if row is None or row.student_id != student_id or row.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found."
        )
    return row


def _session_out(
    row: InterviewSession,
    *,
    report_status: str | None = None,
    overall_score: int | None = None,
) -> InterviewSessionOut:
    return InterviewSessionOut(
        id=row.id,
        specialization=row.specialization,
        status=row.status,
        terminal_reason=row.terminal_reason,
        final_phase=row.final_phase,
        answers_accepted=row.answers_accepted,
        close_code=row.close_code,
        audio_recorded=row.audio_recorded,
        started_at=row.started_at,
        ended_at=row.ended_at,
        report_status=report_status,
        overall_score=overall_score,
    )


def _session_detail(db: Session, row: InterviewSession) -> InterviewSessionOut:
    """One session with its scorecard summary — the by-id twin of the LEFT JOIN
    in `_sessions_for_student`, so the two endpoints can never disagree about
    whether an interview has a report."""
    evaluation = db.scalar(
        select(InterviewEvaluation).where(
            InterviewEvaluation.interview_session_id == row.id
        )
    )
    return _session_out(
        row,
        report_status=None if evaluation is None else evaluation.report_status,
        overall_score=None if evaluation is None else evaluation.overall_score,
    )


def _transcript(db: Session, interview_session_id: str) -> list[InterviewTurnOut]:
    """The turns, in interview order.

    ORDER BY (seq, created_at, id) rather than seq alone, and the tie-breakers
    are load-bearing: `(interview_session_id, seq)` is deliberately NOT unique
    (§6.3 — a fire-and-forget writer must never raise on a cosmetic duplicate),
    so two rows can share a seq, and Postgres is free to return an unordered tie
    in either order. Without a TOTAL order the same transcript would come back
    shuffled between two requests, which reads as the record changing itself.
    """
    rows = db.scalars(
        select(InterviewTurn)
        .where(InterviewTurn.interview_session_id == interview_session_id)
        .order_by(InterviewTurn.seq, InterviewTurn.created_at, InterviewTurn.id)
    ).all()
    return [
        InterviewTurnOut(
            seq=t.seq,
            speaker=t.speaker,
            phase=t.phase,
            content=t.content,
            transcription_status=t.transcription_status,
            answer_quality=t.answer_quality,
            counted_as_answer=t.counted_as_answer,
            is_partial=t.is_partial,
            created_at=t.created_at,
        )
        for t in rows
    ]


def _evaluation_or_404(db: Session, interview_session_id: str) -> InterviewEvaluation:
    """The scorecard row, or 404.

    A row is written on EVERY terminal path, including one that says
    `report_status='unavailable'` — so a missing row does not mean "the report
    failed", it means the interview has not finished yet (or predates the
    scorecard entirely). Those are different sentences for the student and this
    404 is what lets the client say the right one.
    """
    evaluation = db.scalar(
        select(InterviewEvaluation).where(
            InterviewEvaluation.interview_session_id == interview_session_id
        )
    )
    if evaluation is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No report for this interview yet.",
        )
    return evaluation


def _report_out(evaluation: InterviewEvaluation) -> InterviewReportOut:
    return InterviewReportOut(
        report_status=evaluation.report_status,
        overall_score=evaluation.overall_score,
        communication_score=evaluation.communication_score,
        domain_score=evaluation.domain_score,
        structure_score=evaluation.structure_score,
        strengths=evaluation.strengths,
        improvements=evaluation.improvements,
        drill=evaluation.drill,
        summary=evaluation.summary,
        model=evaluation.model,
        generated_at=evaluation.generated_at,
    )


def _may_see_raw_response(session: dict) -> bool:
    """DIRECTOR/ADMIN, decided by mentor.py's own `require_director`.

    It raises 403 and we need a boolean, so it is called and caught rather than
    re-expressed as `role in {...}` here. That looks roundabout and is
    deliberate: a second copy of the role list is a second thing to remember
    when a role is added, and this endpoint must not be the one that keeps
    handing a new role the model's private reasoning about a student.
    """
    try:
        require_director(session)
    except HTTPException:
        return False
    return True


# ---------------------------------------------------------------------------
# Student endpoints — own record only, subject taken from the session cookie
# ---------------------------------------------------------------------------


@student_router.get("/sessions", response_model=list[InterviewSessionOut])
def my_interviews(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[InterviewSessionOut]:
    """The caller's own interviews, newest first."""
    student_id = _own_student_id(session)
    if student_id is None:
        return []
    return _sessions_for_student(db, student_id)


@student_router.get("/sessions/{session_id}", response_model=InterviewSessionOut)
def my_interview(
    session_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> InterviewSessionOut:
    student_id = _own_student_id(session)
    if student_id is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found."
        )
    row = _session_of_student_or_404(db, session_id, student_id)
    return _session_detail(db, row)


@student_router.get(
    "/sessions/{session_id}/transcript", response_model=list[InterviewTurnOut]
)
def my_interview_transcript(
    session_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[InterviewTurnOut]:
    student_id = _own_student_id(session)
    if student_id is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found."
        )
    row = _session_of_student_or_404(db, session_id, student_id)
    return _transcript(db, row.id)


@student_router.get("/sessions/{session_id}/report", response_model=InterviewReportOut)
def my_interview_report(
    session_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> InterviewReportOut:
    """The student's own scorecard — every score, and no `raw_response`.

    `InterviewReportOut` is the model without that field, so it cannot leak by
    someone later populating it here; see the note above the payload classes for
    why this is two models rather than one with a conditional field.
    """
    student_id = _own_student_id(session)
    if student_id is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found."
        )
    row = _session_of_student_or_404(db, session_id, student_id)
    return _report_out(_evaluation_or_404(db, row.id))


# ---------------------------------------------------------------------------
# Consent — a row, because consent that lives in localStorage is a cache
# ---------------------------------------------------------------------------


def _live_consent(db: Session, user_id: str, version: str) -> InterviewConsent | None:
    return db.scalar(
        select(InterviewConsent).where(
            InterviewConsent.user_id == user_id,
            InterviewConsent.version == version,
            InterviewConsent.revoked_at.is_(None),
        )
    )


def _consent_out(row: InterviewConsent) -> ConsentOut:
    return ConsentOut(
        id=row.id,
        version=row.version,
        scope_live_ai=row.scope_live_ai,
        scope_store_transcript=row.scope_store_transcript,
        scope_store_audio=row.scope_store_audio,
        granted_at=row.granted_at,
    )


def _user_agent(request: Request) -> str | None:
    """The caller's User-Agent, truncated. Client-supplied text of unbounded
    length goes on a row only after someone decides how much of it is worth
    keeping; "Chrome on Android" is the whole question this field answers."""
    raw = (request.headers.get("user-agent") or "").strip()
    return raw[:_MAX_USER_AGENT_CHARS] or None


def _ip_hash(request: Request) -> str | None:
    """A salted digest of the caller's address — NEVER the address.

    Enough to show that two disputed grants came from the same machine; not
    enough to become a location log on a student, which is what storing the
    address itself would be. Salted with AUTH_SECRET because an unsalted SHA-256
    of an IPv4 address is a lookup table, not a hash — the college sits behind a
    handful of /24s and every one of them could be enumerated in seconds.

    Behind a proxy this is the proxy's address, and that is left alone
    deliberately: `X-Forwarded-For` is client-supplied unless every hop is
    trusted, and a forgeable audit field is worse than a coarse one.
    """
    client = request.client
    if client is None or not client.host:
        return None
    digest = hmac.new(
        settings.auth_secret.encode("utf-8"),
        client.host.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    # 128 bits is far past collision-proof for "same machine or not", and a
    # shorter column is a smaller thing to leak in a database dump.
    return digest[:32]


@student_router.get("/consent", response_model=ConsentStateOut)
def my_consent(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> ConsentStateOut:
    """The caller's own live grant for the CURRENT terms, or null.

    Scoped to the current version on purpose: consent is not retroactive, so a
    live grant carrying last term's string is not consent to these terms and
    must not be reported as one. The student is shown the new copy and grants
    again; the old row stays live and untouched, which is what keeps
    `interview_sessions.consent_id` meaningful for the interviews conducted
    under it.

    No role check — a signed-in user may always read their own consent state,
    and a non-student simply has none.
    """
    row = _live_consent(db, session["userId"], settings.interview_consent_version)
    return ConsentStateOut(
        version=settings.interview_consent_version,
        consent=None if row is None else _consent_out(row),
    )


@student_router.post(
    "/consent", response_model=ConsentOut, status_code=status.HTTP_201_CREATED
)
def grant_consent(
    body: ConsentIn,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> ConsentOut:
    """Record a grant. A GRANT IS A ROW AND A ROW IS NEVER EDITED.

    Changing your mind revokes the live grant and inserts a new one, rather than
    updating the old row's booleans in place. That is the whole reason this is a
    table: `interview_sessions.consent_id` pins the exact grant that was live
    when an interview opened, so "was this student consented, to what, at the
    time of interview X" is answerable years later. Mutating a grant would
    rewrite the answer for every interview already pointing at it.

    422 for a version this build does not know (§7.1). That is the one job a
    version string has: a stale cached SPA must not be able to grant against
    copy the student never saw.
    """
    if session.get("role") != Role.STUDENT.value:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only a student can consent to a mock interview.",
        )
    current = settings.interview_consent_version
    if body.version != current:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Consent terms have changed (this server is asking for "
                f"'{current}'). Reload the page and read them again."
            ),
        )

    user_id = session["userId"]
    now = datetime.now(timezone.utc)
    # Supersede, then insert, in ONE transaction — the partial unique index
    # `uq_interview_consent_active` (user_id, version) WHERE revoked_at IS NULL
    # allows exactly one live grant, so the revoke has to be part of the same
    # commit as the insert or the two are a race against each other.
    db.execute(
        update(InterviewConsent)
        .where(
            InterviewConsent.user_id == user_id,
            InterviewConsent.version == current,
            InterviewConsent.revoked_at.is_(None),
        )
        .values(revoked_at=now)
    )
    row = InterviewConsent(
        user_id=user_id,
        version=current,
        scope_live_ai=body.scope_live_ai,
        scope_store_transcript=body.scope_store_transcript,
        scope_store_audio=body.scope_store_audio,
        granted_at=now,
        user_agent=_user_agent(request),
        source_ip_hash=_ip_hash(request),
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # A double-clicked button: another request committed its grant between
        # our UPDATE and our INSERT. The winner's row says the same thing ours
        # would have, so return it rather than 500-ing — the same shape
        # `conversations.ensure_conversation` uses on the same class of index.
        db.rollback()
        winner = _live_consent(db, user_id, current)
        if winner is None:  # pragma: no cover — index violated for another reason
            raise
        return _consent_out(winner)
    db.refresh(row)
    return _consent_out(row)


@student_router.delete("/consent", response_model=ConsentStateOut)
def revoke_consent(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> ConsentStateOut:
    """Withdraw consent: stamp `revoked_at` on EVERY live grant this user holds,
    of any version.

    Any version, not just the current one, because "I withdraw" is about the
    person and not about a string. Leaving an old version's grant live would
    mean a later reader keyed on that version still finds consent, which is the
    kind of half-revocation that makes a consent record worthless.

    The row is never deleted — the historical fact that consent WAS given is
    what the interviews conducted under it depend on.

    STUDENT-gated, matching `POST` above and §7.1's table. The asymmetry with
    `GET /consent` (any signed-in user) is worth naming: if a user's role ever
    changed after granting, they could read their grant and not withdraw it.
    Roles here come from the roster seed and do not change at runtime, so this
    has no live failure mode; the fix, if it ever grows one, is to delete this
    check and keep the query, which already scopes to the caller's own rows.

    WHAT THIS DOES NOT DO YET: it does not end a live interview. §7.1 pairs
    revocation with `stop_sessions_for_user(user_id)` closing the socket 4014,
    and neither that function nor the per-user session registry it needs exists
    — `_RelaySession` does not carry a user id today (app/interview/realtime_relay.py),
    and consent enforcement is deliberately the LAST step of the rollout (§8.3)
    so that no student is locked out before the client is posting grants. Until
    then, revoking mid-interview takes effect on the next interview. Wiring it
    up is a change to api/student/interview_session.py and interview/realtime_relay.py, not to this
    module.
    """
    if session.get("role") != Role.STUDENT.value:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only a student can withdraw consent to a mock interview.",
        )
    db.execute(
        update(InterviewConsent)
        .where(
            InterviewConsent.user_id == session["userId"],
            InterviewConsent.revoked_at.is_(None),
        )
        .values(revoked_at=datetime.now(timezone.utc))
    )
    db.commit()
    # The new state, so the client replaces what it holds instead of inferring
    # it from a 204 and getting the version string wrong.
    return ConsentStateOut(version=settings.interview_consent_version, consent=None)


# ---------------------------------------------------------------------------
# Staff endpoints — every one opens with _assert_can_access_student
#
# The gate is the FIRST LINE of each handler, not a router-level dependency,
# because it needs the path's `student_id` and because a reader must be able to
# see it in the function they are reading. A dependency declared elsewhere is a
# dependency someone deletes from one route while refactoring.
# ---------------------------------------------------------------------------


@staff_router.get(
    "/students/{student_id}/interviews", response_model=list[InterviewSessionOut]
)
def student_interviews(
    student_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[InterviewSessionOut]:
    """This student's interviews — MENTOR only within their own group.

    A MENTOR with no `Mentor` group gets 404 from the gate and sees NOBODY. That
    is not a special case here; it is `_assert_can_access_student`'s own branch,
    and reading "no mentor group" as "the whole programme" is the exact bug
    AGENTS.md rule 2 exists to prevent.
    """
    _assert_can_access_student(session, student_id, db)
    return _sessions_for_student(db, student_id)


@staff_router.get(
    "/students/{student_id}/interviews/{session_id}",
    response_model=InterviewSessionOut,
)
def student_interview(
    student_id: str,
    session_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> InterviewSessionOut:
    _assert_can_access_student(session, student_id, db)
    # SECOND check: the row's own subject must be the student the gate passed
    # on. Never trust a session id in a path to imply whose interview it is.
    row = _session_of_student_or_404(db, session_id, student_id)
    return _session_detail(db, row)


@staff_router.get(
    "/students/{student_id}/interviews/{session_id}/transcript",
    response_model=list[InterviewTurnOut],
)
def student_interview_transcript(
    student_id: str,
    session_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[InterviewTurnOut]:
    _assert_can_access_student(session, student_id, db)
    row = _session_of_student_or_404(db, session_id, student_id)
    return _transcript(db, row.id)


@staff_router.get(
    "/students/{student_id}/interviews/{session_id}/report", response_model=None
)
def student_interview_report(
    student_id: str,
    session_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> InterviewReportOut | StaffInterviewReportOut:
    """The scorecard, with `raw_response` for DIRECTOR/ADMIN only.

    BOTH gates, not either (§7.2): `_assert_can_access_student` decides which
    student may be read, `require_director` (through `_may_see_raw_response`)
    decides who may see the model's private reasoning about them. Neither
    answers the other's question — a DIRECTOR still cannot read a student who
    does not exist, and a MENTOR in the right group still does not get
    `raw_response`.

    `response_model=None` is deliberate. Declaring the staff model would make
    FastAPI serialise a MENTOR's payload through it and emit
    `"raw_response": null`, which says "the model returned nothing" when the
    truth is "not for you". Returning the narrower model omits the key entirely,
    which is the honest sentence.
    """
    _assert_can_access_student(session, student_id, db)
    row = _session_of_student_or_404(db, session_id, student_id)
    evaluation = _evaluation_or_404(db, row.id)
    report = _report_out(evaluation)
    if _may_see_raw_response(session):
        return StaffInterviewReportOut(
            **report.model_dump(), raw_response=evaluation.raw_response
        )
    return report


# ---------------------------------------------------------------------------
_DEVELOPERS = {"ADMIN"}


def _require_developer(session: dict) -> dict:
    """ADMIN only — deliberately NARROWER than require_director.

    Every other staff read in this module is placement business: a DIRECTOR runs
    the programme and needs a student's scores, transcript and history to do it.
    A voice recording is not placement business. It exists so whoever operates
    this system can hear what the ENGINE did — a mis-transcribed turn, the
    interviewer talking over an answer — and that is an operator's artefact that
    happens to contain a named student speaking.

    So the role that reads it is the operator's role, not the programme's. A
    DIRECTOR gets 403 here and 200 everywhere else in this file, which is the
    intended asymmetry and not an oversight: widening this back to
    require_director would hand the most sensitive bytes REEP stores to every
    placement account, for no question they cannot already answer from the
    transcript.

    There is no DEVELOPER role in `Role` and this does not invent one. ADMIN is
    the account that operates the deployment; if a DEVELOPER role is ever added,
    add it to _DEVELOPERS here and nowhere else.
    """
    if session.get("role") not in _DEVELOPERS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Recordings are available to the system administrator only.",
        )
    return session


# The audio download — ADMIN only, and the narrowest thing in this file
#
# THE STUDENT DOES NOT GET PLAYBACK OF THEIR OWN RECORDING, and that is a
# different judgement from §5.4's on scores, not a contradiction of it. §5.4
# refused to hide the SCORE because the model already speaks its verdict aloud,
# so concealing the number would only have hidden it from the person it is
# about, leaving "a secret file on a student" — the one arrangement here that
# would be hard to defend. Audio inverts every term of that argument:
#
#   * It tells the student nothing they do not have. They were there; the
#     transcript is already theirs, turn by turn, and it is the artefact that
#     helps them practise. A waveform of their own voice adds no information
#     about how they did.
#   * It is not a judgement about them, so there is nothing to be "kept from"
#     them. The recording exists so an authorised developer can hear what the
#     ENGINE did — why a turn was mis-transcribed, why the interviewer talked
#     over an answer — which is a debugging artefact that happens to contain a
#     student's voice.
#   * A student endpoint is the widest possible surface for the most sensitive
#     bytes REEP holds. Any live student session — a shared lab machine, a
#     borrowed laptop, a tab left signed in — would stream a named person's
#     voice on request. Every recording is reachable through exactly one role
#     here, and that is worth the asymmetry.
#
# What the student DOES get is honesty: `audio_recorded` is on their own session
# payload above, the consent copy told them a recording would be kept, and
# `DELETE /consent` stops the next one. Deletion of an existing recording goes
# through the placement cell, which is the same sentence §8.2 already makes them
# read about the transcript.
#
# The gate order below is `student_interview_report`'s, with the role check
# promoted from "which fields" to "whether at all" -- and tightened from
# require_director to _require_developer, because "whether at all" is a
# different question from "how much".
# ---------------------------------------------------------------------------


@staff_router.get("/students/{student_id}/interviews/{session_id}/audio")
def student_interview_audio(
    student_id: str,
    session_id: str,
    track: str = TRACK_MIXED,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> FileResponse:
    """Stream one track of a stored interview recording. Defaults to the MIX.

    BOTH gates and then some, in this order and for three different questions:
    `_require_developer` says WHICH ROLE may hear a recording at all — ADMIN,
    narrower than every other read in this module, see its docstring —
    `_assert_can_access_student` says WHICH STUDENT this caller may read — an
    ADMIN still cannot reach a student who does not exist, and a DIRECTOR or a
    MENTOR in the right group still gets 403 — and `_session_of_student_or_404` says the
    row's own subject really is the student in the path (§7.3: gating on the
    path and then loading a row by an id from somewhere else is a
    horizontal-privilege bug wearing a correct-looking first line).

    THREE FILES, selected by `?track=`, and the DEFAULT IS `mixed` — one file
    with both voices on one timeline, the way a phone recording sounds, because
    that is what somebody reviewing an interview actually plays. It is DERIVED:
    the recorder sums the two per-speaker tracks at close, having padded each to
    the session's wall clock so they line up (app/interview/audio_store.py's header
    sets out what that alignment can and cannot promise).

    `?track=student` AND `?track=interviewer` KEEP WORKING, unchanged, and they
    are still the faithful record — the student's is what their microphone
    captured, the interviewer's is exactly what was forwarded to the browser.
    Reach for them when the question is "what did the model actually send", and
    do NOT delete them as duplicates of the mix: the mix is regenerable from
    them and they are not recoverable from it.

    An earlier revision of this docstring said the two must never be mixed. That
    was correct about the files it described — before the timeline existed each
    track was a speech-only concatenation, so laying them side by side put
    answers under the wrong questions. The mix is honest now because the padding
    made it so, not because the objection was waved off.

    404 — never 403 and never 204 — for a session with no recording, so an
    admin cannot tell "this interview was not recorded" from "that is not a
    real id"; the same no-existence-leak rule the rest of this module follows.
    """
    _require_developer(session)
    _assert_can_access_student(session, student_id, db)
    row = _session_of_student_or_404(db, session_id, student_id)

    if track not in TRACKS:
        # 422 rather than a silent fallback to the default track: a client that
        # asked for the interviewer and got the mix would have a reviewer
        # listening to the wrong voice with nothing on screen saying so.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unknown audio track. Choose one of: {', '.join(TRACKS)}.",
        )

    # THE FLAG, never `audio_path is not None` — app/models/interview.py sets out
    # the four different facts a NULL path collapses into one (capture disabled,
    # consent refused, the write failed, the interview predates capture).
    if not row.audio_recorded:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No recording for this interview."
        )

    # The stored name, falling back to the session id — which is the same string
    # in every recording this store has written, and differs only when the
    # finalizing UPDATE never landed. app/interview/audio_store.py names files after
    # the session for exactly that case.
    stem = row.audio_path or row.id
    try:
        path = read_track(stem, track)
    except (FileNotFoundError, AudioStoreError):
        # The row says a recording exists and the disk disagrees: the reaper ran
        # between the two, the volume is not mounted, or somebody tidied up.
        # WARNING rather than 500 — nothing is broken for the caller and there is
        # nothing they can do — but it is logged, because a row claiming audio
        # that is not there is how a deletion request quietly fails to be honoured.
        log.warning(
            "Interview session %s claims stored audio (path=%r, track=%s) that is "
            "not on disk.",
            row.id,
            row.audio_path,
            track,
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="The stored recording is missing.",
        )

    # FileResponse, not Response(content=...): a 15-minute track is ~43 MB, where
    # api/student/self_service.py's upload download reads whole files because those are
    # capped at 10 MB. This streams from disk and answers Range requests, which
    # is what lets a reviewer seek in an <audio> element instead of waiting for
    # the whole file before hearing the first second.
    return FileResponse(
        path,
        media_type="audio/wav",
        headers={
            # RFC 6266 through document_store's helper — the header formatter ONLY.
            # Nothing about the upload store is reused here (§8.4's third
            # objection: admitting audio to that store would loosen the magic-byte
            # rule that makes it trustworthy), and this module writes nothing into
            # it. `inline` so the recording plays in the tab rather than landing
            # in a downloads folder that syncs and backs up a student's voice by
            # default; the filename carries the interview id and no student name.
            "Content-Disposition": content_disposition(
                download_name(stem, track), inline=True
            )
        },
    )
