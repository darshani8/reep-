"""Director dashboard — programme-wide aggregates. Director/admin only; reuses
the mentor router's require_director guard.

Read-only over existing data with ONE exception: `PUT /students/{id}/mentor`,
which moves a student between mentor groups. That write lives here rather than
in routers/mentor.py deliberately — rule 2's `_assert_can_access_student`
narrows a MENTOR to the students already in their own group, and a screen whose
purpose is to move a student OUT of one cannot be scoped by the group they are
currently in. `require_director` is the only correct gate for it.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session, aliased

from ..db import get_db
from ..identity import get_current_session
from datetime import datetime

from ..models.alert import Alert, AlertRuleConfig, AlertRuleKey, AlertSeverity
from ..models.cohort import Cohort
from ..models.course import Course, Enrollment, ProgressStatus
from ..models.job_import_run import JobImportRun
from ..models.mail import MailLog
from ..models.offer import OfferStatus, PlacementOffer
from ..models.placement_criteria import PlacementCriteria
from ..models.user import Mentor, Student, User
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


# ==========================================================================
# Mentor assignment
#
# The director's "who mentors whom" screen. It exists here rather than in
# routers/mentor.py because everything on it is programme-wide by definition —
# rule 2's `_assert_can_access_student` narrows a MENTOR to their own group, and
# a screen whose whole job is to MOVE a student between groups cannot be scoped
# by the group the student is currently in. `require_director` is therefore the
# only gate, and a MENTOR gets 403 rather than a partial, misleading roster.
# ==========================================================================


class MentorOut(BaseModel):
    id: str
    user_id: str
    name: str
    email: str
    student_count: int


@router.get("/mentors", response_model=list[MentorOut])
def mentors(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[MentorOut]:
    """Every mentor group and how many students sit in it. Compute-only."""
    require_director(session)
    counts = dict(
        db.execute(
            select(Student.mentor_id, func.count())
            .where(Student.mentor_id.is_not(None))
            .group_by(Student.mentor_id)
        ).all()
    )
    rows = db.execute(select(Mentor, User).join(User, Mentor.user_id == User.id)).all()
    out = [
        MentorOut(
            id=m.id,
            user_id=u.id,
            name=u.name,
            email=u.email,
            student_count=counts.get(m.id, 0),
        )
        for m, u in rows
    ]
    out.sort(key=lambda r: r.name.lower())
    return out


class RosterStudentOut(BaseModel):
    id: str
    name: str
    email: str
    usn: str | None
    cohort_id: str | None
    mentor_id: str | None
    mentor_name: str | None
    current_stage: str
    current_semester: int


@router.get("/students", response_model=list[RosterStudentOut])
def roster(
    unassigned_only: bool = False,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[RosterStudentOut]:
    """The programme roster with each student's current mentor group.

    `mentor_name` is NULL when the student has no mentor — which is a real and
    common state, not an error, and the screen must show it as "Unassigned"
    rather than as a blank cell that reads like a rendering fault.
    """
    require_director(session)
    mentor_user = aliased(User)
    query = (
        select(Student, User.name, User.email, mentor_user.name)
        .join(User, Student.user_id == User.id)
        .outerjoin(Mentor, Student.mentor_id == Mentor.id)
        .outerjoin(mentor_user, Mentor.user_id == mentor_user.id)
    )
    if unassigned_only:
        query = query.where(Student.mentor_id.is_(None))
    rows = db.execute(query.order_by(User.name)).all()
    return [
        RosterStudentOut(
            id=s.id,
            name=name,
            email=email,
            usn=s.usn,
            cohort_id=s.cohort_id,
            mentor_id=s.mentor_id,
            mentor_name=mentor_name,
            current_stage=s.current_stage.value,
            current_semester=s.current_semester,
        )
        for s, name, email, mentor_name in rows
    ]


class AssignMentorIn(BaseModel):
    # `None` unassigns. Explicit rather than a separate DELETE route: "no
    # mentor" is a state a director sets deliberately, and rule 2 reads it as
    # "this student is in nobody's group", never as "everybody's".
    mentor_id: str | None = None


@router.put("/students/{student_id}/mentor", response_model=RosterStudentOut)
def assign_mentor(
    student_id: str,
    body: AssignMentorIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> RosterStudentOut:
    """Move a student into a mentor's group, or out of every group."""
    require_director(session)
    student = db.get(Student, student_id)
    if student is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")
    mentor_name: str | None = None
    if body.mentor_id is not None:
        mentor = db.get(Mentor, body.mentor_id)
        if mentor is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mentor not found.")
        mentor_name = db.scalar(select(User.name).where(User.id == mentor.user_id))
    student.mentor_id = body.mentor_id
    db.commit()
    db.refresh(student)
    user = db.get(User, student.user_id)
    return RosterStudentOut(
        id=student.id,
        name=user.name if user else "",
        email=user.email if user else "",
        usn=student.usn,
        cohort_id=student.cohort_id,
        mentor_id=student.mentor_id,
        mentor_name=mentor_name,
        current_stage=student.current_stage.value,
        current_semester=student.current_semester,
    )


# ==========================================================================
# Course catalogue
# ==========================================================================


class DirectorCourseOut(BaseModel):
    code: str
    name: str
    stage: str
    dimension: str
    semester: int
    teaching_hours: float
    self_learning_hours_required: float
    model_type: str
    duration_weeks: int
    enrolled: int
    completed: int
    in_progress: int
    overdue: int


@router.get("/courses", response_model=list[DirectorCourseOut])
def course_catalogue(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[DirectorCourseOut]:
    """The curriculum with programme-wide enrolment counts per course.

    Read-only. The catalogue itself is seeded curriculum, not something a
    director edits through the dashboard, so there is no write path here to
    imply otherwise.
    """
    require_director(session)
    counts: dict[str, dict[str, int]] = {}
    for code, prog_status, count in db.execute(
        select(Enrollment.course_code, Enrollment.status, func.count()).group_by(
            Enrollment.course_code, Enrollment.status
        )
    ).all():
        bucket = counts.setdefault(code, {})
        bucket[prog_status.value] = count

    rows = db.scalars(select(Course).order_by(Course.semester, Course.code)).all()
    return [
        DirectorCourseOut(
            code=c.code,
            name=c.name,
            stage=c.stage.value,
            dimension=c.dimension.value,
            semester=c.semester,
            teaching_hours=c.teaching_hours,
            self_learning_hours_required=c.self_learning_hours_required,
            model_type=c.model_type.value,
            duration_weeks=c.duration_weeks,
            enrolled=sum(counts.get(c.code, {}).values()),
            completed=counts.get(c.code, {}).get(ProgressStatus.COMPLETED.value, 0),
            in_progress=counts.get(c.code, {}).get(ProgressStatus.IN_PROGRESS.value, 0),
            overdue=counts.get(c.code, {}).get(ProgressStatus.OVERDUE.value, 0),
        )
        for c in rows
    ]
