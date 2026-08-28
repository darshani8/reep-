"""Director dashboard — programme-wide aggregates. Director/admin only; reuses
the mentor router's require_director guard. Compute-only over existing data.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.platform.identity import get_current_session
from datetime import datetime

from app.models.alert import Alert, AlertRuleConfig, AlertRuleKey, AlertSeverity
from app.models.cohort import Cohort
from app.models.job_import_run import JobImportRun
from app.models.mail import MailLog
from app.models.offer import OfferStatus, PlacementOffer
from app.models.placement_criteria import PlacementCriteria
from app.models.user import Student
from app.api.mentor.mentees import require_director

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


class AlertRuleOut(BaseModel):
    id: str
    cohort_id: str
    rule_key: str
    enabled: bool
    params: dict
    severity: str


def _alert_rule_out(r: AlertRuleConfig) -> AlertRuleOut:
    return AlertRuleOut(
        id=r.id,
        cohort_id=r.cohort_id,
        rule_key=r.rule_key.value,
        enabled=r.enabled,
        params=r.params,
        severity=r.severity.value,
    )


@router.get("/alert-rules", response_model=list[AlertRuleOut])
def alert_rules(
    cohort_id: str | None = None,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[AlertRuleOut]:
    """The admin-configurable alert thresholds, optionally scoped to a cohort."""
    require_director(session)
    query = select(AlertRuleConfig)
    if cohort_id:
        query = query.where(AlertRuleConfig.cohort_id == cohort_id)
    rows = db.scalars(query.order_by(AlertRuleConfig.cohort_id, AlertRuleConfig.rule_key)).all()
    return [_alert_rule_out(r) for r in rows]


class AlertRuleIn(BaseModel):
    cohort_id: str
    rule_key: str
    params: dict
    enabled: bool = True
    severity: str = "WARNING"


@router.put("/alert-rules", response_model=AlertRuleOut)
def upsert_alert_rule(
    body: AlertRuleIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> AlertRuleOut:
    """Create or update the threshold for one (cohort, rule) — the config lives
    in data, so tuning it never needs a deploy."""
    require_director(session)
    if db.get(Cohort, body.cohort_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cohort not found.")
    try:
        rule_key = AlertRuleKey(body.rule_key)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Unknown rule_key."
        )
    try:
        severity = AlertSeverity(body.severity)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Unknown severity."
        )

    row = db.scalar(
        select(AlertRuleConfig).where(
            AlertRuleConfig.cohort_id == body.cohort_id,
            AlertRuleConfig.rule_key == rule_key,
        )
    )
    if row is None:
        row = AlertRuleConfig(cohort_id=body.cohort_id, rule_key=rule_key)
        db.add(row)
    row.params = body.params
    row.enabled = body.enabled
    row.severity = severity
    db.commit()
    db.refresh(row)
    return _alert_rule_out(row)


class JobImportRunOut(BaseModel):
    id: str
    file_name: str | None
    uploaded_by_id: str | None
    started_at: datetime
    finished_at: datetime | None
    rows_seen: int
    rows_created: int
    rows_updated: int
    error_count: int


@router.get("/job-imports", response_model=list[JobImportRunOut])
def job_imports(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[JobImportRunOut]:
    """Audit view of bulk job-vacancy imports — counts and per-run error totals,
    most recent first."""
    require_director(session)
    rows = db.scalars(select(JobImportRun).order_by(JobImportRun.started_at.desc()).limit(50)).all()
    return [
        JobImportRunOut(
            id=r.id,
            file_name=r.file_name,
            uploaded_by_id=r.uploaded_by_id,
            started_at=r.started_at,
            finished_at=r.finished_at,
            rows_seen=r.rows_seen,
            rows_created=r.rows_created,
            rows_updated=r.rows_updated,
            error_count=len(r.errors or []),
        )
        for r in rows
    ]
