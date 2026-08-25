"""Staff and admin half of the Skills & Badge framework (§12, §15–§18).

Rule 2 everywhere a student is named: every per-student endpoint goes through
`_assert_can_access_student` (imported from routers/mentor.py, never
reimplemented), and the pending-evidence queue narrows to the mentor's own
group IN SQL — an out-of-group claim is never read out of the database, the
leave-queue lesson. Cohort views, exports and the certification catalogue are
DIRECTOR/ADMIN (§15's "cohort-level administrative view", §18).

What approving means (§10): the reviewer's APPROVE on an evidence row is the
act that mints the EARNED badge row — points stamped from the catalogue at that
moment, reviewer recorded. REJECT and MORE_INFO_REQUIRED write the verdict and
the note and mint nothing. Revoking (§18, director-only) deletes the award row
— the badge tile falls back to whatever the remaining rows honestly say — and
never touches the evidence history.

The staff read of a student's dashboard is `compose_badges`/`compose_growth`
from routers/badges.py — the same builders the student's own screen uses, so a
mentor can never see a confident number where the student sees a dash.
"""

import csv
import io
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_session
from ..models.badge import (
    BADGE_BY_CODE,
    BADGES,
    CAPABILITY_LABEL,
    CATEGORY_LABEL,
    ApprovedCertification,
    AssessmentCheckpoint,
    BadgeCategory,
    BadgeEvidence,
    CapabilityAssessment,
    CapabilityKind,
    EvidenceStatus,
    EvidenceType,
    Stage,
    StudentBadge,
    StudentBadgeStatus,
)
from ..filestore import content_disposition, read_bytes
from ..models.upload import Upload
from ..models.user import Student, User
from .badges import BadgeDashboardOut, GrowthOut, compose_badges, compose_growth
from .mentor import _assert_can_access_student, require_director, require_mentor

router = APIRouter(tags=["badge-admin"])


# --- the review queue (§12) --------------------------------------------------


class PendingEvidenceOut(BaseModel):
    id: str
    student_id: str
    student_name: str
    usn: str | None
    badge_code: str
    badge_name: str
    category_label: str
    evidence_type: str
    status: str
    title: str
    provider: str | None
    completed_on: str | None
    student_note: str | None
    from_catalogue: bool
    upload_id: str | None
    created_at: datetime


def _pending_row(ev: BadgeEvidence, name: str, usn: str | None) -> PendingEvidenceOut:
    badge = BADGE_BY_CODE.get(ev.badge_code)
    return PendingEvidenceOut(
        id=ev.id,
        student_id=ev.student_id,
        student_name=name,
        usn=usn,
        badge_code=ev.badge_code,
        badge_name=badge.name if badge else ev.badge_code,
        category_label=CATEGORY_LABEL[badge.category] if badge else "",
        evidence_type=ev.evidence_type.value,
        status=ev.status.value,
        title=ev.title,
        provider=ev.provider,
        completed_on=ev.completed_on.isoformat() if ev.completed_on else None,
        student_note=ev.student_note,
        from_catalogue=ev.approved_certification_id is not None,
        upload_id=ev.upload_id,
        created_at=ev.created_at,
    )


