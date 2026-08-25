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
from ..models.lab import LabSession
from ..models.mentor_note import MentorAction, MentorNote
from ..models.offer import OfferStatus, PlacementOffer
from ..models.skill import Skill, SkillClaim, StudentSkill
from ..models.upload import Upload, UploadStatus
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
    # Both optional, both student-visible. The Mentor Meeting Log renders
    # "1:1 review · Cabin 3" as the heading above each note; without them the
    # student's screen falls back to the linked action, which is a worse
    # heading but never a wrong one.
    title: str | None
    location: str | None
    meeting_at: datetime
    created_at: datetime


class NoteIn(BaseModel):
    note_text: str = Field(min_length=1, max_length=4000)
    linked_action: str = "NONE"
    # NOT backfilled onto existing notes and NOT required on new ones. A mentor
    # who types only a note has written a real note; inventing a heading for it
    # would put words in their mouth on a screen the student reads.
    title: str | None = Field(default=None, max_length=200)
    location: str | None = Field(default=None, max_length=200)
    meeting_at: datetime | None = None


def _note_out(note: MentorNote) -> NoteOut:
    return NoteOut(
        id=note.id,
        note_text=note.note_text,
        linked_action=note.linked_action.value,
        title=note.title,
        location=note.location,
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
        title=(body.title or "").strip() or None,
        location=(body.location or "").strip() or None,
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


class FocusRowOut(BaseModel):
    id: str
    course_code: str
    module: str
    activity: str
    duration_min: int | None
    check_in_at: datetime
    mentor_confirmed: bool


def _focus_row(ls: LabSession) -> FocusRowOut:
    return FocusRowOut(
        id=ls.id,
        course_code=ls.course_code,
        module=ls.module,
        activity=ls.activity.value,
        duration_min=ls.duration_min,
        check_in_at=ls.check_in_at,
        mentor_confirmed=ls.mentor_confirmed,
    )


@router.get("/students/{student_id}/focus", response_model=list[FocusRowOut])
def student_focus(
    student_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[FocusRowOut]:
    _assert_can_access_student(session, student_id, db)
    rows = db.scalars(
        select(LabSession)
        .where(LabSession.student_id == student_id)
        .order_by(LabSession.check_in_at.desc())
    ).all()
    return [_focus_row(ls) for ls in rows]


@router.post("/focus/{session_id}/confirm", response_model=FocusRowOut)
def confirm_focus(
    session_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> FocusRowOut:
    require_mentor(session)
    ls = db.get(LabSession, session_id)
    if ls is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found.")
    _assert_can_access_student(session, ls.student_id, db)
    ls.mentor_confirmed = True
    db.commit()
    db.refresh(ls)
    return _focus_row(ls)


class UploadOut(BaseModel):
    id: str
    student_id: str
    student_name: str
    kind: str
    cert_code: str | None
    title: str
    original_name: str
    mime_type: str
    size_bytes: int
    status: str
    reviewed_by_id: str | None
    reviewed_at: datetime | None
    review_note: str | None
    uploaded_at: datetime


def _upload_out(u: Upload, student_name: str) -> UploadOut:
    return UploadOut(
        id=u.id,
        student_id=u.student_id,
        student_name=student_name,
        kind=u.kind.value,
        cert_code=u.cert_code,
        title=u.title,
        original_name=u.original_name,
        mime_type=u.mime_type,
        size_bytes=u.size_bytes,
        status=u.status.value,
        reviewed_by_id=u.reviewed_by_id,
        reviewed_at=u.reviewed_at,
        review_note=u.review_note,
        uploaded_at=u.uploaded_at,
    )


@router.get("/uploads/pending", response_model=list[UploadOut])
def pending_uploads(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[UploadOut]:
    """Documents awaiting review — profile photos, certificate proofs, offer
    letters — scoped to the mentor's own group (DIRECTOR/ADMIN see all)."""
    require_mentor(session)
    query = (
        select(Upload, User.name)
        .join(Student, Upload.student_id == Student.id)
        .join(User, Student.user_id == User.id)
        .where(Upload.status == UploadStatus.PENDING_REVIEW)
    )
    if session["role"] == "MENTOR":
        mentor_id = session.get("mentorId")
        if not mentor_id:
            return []  # no Mentor group => nobody (never the whole programme)
        query = query.where(Student.mentor_id == mentor_id)
    rows = db.execute(query.order_by(Upload.uploaded_at)).all()
    return [_upload_out(u, name) for u, name in rows]


class UploadReviewIn(BaseModel):
    decision: str  # "VERIFY" | "REJECT"
    note: str | None = None


@router.post("/uploads/{upload_id}/review", response_model=UploadOut)
def review_upload(
    upload_id: str,
    body: UploadReviewIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> UploadOut:
    """Verify or reject a submitted document. Scope-checked: a MENTOR can only
    touch an upload from a student in their own group."""
    require_mentor(session)
    up = db.get(Upload, upload_id)
    if up is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found.")
    _assert_can_access_student(session, up.student_id, db)
    if up.status != UploadStatus.PENDING_REVIEW:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Only a pending upload can be reviewed."
        )
    decision = body.decision.upper()
    if decision in ("VERIFY", "VERIFIED", "APPROVE"):
        up.status = UploadStatus.VERIFIED
    elif decision in ("REJECT", "REJECTED"):
        up.status = UploadStatus.REJECTED
    else:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="decision must be VERIFY or REJECT.",
        )
    up.reviewed_by_id = session["userId"]
    up.reviewed_at = datetime.now(timezone.utc)
    up.review_note = body.note
    db.commit()
    db.refresh(up)
    name = db.scalar(
        select(User.name).join(Student, Student.user_id == User.id).where(Student.id == up.student_id)
    )
    return _upload_out(up, name or "")


class SkillClaimReviewOut(BaseModel):
    id: str
    student_id: str
    student_name: str
    skill_id: str
    skill_name: str
    upload_id: str
    claimed_level: int
    status: str
    reviewed_by_id: str | None
    reviewed_at: datetime | None
    review_note: str | None
    created_at: datetime


def _claim_out(sc: SkillClaim, student_name: str, skill_name: str) -> SkillClaimReviewOut:
    return SkillClaimReviewOut(
        id=sc.id,
        student_id=sc.student_id,
        student_name=student_name,
        skill_id=sc.skill_id,
        skill_name=skill_name,
        upload_id=sc.upload_id,
        claimed_level=sc.claimed_level,
        status=sc.status.value,
        reviewed_by_id=sc.reviewed_by_id,
        reviewed_at=sc.reviewed_at,
        review_note=sc.review_note,
        created_at=sc.created_at,
    )


@router.get("/skill-claims/pending", response_model=list[SkillClaimReviewOut])
def pending_skill_claims(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[SkillClaimReviewOut]:
    """Skill claims awaiting review, scoped to the mentor's group."""
    require_mentor(session)
    query = (
        select(SkillClaim, User.name, Skill.name)
        .join(Student, SkillClaim.student_id == Student.id)
        .join(User, Student.user_id == User.id)
        .join(Skill, SkillClaim.skill_id == Skill.id)
        .where(SkillClaim.status == UploadStatus.PENDING_REVIEW)
    )
    if session["role"] == "MENTOR":
        mentor_id = session.get("mentorId")
        if not mentor_id:
            return []
        query = query.where(Student.mentor_id == mentor_id)
    rows = db.execute(query.order_by(SkillClaim.created_at)).all()
    return [_claim_out(sc, sname, skname) for sc, sname, skname in rows]


class SkillClaimReviewIn(BaseModel):
    decision: str  # "GRANT" | "REJECT"
    granted_level: int | None = Field(default=None, ge=1, le=5)
    note: str | None = None


@router.post("/skill-claims/{claim_id}/review", response_model=SkillClaimReviewOut)
def review_skill_claim(
    claim_id: str,
    body: SkillClaimReviewIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> SkillClaimReviewOut:
    """Grant (optionally at a reduced level) or reject a skill claim. Granting
    upserts the student's verified StudentSkill at the granted level and points
    it at the evidence upload — the claim is how a skill becomes verified."""
    require_mentor(session)
    sc = db.get(SkillClaim, claim_id)
    if sc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Claim not found.")
    _assert_can_access_student(session, sc.student_id, db)
    if sc.status != UploadStatus.PENDING_REVIEW:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Only a pending claim can be reviewed."
        )
    decision = body.decision.upper()
    if decision in ("GRANT", "APPROVE", "VERIFY"):
        granted = body.granted_level or sc.claimed_level
        sc.status = UploadStatus.VERIFIED
        # Upsert the verified StudentSkill at the granted level.
        existing = db.scalar(
            select(StudentSkill).where(
                StudentSkill.student_id == sc.student_id,
                StudentSkill.skill_id == sc.skill_id,
            )
        )
        if existing is None:
            db.add(
                StudentSkill(
                    student_id=sc.student_id,
                    skill_id=sc.skill_id,
                    level=granted,
                    verified=True,
                    evidence_upload_id=sc.upload_id,
                )
            )
        else:
            existing.level = granted
            existing.verified = True
            existing.evidence_upload_id = sc.upload_id
    elif decision in ("REJECT", "REJECTED"):
        sc.status = UploadStatus.REJECTED
    else:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="decision must be GRANT or REJECT.",
        )
    sc.reviewed_by_id = session["userId"]
    sc.reviewed_at = datetime.now(timezone.utc)
    sc.review_note = body.note
    db.commit()
    db.refresh(sc)
    sname = db.scalar(
        select(User.name).join(Student, Student.user_id == User.id).where(Student.id == sc.student_id)
    )
    skname = db.scalar(select(Skill.name).where(Skill.id == sc.skill_id))
    return _claim_out(sc, sname or "", skname or "")
