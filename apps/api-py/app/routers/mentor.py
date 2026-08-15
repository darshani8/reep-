"""Mentor area — staff (MENTOR / DIRECTOR / ADMIN) views of their mentees.

Scope rule (mirrors mentorScope()/menteeWhere() in the Next.js app, and the
AGENTS.md guidance): a MENTOR sees only students in their Mentor group;
DIRECTOR/ADMIN see all. A MENTOR with NO Mentor group (no mentorId in the
session) sees NOBODY — never the whole programme.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_session
from ..models.alert import Alert
from ..models.mentor_note import MentorAction, MentorNote
from ..models.offer import OfferStatus, PlacementOffer
from ..models.user import Student, User

router = APIRouter(prefix="/mentor", tags=["mentor"])

_STAFF = {"MENTOR", "DIRECTOR", "ADMIN"}


def require_mentor(session: dict) -> dict:
    if session.get("role") not in _STAFF:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Staff access required.")
    return session


class MenteeOut(BaseModel):
    student_id: str
    name: str
    usn: str | None
    current_stage: str
    current_semester: int


@router.get("/mentees", response_model=list[MenteeOut])
def mentees(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[MenteeOut]:
    require_mentor(session)
    query = select(Student, User.name).join(User, Student.user_id == User.id)

    if session["role"] == "MENTOR":
        mentor_id = session.get("mentorId")
        if not mentor_id:
            return []  # no Mentor group => nobody (never the whole programme)
        query = query.where(Student.mentor_id == mentor_id)
    # DIRECTOR / ADMIN: no narrowing — the whole programme.

    rows = db.execute(query.order_by(User.name)).all()
    return [
        MenteeOut(
            student_id=student.id,
            name=name,
            usn=student.usn,
            current_stage=student.current_stage.value,
            current_semester=student.current_semester,
        )
        for student, name in rows
    ]


def _assert_can_access_student(session: dict, student_id: str, db: Session) -> None:
    """Staff only, and a MENTOR only for a student in their own group."""
    require_mentor(session)
    if session["role"] in ("DIRECTOR", "ADMIN"):
        if db.get(Student, student_id) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")
        return
    mentor_id = session.get("mentorId")
    student = db.get(Student, student_id)
    if not mentor_id or student is None or student.mentor_id != mentor_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Student not in your mentor group."
        )


class NoteOut(BaseModel):
    id: str
    note_text: str
    linked_action: str
    meeting_at: datetime
    created_at: datetime


class NoteIn(BaseModel):
    note_text: str = Field(min_length=1, max_length=4000)
    linked_action: str = "NONE"
    meeting_at: datetime | None = None


def _note_out(note: MentorNote) -> NoteOut:
    return NoteOut(
        id=note.id,
        note_text=note.note_text,
        linked_action=note.linked_action.value,
        meeting_at=note.meeting_at,
        created_at=note.created_at,
    )


@router.get("/students/{student_id}/notes", response_model=list[NoteOut])
def list_notes(
    student_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[NoteOut]:
    _assert_can_access_student(session, student_id, db)
    rows = db.scalars(
        select(MentorNote)
        .where(MentorNote.student_id == student_id)
        .order_by(MentorNote.meeting_at.desc())
    ).all()
    return [_note_out(n) for n in rows]


@router.post(
    "/students/{student_id}/notes", response_model=NoteOut, status_code=status.HTTP_201_CREATED
)
def add_note(
    student_id: str,
    body: NoteIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> NoteOut:
    _assert_can_access_student(session, student_id, db)
    mentor_id = session.get("mentorId")
    if not mentor_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only a mentor (with a Mentor profile) can author notes.",
        )
    try:
        action = MentorAction(body.linked_action)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid linked_action."
        )
    note = MentorNote(
        mentor_id=mentor_id,
        student_id=student_id,
        note_text=body.note_text,
        linked_action=action,
        meeting_at=body.meeting_at or datetime.now(timezone.utc),
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    return _note_out(note)


class AlertOut(BaseModel):
    id: str
    student_id: str
    student_name: str
    rule_triggered: str
    severity: str
    message: str
    triggered_at: datetime
    resolved: bool


def _alert_out(alert: Alert, student_name: str) -> AlertOut:
    return AlertOut(
        id=alert.id,
        student_id=alert.student_id,
        student_name=student_name,
        rule_triggered=alert.rule_triggered.value,
        severity=alert.severity.value,
        message=alert.message,
        triggered_at=alert.triggered_at,
        resolved=alert.resolved_at is not None,
    )


@router.get("/alerts", response_model=list[AlertOut])
def alerts(
    open_only: bool = True,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[AlertOut]:
    require_mentor(session)
    query = (
        select(Alert, User.name)
        .join(Student, Alert.student_id == Student.id)
        .join(User, Student.user_id == User.id)
    )
    if open_only:
        query = query.where(Alert.resolved_at.is_(None))
    if session["role"] == "MENTOR":
        mentor_id = session.get("mentorId")
        if not mentor_id:
            return []
        query = query.where(Student.mentor_id == mentor_id)
    rows = db.execute(query.order_by(Alert.triggered_at.desc())).all()
    return [_alert_out(a, name) for a, name in rows]


@router.post("/alerts/{alert_id}/resolve", response_model=AlertOut)
def resolve_alert(
    alert_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> AlertOut:
    require_mentor(session)
    alert = db.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Alert not found.")
    _assert_can_access_student(session, alert.student_id, db)
    if alert.resolved_at is None:
        alert.resolved_at = datetime.now(timezone.utc)
        alert.resolved_by = session["userId"]
        db.commit()
        db.refresh(alert)
    name = db.scalar(
        select(User.name).join(Student, Student.user_id == User.id).where(Student.id == alert.student_id)
    )
    return _alert_out(alert, name or "")


_DIRECTORS = {"DIRECTOR", "ADMIN"}


def require_director(session: dict) -> dict:
    if session.get("role") not in _DIRECTORS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Director access required."
        )
    return session


class PendingOfferOut(BaseModel):
    id: str
    student_id: str
    student_name: str
    job_title: str
    organisation: str
    role_type: str
    ctc_inr: int
    status: str


def _offer_row(offer: PlacementOffer, student_name: str) -> PendingOfferOut:
    return PendingOfferOut(
        id=offer.id,
        student_id=offer.student_id,
        student_name=student_name,
        job_title=offer.job_title,
        organisation=offer.organisation,
        role_type=offer.role_type.value,
        ctc_inr=offer.ctc_inr,
        status=offer.status.value,
    )


@router.get("/offers/pending", response_model=list[PendingOfferOut])
def pending_offers(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[PendingOfferOut]:
    require_director(session)
    rows = db.execute(
        select(PlacementOffer, User.name)
        .join(Student, PlacementOffer.student_id == Student.id)
        .join(User, Student.user_id == User.id)
        .where(PlacementOffer.status == OfferStatus.PENDING_APPROVAL)
        .order_by(PlacementOffer.created_at)
    ).all()
    return [_offer_row(o, name) for o, name in rows]


class DecisionIn(BaseModel):
    decision: str  # "APPROVE" | "REJECT"
    note: str | None = None


@router.post("/offers/{offer_id}/decision", response_model=PendingOfferOut)
def decide_offer(
    offer_id: str,
    body: DecisionIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> PendingOfferOut:
    require_director(session)
    offer = db.get(PlacementOffer, offer_id)
    if offer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Offer not found.")
    if offer.status != OfferStatus.PENDING_APPROVAL:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Only a pending offer can be decided."
        )
    decision = body.decision.upper()
    if decision == "APPROVE":
        offer.status = OfferStatus.APPROVED
    elif decision == "REJECT":
        offer.status = OfferStatus.REJECTED
    else:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="decision must be APPROVE or REJECT.",
        )
    offer.approved_by_id = session["userId"]
    offer.decided_at = datetime.now(timezone.utc)
    offer.decision_note = body.note
    db.commit()
    db.refresh(offer)
    name = db.scalar(
        select(User.name).join(Student, Student.user_id == User.id).where(Student.id == offer.student_id)
    )
    return _offer_row(offer, name or "")