@router.get("/mentor/badge-evidence/pending", response_model=list[PendingEvidenceOut])
def pending_evidence(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[PendingEvidenceOut]:
    require_mentor(session)
    query = (
        select(BadgeEvidence, User.name, Student.usn)
        .join(Student, BadgeEvidence.student_id == Student.id)
        .join(User, Student.user_id == User.id)
        .where(BadgeEvidence.status == EvidenceStatus.PENDING_VERIFICATION)
        .order_by(BadgeEvidence.created_at)
    )
    if session["role"] == "MENTOR":
        mentor_id = session.get("mentorId")
        if not mentor_id:
            return []  # no Mentor group => nobody (never the whole programme)
        query = query.where(Student.mentor_id == mentor_id)
    return [_pending_row(ev, name, usn) for ev, name, usn in db.execute(query).all()]


@router.get("/mentor/badge-evidence/{evidence_id}/file")
def evidence_file(
    evidence_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> Response:
    """Stream the certificate behind a claim so the reviewer can actually read
    what they are approving. Same scope, and the same flattened 404, as the
    review endpoint."""
    require_mentor(session)
    ev = db.get(BadgeEvidence, evidence_id)
    if ev is None or ev.upload_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evidence not found.")
    try:
        _assert_can_access_student(session, ev.student_id, db)
    except HTTPException:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Evidence not found."
        ) from None
    upload = db.get(Upload, ev.upload_id)
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evidence not found.")
    try:
        content = read_bytes(upload.stored_name)
    except FileNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Stored file is missing.")
    return Response(
        content=content,
        media_type=upload.mime_type,
        headers={"Content-Disposition": content_disposition(upload.original_name)},
    )


def _award(db: Session, student_id: str, code: str, awarded_by: str, note: str | None) -> None:
    """Mint (or confirm) the EARNED row. Idempotent: an already-earned badge
    keeps its original stamp — a second approval adds evidence, not points."""
    badge = BADGE_BY_CODE[code]
    row = db.scalar(
        select(StudentBadge).where(
            StudentBadge.student_id == student_id, StudentBadge.badge_code == code
        )
    )
    if row is None:
        row = StudentBadge(student_id=student_id, badge_code=code)
        db.add(row)
    if row.status != StudentBadgeStatus.EARNED:
        row.status = StudentBadgeStatus.EARNED
        row.points_awarded = badge.points
        row.earned_at = datetime.now(timezone.utc)
        row.awarded_by_id = awarded_by
        row.award_note = note


class ReviewIn(BaseModel):
    decision: str  # APPROVE | REJECT | MORE_INFO
    note: str | None = Field(default=None, max_length=2000)


@router.post("/mentor/badge-evidence/{evidence_id}/review", response_model=PendingEvidenceOut)
def review_evidence(
    evidence_id: str,
    body: ReviewIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> PendingEvidenceOut:
    require_mentor(session)
    ev = db.get(BadgeEvidence, evidence_id)
    if ev is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evidence not found.")
    try:
        _assert_can_access_student(session, ev.student_id, db)
    except HTTPException:
        # Flattened to the same 404 — an out-of-scope id must not be
        # distinguishable from a wrong one.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Evidence not found."
        ) from None

    decision = body.decision.upper()
    if decision not in ("APPROVE", "REJECT", "MORE_INFO"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="decision must be APPROVE, REJECT or MORE_INFO.",
        )
    if ev.status == EvidenceStatus.APPROVED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="This evidence is already approved."
        )

    ev.review_note = (body.note or "").strip() or None
    ev.reviewed_by_id = session["userId"]
    ev.reviewed_at = datetime.now(timezone.utc)
    if decision == "APPROVE":
        ev.status = EvidenceStatus.APPROVED
        _award(db, ev.student_id, ev.badge_code, session["userId"], "Approved evidence")
    elif decision == "REJECT":
        ev.status = EvidenceStatus.REJECTED
    else:
        ev.status = EvidenceStatus.MORE_INFO_REQUIRED
    db.commit()
    db.refresh(ev)

    student, name, usn = db.execute(
        select(Student, User.name, Student.usn)
        .join(User, Student.user_id == User.id)
        .where(Student.id == ev.student_id)
    ).one()
    return _pending_row(ev, name, usn)


# --- manual award / revoke (§18) --------------------------------------------


class AwardIn(BaseModel):
    note: str | None = Field(default=None, max_length=2000)


