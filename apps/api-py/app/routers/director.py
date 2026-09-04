"""Director dashboard — programme-wide aggregates. Director/admin only; reuses
the mentor router's require_director guard. Compute-only over existing data.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..identity import get_current_session
from datetime import datetime

from ..models.alert import Alert, AlertRuleConfig, AlertRuleKey, AlertSeverity
from ..models.attendance import AttendanceRecord
from ..models.skill import StudentSkill
from ..models.time_ledger import TimeLedgerCell, TimeLedgerDay
from ..models.certification import Certification
from ..models.cohort import Cohort
from ..models.course import Course
from ..models.job import Job, JobApplication
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


# --- mentorship map -------------------------------------------------------
# The analytics screen draws mentors as an inner ring and their mentees as an
# outer one, then re-scales a linked bar chart by whichever metric is selected.
# All three metrics are returned together, ONE query each over the whole cohort
# rather than per student: the alternative is a chart that fires N+1 requests as
# the reader clicks around it, which is how a dashboard becomes the slowest page
# in the product.


class MenteeMetricsOut(BaseModel):
    student_id: str
    name: str
    usn: str | None
    stage: str | None
    # Percent of recorded sessions attended. None when nothing is recorded —
    # distinct from 0, which would draw a student as a total absentee.
    attendance_percent: float | None
    verified_skills: int
    # Hours logged in the time ledger, all time.
    logged_hours: float


class MentorLoadOut(BaseModel):
    mentor_id: str
    name: str
    mentee_count: int
    mentees: list[MenteeMetricsOut]


@router.get("/mentor-load", response_model=list[MentorLoadOut])
def mentor_load(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[MentorLoadOut]:
    """Every mentor with their assigned students and each student's three
    headline metrics. Programme-wide, so director/admin only."""
    require_director(session)

    mentors = db.execute(
        select(Mentor.id, User.name).join(User, Mentor.user_id == User.id).order_by(User.name)
    ).all()

    students = db.execute(
        select(Student.id, User.name, Student.usn, Student.current_stage, Student.mentor_id)
        .join(User, Student.user_id == User.id)
        .order_by(User.name)
    ).all()

    # Attendance: present and total per student, in one pass.
    att = {
        sid: (present or 0, total or 0)
        for sid, present, total in db.execute(
            select(
                AttendanceRecord.student_id,
                func.count().filter(AttendanceRecord.present.is_(True)),
                func.count(),
            ).group_by(AttendanceRecord.student_id)
        ).all()
    }
    skills = {
        sid: n
        for sid, n in db.execute(
            select(StudentSkill.student_id, func.count())
            .where(StudentSkill.verified.is_(True))
            .group_by(StudentSkill.student_id)
        ).all()
    }
    # Cells store HALF hours, so the sum is halved once here rather than in the
    # client, where every consumer would have to remember.
    hours = {
        sid: (half or 0) / 2
        for sid, half in db.execute(
            select(TimeLedgerDay.student_id, func.sum(TimeLedgerCell.half_hours))
            .join(TimeLedgerCell, TimeLedgerCell.ledger_day_id == TimeLedgerDay.id)
            .group_by(TimeLedgerDay.student_id)
        ).all()
    }

    def metrics(sid: str, name: str, usn, stage) -> MenteeMetricsOut:
        present, total = att.get(sid, (0, 0))
        return MenteeMetricsOut(
            student_id=sid,
            name=name,
            usn=usn,
            stage=stage.value if stage is not None and hasattr(stage, "value") else stage,
            attendance_percent=round(100 * present / total, 1) if total else None,
            verified_skills=skills.get(sid, 0),
            logged_hours=hours.get(sid, 0.0),
        )

    by_mentor: dict[str, list[MenteeMetricsOut]] = {}
    for sid, name, usn, stage, mentor_id in students:
        if mentor_id:
            by_mentor.setdefault(mentor_id, []).append(metrics(sid, name, usn, stage))

    return [
        MentorLoadOut(
            mentor_id=mid,
            name=name,
            mentee_count=len(by_mentor.get(mid, [])),
            mentees=by_mentor.get(mid, []),
        )
        for mid, name in mentors
    ]


class UnassignedStudentOut(BaseModel):
    student_id: str
    name: str
    usn: str | None
    stage: str | None


@router.get("/unassigned-students", response_model=list[UnassignedStudentOut])
def unassigned_students(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[UnassignedStudentOut]:
    """Students with no mentor yet — the pool the assignment screen draws from."""
    require_director(session)
    rows = db.execute(
        select(Student.id, User.name, Student.usn, Student.current_stage)
        .join(User, Student.user_id == User.id)
        .where(Student.mentor_id.is_(None))
        .order_by(User.name)
    ).all()
    return [
        UnassignedStudentOut(
            student_id=sid,
            name=name,
            usn=usn,
            stage=stage.value if stage is not None and hasattr(stage, "value") else stage,
        )
        for sid, name, usn, stage in rows
    ]


class AssignMentorIn(BaseModel):
    # Null releases the student back to the unassigned pool. An explicit null is
    # the un-assign action, so this is Optional rather than absent-means-keep.
    mentor_id: str | None = None


@router.post("/students/{student_id}/mentor", status_code=status.HTTP_204_NO_CONTENT)
def set_student_mentor(
    student_id: str,
    body: AssignMentorIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> None:
    """Assign a student to a mentor, or release them.

    Director/admin only, and deliberately not available to a MENTOR: mentor_id is
    what rule 2's scope gate filters on, so a mentor who could set it could
    assign themselves any student in the programme and then read everything about
    them. Who mentors whom is an administrative decision, not a mentoring one.
    """
    require_director(session)
    student = db.get(Student, student_id)
    if student is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")
    if body.mentor_id is not None and db.get(Mentor, body.mentor_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mentor not found.")
    student.mentor_id = body.mentor_id
    db.commit()


# --- catalogue ------------------------------------------------------------


class CatalogueCertOut(BaseModel):
    code: str
    name: str
    provider: str
    required_hours: float
    is_optional: bool
    link: str | None


class CatalogueCourseOut(BaseModel):
    code: str
    name: str
    stage: str
    dimension: str
    semester: int
    teaching_hours: float
    self_learning_hours_required: float
    model_type: str
    duration_weeks: int
    certifications: list[CatalogueCertOut]


@router.get("/catalogue", response_model=list[CatalogueCourseOut])
def catalogue(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[CatalogueCourseOut]:
    """The programme as designed: every course with the certifications mapped to
    it. Nested rather than two flat lists, because a certification only means
    anything against the course it certifies — the screen's whole question is
    which courses have evidence attached and which do not."""
    require_director(session)
    courses = db.scalars(select(Course).order_by(Course.semester, Course.code)).all()
    certs: dict[str, list[CatalogueCertOut]] = {}
    for c in db.scalars(select(Certification).order_by(Certification.name)).all():
        certs.setdefault(c.course_code, []).append(
            CatalogueCertOut(
                code=c.code,
                name=c.name,
                provider=c.provider,
                required_hours=c.required_hours,
                is_optional=c.is_optional,
                link=c.link,
            )
        )
    return [
        CatalogueCourseOut(
            code=c.code,
            name=c.name,
            stage=c.stage.value,
            dimension=c.dimension.value,
            semester=c.semester,
            teaching_hours=c.teaching_hours,
            self_learning_hours_required=c.self_learning_hours_required,
            model_type=c.model_type.value,
            duration_weeks=c.duration_weeks,
            certifications=certs.get(c.code, []),
        )
        for c in courses
    ]


# --- jobs sheet -----------------------------------------------------------


class JobSheetOut(BaseModel):
    id: str
    title: str
    company: str
    degree_level: str
    location: str | None
    apply_url: str | None
    required_skills: list[str]
    posted_on: datetime
    closes_on: datetime | None
    min_cgpa: float | None
    max_live_backlogs: int | None
    # How many students have applied. The sheet's real question is which
    # postings are working, and a posting nobody applied to looks identical to a
    # healthy one without this.
    applicants: int


@router.get("/jobs", response_model=list[JobSheetOut])
def jobs_sheet(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[JobSheetOut]:
    """Every posting on the board, newest first, with its application count."""
    require_director(session)
    counts = {
        jid: n
        for jid, n in db.execute(
            select(JobApplication.job_id, func.count()).group_by(JobApplication.job_id)
        ).all()
    }
    rows = db.scalars(select(Job).order_by(Job.posted_on.desc())).all()
    return [
        JobSheetOut(
            id=j.id,
            title=j.title,
            company=j.company,
            degree_level=j.degree_level.value,
            location=j.location,
            apply_url=j.apply_url,
            required_skills=list(j.required_skills or []),
            posted_on=j.posted_on,
            closes_on=j.closes_on,
            min_cgpa=j.min_cgpa,
            max_live_backlogs=j.max_live_backlogs,
            applicants=counts.get(j.id, 0),
        )
        for j in rows
    ]
