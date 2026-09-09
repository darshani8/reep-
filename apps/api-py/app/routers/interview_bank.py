"""The admin's interview question bank: /api/director/interview-questions.

    GET    /tracks             the four live tracks, their phases, and how many
                               questions each holds
    GET    /?track=hr          one track's questions, enabled and not, in order
    POST   /                   add one
    POST   /bulk               add many from pasted lines (or a file's text)
    PATCH  /{id}               edit text / phase / enabled
    DELETE /{id}               remove
    POST   /reorder            the order the interviewer works them in

GATED BY A CAPABILITY, NOT A ROLE - `admin.interview_questions`. DIRECTOR/ADMIN
hold it through the baseline; a MENTOR holds it only when granted, which is the
point: the owner asked for "analytics to multiple faculty", and question
authoring is the same shape. PROGRAMME scope, because a question is asked of
every student on the track and no mentor group could narrow it.

WHAT THIS DOES NOT TOUCH. The interviewer stays free-style. app/interview_bank.py
renders these rows into Specialization.question_bank, and build_instructions
already frames that as "a guide to coverage, not a script: rephrase each
naturally, follow up on what the student actually says". The phase machine,
the persona and the word gate are unchanged; an admin decides WHAT is covered,
the model decides HOW it is asked. `position` is load-bearing - the prompt says
"in this order" - which is why reorder is a first-class endpoint and not a PATCH
on a number.

Every write goes through record_change: who added, edited, disabled or removed
a question a student was asked is an audit question, and a bank edited in
silence is one nobody can explain to the student who was asked it.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..architecture_events import record_change
from ..db import get_db
from ..governance import require_capability
from ..identity import get_current_session
from ..interview_bank import BANK_PHASES, MAX_QUESTION_CHARS, TRACK_KEYS, parse_bulk
from ..interview_matrix import SPECIALIZATIONS
from ..models.interview_bank import InterviewBankQuestion

router = APIRouter(prefix="/director/interview-questions", tags=["interview-bank"])

CAPABILITY = "admin.interview_questions"


# ------------------------------------------------------------- schemas --


class BankQuestionOut(BaseModel):
    id: str
    track: str
    phase: str
    text: str
    position: int
    enabled: bool
    created_at: datetime


class BankQuestionIn(BaseModel):
    track: str
    phase: str
    text: str = Field(min_length=8, max_length=MAX_QUESTION_CHARS)


class BankQuestionPatch(BaseModel):
    phase: str | None = None
    text: str | None = Field(default=None, min_length=8, max_length=MAX_QUESTION_CHARS)
    enabled: bool | None = None


class BulkIn(BaseModel):
    track: str
    #: One question per line. See interview_bank.parse_bulk for the accepted
    #: shapes. 200k characters is ~2 000 generous questions; a file larger than
    #: that is not a question list.
    lines: str = Field(min_length=1, max_length=200_000)


class BulkOut(BaseModel):
    added: list[BankQuestionOut]
    skipped: list[str]


class ReorderIn(BaseModel):
    track: str
    ids: list[str] = Field(min_length=1, max_length=2000)


class TrackOut(BaseModel):
    key: str
    label: str
    phases: list[str]
    count: int
    enabled_count: int


# ------------------------------------------------------------- helpers --


def _out(q: InterviewBankQuestion) -> BankQuestionOut:
    return BankQuestionOut(
        id=q.id, track=q.track, phase=q.phase, text=q.text,
        position=q.position, enabled=q.enabled, created_at=q.created_at,
    )


def _check_track(track: str) -> str:
    key = (track or "").strip().lower()
    if key not in TRACK_KEYS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"track must be one of {', '.join(TRACK_KEYS)}.",
        )
    return key


def _check_phase(phase: str) -> str:
    key = (phase or "").strip().lower()
    if key not in BANK_PHASES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"phase must be one of {', '.join(BANK_PHASES)}.",
        )
    return key


def _next_position(db: Session, track: str) -> int:
    current = db.scalar(
        select(func.max(InterviewBankQuestion.position)).where(InterviewBankQuestion.track == track)
    )
    return int(current or 0) + 1


def _question_or_404(db: Session, question_id: str) -> InterviewBankQuestion:
    q = db.get(InterviewBankQuestion, question_id)
    if q is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Question not found.")
    return q


def _audit(db, session, request, q: InterviewBankQuestion, action: str, before: dict | None, after: dict | None) -> None:
    record_change(
        db, session=session, request=request, tenant_id=None,
        entity_type="interview_question", entity_id=q.id, action=action,
        before=before, after=after,
        event_type=f"interview_bank.{action.lower()}",
        payload={"track": q.track, "phase": q.phase},
    )


def _snapshot(q: InterviewBankQuestion) -> dict:
    return {"track": q.track, "phase": q.phase, "text": q.text, "position": q.position, "enabled": q.enabled}


# ----------------------------------------------------------- endpoints --


@router.get("/tracks", response_model=list[TrackOut])
def tracks(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[TrackOut]:
    """The four live tracks, from the matrix that runs the interviews, with counts."""
    require_capability(db, session, CAPABILITY)
    counts = {
        (track, enabled): n
        for track, enabled, n in db.execute(
            select(InterviewBankQuestion.track, InterviewBankQuestion.enabled, func.count())
            .group_by(InterviewBankQuestion.track, InterviewBankQuestion.enabled)
        ).all()
    }
    return [
        TrackOut(
            key=spec.key,
            label=spec.label,
            phases=list(BANK_PHASES),
            count=counts.get((spec.key, True), 0) + counts.get((spec.key, False), 0),
            enabled_count=counts.get((spec.key, True), 0),
        )
        for spec in SPECIALIZATIONS.values()
    ]


@router.get("", response_model=list[BankQuestionOut])
def list_questions(
    track: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[BankQuestionOut]:
    """Every question on the track, enabled or not, in the order it is worked."""
    require_capability(db, session, CAPABILITY)
    key = _check_track(track)
    rows = db.scalars(
        select(InterviewBankQuestion)
        .where(InterviewBankQuestion.track == key)
        .order_by(InterviewBankQuestion.position, InterviewBankQuestion.created_at)
    ).all()
    return [_out(q) for q in rows]


@router.post("", response_model=BankQuestionOut, status_code=status.HTTP_201_CREATED)
def create_question(
    body: BankQuestionIn,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> BankQuestionOut:
    require_capability(db, session, CAPABILITY)
    track = _check_track(body.track)
    phase = _check_phase(body.phase)
    q = InterviewBankQuestion(
        track=track,
        phase=phase,
        text=body.text.strip(),
        position=_next_position(db, track),
        enabled=True,
        created_by_user_id=session.get("userId"),
    )
    db.add(q)
    db.flush()
    _audit(db, session, request, q, "CREATED", None, _snapshot(q))
    db.commit()
    db.refresh(q)
    return _out(q)


@router.post("/bulk", response_model=BulkOut, status_code=status.HTTP_201_CREATED)
def bulk_create(
    body: BulkIn,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> BulkOut:
    """Many at once, from pasted lines or a file's text. Lines that cannot be
    read are reported by number and NOT stored: an author fixes the three that
    failed rather than re-checking the fifty that did not. Appended in order
    after whatever the track already holds."""
    require_capability(db, session, CAPABILITY)
    track = _check_track(body.track)
    rows, skipped = parse_bulk(body.lines)
    position = _next_position(db, track)
    added: list[InterviewBankQuestion] = []
    for phase, text in rows:
        q = InterviewBankQuestion(
            track=track, phase=phase, text=text, position=position, enabled=True,
            created_by_user_id=session.get("userId"),
        )
        db.add(q)
        added.append(q)
        position += 1
    db.flush()
    for q in added:
        _audit(db, session, request, q, "CREATED", None, {**_snapshot(q), "via": "bulk"})
    db.commit()
    for q in added:
        db.refresh(q)
    return BulkOut(added=[_out(q) for q in added], skipped=skipped)


@router.patch("/{question_id}", response_model=BankQuestionOut)
def patch_question(
    question_id: str,
    body: BankQuestionPatch,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> BankQuestionOut:
    require_capability(db, session, CAPABILITY)
    q = _question_or_404(db, question_id)
    before = _snapshot(q)
    if body.phase is not None:
        q.phase = _check_phase(body.phase)
    if body.text is not None:
        q.text = body.text.strip()
    if body.enabled is not None:
        q.enabled = body.enabled
    _audit(db, session, request, q, "UPDATED", before, _snapshot(q))
    db.commit()
    db.refresh(q)
    return _out(q)


@router.delete("/{question_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_question(
    question_id: str,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> None:
    require_capability(db, session, CAPABILITY)
    q = _question_or_404(db, question_id)
    _audit(db, session, request, q, "DELETED", _snapshot(q), None)
    db.delete(q)
    db.commit()


@router.post("/reorder", response_model=list[BankQuestionOut])
def reorder(
    body: ReorderIn,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[BankQuestionOut]:
    """The complete order for one track. Every id must belong to the track and
    every question on the track must be named: a partial order is a
    question silently moved to the end, which nobody asked for."""
    require_capability(db, session, CAPABILITY)
    track = _check_track(body.track)
    rows = db.scalars(
        select(InterviewBankQuestion).where(InterviewBankQuestion.track == track)
    ).all()
    by_id = {q.id: q for q in rows}
    if set(body.ids) != set(by_id) or len(body.ids) != len(set(body.ids)):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="ids must name every question on the track exactly once.",
        )
    for pos, qid in enumerate(body.ids, start=1):
        by_id[qid].position = pos
    db.commit()
    ordered = [by_id[qid] for qid in body.ids]
    for q in ordered:
        db.refresh(q)
    return [_out(q) for q in ordered]