@router.post("/mentor/students/{student_id}/badges/{code}/award", response_model=BadgeDashboardOut)
def manual_award(
    student_id: str,
    code: str,
    body: AwardIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> BadgeDashboardOut:
    """Manual award — how §8's readiness badges land when assessment thresholds
    are met, and §18's escape hatch for everything else."""
    _assert_can_access_student(session, student_id, db)
    if code not in BADGE_BY_CODE:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such badge.")
    _award(db, student_id, code, session["userId"], (body.note or "").strip() or "Manually awarded")
    db.commit()
    return compose_badges(db.get(Student, student_id), db)


@router.post("/mentor/students/{student_id}/badges/{code}/revoke", response_model=BadgeDashboardOut)
def revoke_badge(
    student_id: str,
    code: str,
    body: AwardIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> BadgeDashboardOut:
    require_director(session)
    if db.get(Student, student_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")
    row = db.scalar(
        select(StudentBadge).where(
            StudentBadge.student_id == student_id, StudentBadge.badge_code == code
        )
    )
    if row is None or row.status != StudentBadgeStatus.EARNED:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Badge is not earned.")
    # The award row goes; the evidence history stays — the tile falls back to
    # whatever the remaining rows honestly derive to.
    db.delete(row)
    db.commit()
    return compose_badges(db.get(Student, student_id), db)


# --- assessment scores (§9, §18) --------------------------------------------


class AssessmentIn(BaseModel):
    checkpoint: str
    # capability value -> score. Partial entry is fine: speaking may be scored
    # weeks after the rest, exactly like the English baseline.
    scores: dict[str, float]


@router.post("/mentor/students/{student_id}/assessments", response_model=GrowthOut)
def record_assessments(
    student_id: str,
    body: AssessmentIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> GrowthOut:
    _assert_can_access_student(session, student_id, db)
    try:
        checkpoint = AssessmentCheckpoint(body.checkpoint)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="checkpoint must be T0–T4."
        )
    if not body.scores:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="No scores given."
        )
    for cap_key, score in body.scores.items():
        try:
            cap = CapabilityKind(cap_key)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Unknown capability {cap_key!r}.",
            )
        if not (1 <= score <= 10):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Scores are on a 1–10 scale.",
            )
        row = db.scalar(
            select(CapabilityAssessment).where(
                CapabilityAssessment.student_id == student_id,
                CapabilityAssessment.capability == cap,
                CapabilityAssessment.checkpoint == checkpoint,
            )
        )
        if row is None:
            row = CapabilityAssessment(
                student_id=student_id, capability=cap, checkpoint=checkpoint, score=score
            )
            db.add(row)
        else:
            row.score = score  # upsert: a typo is corrected, not duplicated
        row.recorded_by_id = session["userId"]
    db.commit()
    return compose_growth(student_id, db)


# --- staff reads of one student (§15, §17) -----------------------------------


