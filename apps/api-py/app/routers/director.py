"""Director dashboard — programme-wide aggregates. Director/admin only; reuses
the mentor router's require_director guard. Compute-only over existing data.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_session
from datetime import datetime

from ..models.alert import Alert
from ..models.cohort import Cohort
from ..models.mail import MailLog
from ..models.offer import OfferStatus, PlacementOffer
from ..models.placement_criteria import PlacementCriteria
from ..models.user import Student
from .mentor import require_director

router = APIRouter(prefix="/director", tags=["director"])


class OverviewOut(BaseModel):
    total_students: int
    by_stage: dict[str, int]
    pending_offers: int
    approved_offers: int
    placed_students: int
    placement_percent: float
    open_alerts: int


@router.get("/overview", response_model=OverviewOut)
def overview(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> OverviewOut:
    require_director(session)

    total = db.scalar(select(func.count()).select_from(Student)) or 0
    by_stage = {
        stage.value: count
        for stage, count in db.execute(
            select(Student.current_stage, func.count()).group_by(Student.current_stage)
        ).all()
    }
    pending = (
        db.scalar(
            select(func.count())
            .select_from(PlacementOffer)
            .where(PlacementOffer.status == OfferStatus.PENDING_APPROVAL)
        )
        or 0
    )
    approved = (
        db.scalar(
            select(func.count())
            .select_from(PlacementOffer)
            .where(PlacementOffer.status == OfferStatus.APPROVED)
        )
        or 0
    )
    placed = (
        db.scalar(
            select(func.count(func.distinct(PlacementOffer.student_id))).where(
                PlacementOffer.status == OfferStatus.APPROVED
            )
        )
        or 0
    )
    open_alerts = (
        db.scalar(select(func.count()).select_from(Alert).where(Alert.resolved_at.is_(None))) or 0
    )

    return OverviewOut(
        total_students=total,
        by_stage=by_stage,
        pending_offers=pending,
        approved_offers=approved,
        placed_students=placed,
        placement_percent=round(100 * placed / total, 1) if total else 0.0,
        open_alerts=open_alerts,
    )


class CohortOut(BaseModel):
    id: str
    code: str
    name: str
    batch_label: str
    degree_level: str
    student_count: int


@router.get("/cohorts", response_model=list[CohortOut])
def cohorts(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[CohortOut]:
    require_director(session)
    counts = dict(
        db.execute(select(Student.cohort_id, func.count()).group_by(Student.cohort_id)).all()
    )
    rows = db.scalars(select(Cohort).order_by(Cohort.code)).all()
    return [
        CohortOut(
            id=c.id,
            code=c.code,
            name=c.name,
            batch_label=c.batch_label,
            degree_level=c.degree_level.value,
            student_count=counts.get(c.id, 0),
        )
        for c in rows
    ]


class CriteriaOut(BaseModel):
    name: str
    active: bool
    min_cgpa: float
    max_live_backlogs: int
    max_gap_months: int
    min_attendance_pct: float
    min_reep_completion_pct: float
    min_cert_completion_pct: float
    require_core_certs: bool


@router.get("/criteria", response_model=CriteriaOut)
def criteria(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> CriteriaOut:
    require_director(session)
    c = db.scalar(
        select(PlacementCriteria)
        .where(PlacementCriteria.active.is_(True))
        .order_by(PlacementCriteria.updated_at.desc())
        .limit(1)
    )
    if c is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No active placement criteria set."
        )
    return CriteriaOut(
        name=c.name,
        active=c.active,
        min_cgpa=c.min_cgpa,
        max_live_backlogs=c.max_live_backlogs,
        max_gap_months=c.max_gap_months,
        min_attendance_pct=c.min_attendance_pct,
        min_reep_completion_pct=c.min_reep_completion_pct,
        min_cert_completion_pct=c.min_cert_completion_pct,
        require_core_certs=c.require_core_certs,
    )


class MailLogOut(BaseModel):
    id: str
    kind: str
    recipient: str
    subject: str | None
    status: str
    error: str | None
    sent_at: datetime


@router.get("/mail", response_model=list[MailLogOut])
def mail_log(
    kind: str | None = None,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[MailLogOut]:
    """Ops audit view: what the mailer was asked to send, most recent first.
    Optionally filter by `kind` (e.g. 'job-alert')."""
    require_director(session)
    query = select(MailLog)
    if kind:
        query = query.where(MailLog.kind == kind)
    rows = db.scalars(query.order_by(MailLog.sent_at.desc()).limit(100)).all()
    return [
        MailLogOut(
            id=m.id,
            kind=m.kind,
            recipient=m.recipient,
            subject=m.subject,
            status=m.status.value,
            error=m.error,
            sent_at=m.sent_at,
        )
        for m in rows
    ]