@router.get("/mentor/students/{student_id}/badges", response_model=BadgeDashboardOut)
def student_badges(
    student_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> BadgeDashboardOut:
    _assert_can_access_student(session, student_id, db)
    return compose_badges(db.get(Student, student_id), db)


@router.get("/mentor/students/{student_id}/growth", response_model=GrowthOut)
def student_growth(
    student_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> GrowthOut:
    _assert_can_access_student(session, student_id, db)
    return compose_growth(student_id, db)


class SkillProfileOut(BaseModel):
    """§17 — the consolidated profile: what does this student possess, what
    evidence supports it, how much have they improved."""

    student_id: str
    name: str
    usn: str | None
    stage: str
    points_total: int
    badges: BadgeDashboardOut
    growth: GrowthOut
    evidence_counts: dict[str, int]  # approved evidence per §11 type


@router.get("/mentor/students/{student_id}/skill-profile", response_model=SkillProfileOut)
def skill_profile(
    student_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> SkillProfileOut:
    _assert_can_access_student(session, student_id, db)
    student, name = db.execute(
        select(Student, User.name).join(User, Student.user_id == User.id).where(Student.id == student_id)
    ).one()
    badges = compose_badges(student, db)
    counts = {t.value: 0 for t in EvidenceType}
    for ev in db.scalars(
        select(BadgeEvidence).where(
            BadgeEvidence.student_id == student_id,
            BadgeEvidence.status == EvidenceStatus.APPROVED,
        )
    ).all():
        counts[ev.evidence_type.value] += 1
    return SkillProfileOut(
        student_id=student_id,
        name=name,
        usn=student.usn,
        stage=student.current_stage.value,
        points_total=badges.points_total,
        badges=badges,
        growth=compose_growth(student_id, db),
        evidence_counts=counts,
    )


# --- cohort views + export (§15, §18) ----------------------------------------


class CohortCapabilityRow(BaseModel):
    capability: str
    label: str
    averages: dict[str, float | None]  # checkpoint -> cohort mean (assessed only)
    assessed_counts: dict[str, int]


class CohortOut(BaseModel):
    students: int
    badges_earned_by_category: dict[str, int]
    capabilities: list[CohortCapabilityRow]


@router.get("/director/badges/cohort", response_model=CohortOut)
def cohort_view(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> CohortOut:
    require_director(session)
    total_students = len(db.scalars(select(Student.id)).all())

    by_cat = {c.value: 0 for c in BadgeCategory}
    for sb in db.scalars(
        select(StudentBadge).where(StudentBadge.status == StudentBadgeStatus.EARNED)
    ).all():
        badge = BADGE_BY_CODE.get(sb.badge_code)
        if badge:
            by_cat[badge.category.value] += 1

    sums: dict[tuple[CapabilityKind, str], list[float]] = defaultdict(list)
    for r in db.scalars(select(CapabilityAssessment)).all():
        sums[(r.capability, r.checkpoint.value)].append(r.score)
    rows = []
    checkpoints = [c.value for c in AssessmentCheckpoint]
    for cap in CapabilityKind:
        averages = {}
        counts = {}
        for cp in checkpoints:
            scores = sums.get((cap, cp), [])
            counts[cp] = len(scores)
            averages[cp] = round(sum(scores) / len(scores), 2) if scores else None
        rows.append(
            CohortCapabilityRow(
                capability=cap.value,
                label=CAPABILITY_LABEL[cap],
                averages=averages,
                assessed_counts=counts,
            )
        )
    return CohortOut(
        students=total_students, badges_earned_by_category=by_cat, capabilities=rows
    )


@router.get("/director/badges/export.csv")
def export_cohort_csv(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> Response:
    """§18's cohort report: one row per student — points, earned count per
    category, mean growth from baseline. A spreadsheet, because that is what a
    placement office actually forwards."""
    require_director(session)
    students = db.execute(
        select(Student, User.name).join(User, Student.user_id == User.id).order_by(User.name)
    ).all()

    earned: dict[str, list[StudentBadge]] = defaultdict(list)
    for sb in db.scalars(
        select(StudentBadge).where(StudentBadge.status == StudentBadgeStatus.EARNED)
    ).all():
        earned[sb.student_id].append(sb)

    assessments: dict[str, dict[CapabilityKind, dict[str, float]]] = defaultdict(
        lambda: defaultdict(dict)
    )
    for r in db.scalars(select(CapabilityAssessment)).all():
        assessments[r.student_id][r.capability][r.checkpoint.value] = r.score

    buf = io.StringIO()
    writer = csv.writer(buf)
    cat_headers = [CATEGORY_LABEL[c] for c in BadgeCategory]
    writer.writerow(["Name", "USN", "REEP stage", "Points", *cat_headers, "Mean growth from T0"])
    checkpoints = [c.value for c in AssessmentCheckpoint]
    for student, name in students:
        badges = earned.get(student.id, [])
        per_cat = {c: 0 for c in BadgeCategory}
        for sb in badges:
            bdef = BADGE_BY_CODE.get(sb.badge_code)
            if bdef:
                per_cat[bdef.category] += 1
        growths = []
        for cp_scores in assessments.get(student.id, {}).values():
            baseline = cp_scores.get("T0")
            assessed = [cp_scores[cp] for cp in checkpoints if cp in cp_scores]
            if baseline is not None and len(assessed) > 1:
                growths.append(assessed[-1] - baseline)
        mean_growth = round(sum(growths) / len(growths), 2) if growths else ""
        writer.writerow(
            [
                name,
                student.usn or "",
                student.current_stage.value,
                sum(sb.points_awarded for sb in badges),
                *[per_cat[c] for c in BadgeCategory],
                mean_growth,
            ]
        )
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="reep-cohort-skill-report.csv"'},
    )


# --- the Approved Certification Catalogue (§12, admin-maintained) ------------


class CertIn(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    provider: str = Field(min_length=1, max_length=200)
    badge_code: str
    evidence_type: str = "EXTERNAL_VERIFIED"
    stage: str = "EXCEL"
    duration_text: str | None = Field(default=None, max_length=100)
    is_free: bool = True
    url: str | None = Field(default=None, max_length=1000)
    active: bool = True


class CertRowOut(BaseModel):
    id: str
    name: str
    provider: str
    badge_code: str
    badge_name: str
    evidence_type: str
    stage: str
    duration_text: str | None
    is_free: bool
    url: str | None
    active: bool


def _cert_row(c: ApprovedCertification) -> CertRowOut:
    badge = BADGE_BY_CODE.get(c.badge_code)
    return CertRowOut(
        id=c.id,
        name=c.name,
        provider=c.provider,
        badge_code=c.badge_code,
        badge_name=badge.name if badge else c.badge_code,
        evidence_type=c.evidence_type.value,
        stage=c.stage.value,
        duration_text=c.duration_text,
        is_free=c.is_free,
        url=c.url,
        active=c.active,
    )


def _validated_cert_fields(body: CertIn) -> tuple[EvidenceType, Stage]:
    if body.badge_code not in BADGE_BY_CODE:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="No such badge.")
    try:
        ev_type = EvidenceType(body.evidence_type)
        stage = Stage(body.stage)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Bad evidence_type or stage.",
        )
    return ev_type, stage


@router.get("/director/approved-certifications", response_model=list[CertRowOut])
def list_certs(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[CertRowOut]:
    require_director(session)
    return [
        _cert_row(c)
        for c in db.scalars(select(ApprovedCertification).order_by(ApprovedCertification.name)).all()
    ]


@router.post(
    "/director/approved-certifications",
    response_model=CertRowOut,
    status_code=status.HTTP_201_CREATED,
)
def add_cert(
    body: CertIn, session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> CertRowOut:
    require_director(session)
    ev_type, stage = _validated_cert_fields(body)
    cert = ApprovedCertification(
        name=body.name.strip(),
        provider=body.provider.strip(),
        badge_code=body.badge_code,
        evidence_type=ev_type,
        stage=stage,
        duration_text=(body.duration_text or "").strip() or None,
        is_free=body.is_free,
        url=(body.url or "").strip() or None,
        active=body.active,
    )
    db.add(cert)
    db.commit()
    db.refresh(cert)
    return _cert_row(cert)


@router.patch("/director/approved-certifications/{cert_id}", response_model=CertRowOut)
def edit_cert(
    cert_id: str,
    body: CertIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> CertRowOut:
    require_director(session)
    cert = db.get(ApprovedCertification, cert_id)
    if cert is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Certification not found.")
    ev_type, stage = _validated_cert_fields(body)
    cert.name = body.name.strip()
    cert.provider = body.provider.strip()
    cert.badge_code = body.badge_code
    cert.evidence_type = ev_type
    cert.stage = stage
    cert.duration_text = (body.duration_text or "").strip() or None
    cert.is_free = body.is_free
    cert.url = (body.url or "").strip() or None
    cert.active = body.active
    db.commit()
    db.refresh(cert)
    return _cert_row(cert)
