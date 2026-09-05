"""Director dashboard — programme-wide aggregates. Director/admin only; reuses
the mentor router's require_director guard. Compute-only over existing data.
"""

import csv
import io
from collections import Counter
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..identity import get_current_session

from ..models.alert import Alert, AlertRuleConfig, AlertRuleKey, AlertSeverity
from ..models.attendance import AttendanceRecord
from ..models.badge import (
    BADGE_BY_CODE,
    BADGES,
    CATEGORY_LABEL,
    BadgeEvidence,
    EvidenceStatus,
    StudentBadge,
    StudentBadgeStatus,
)
from ..models.skill import Skill, StudentSkill
from ..models.time_ledger import (
    PRODUCTIVE,
    LedgerDayStatus,
    TimeLedgerCell,
    TimeLedgerDay,
)
from ..models.certification import Certification
from ..models.cohort import Cohort
from ..models.course import Course, Enrollment
from ..models.job import DegreeLevel, Job, JobApplication
from ..models.job_import_run import JobImportRun
from ..models.mail import MailLog
from ..models.offer import OfferStatus, PlacementOffer
from ..models.placement_criteria import PlacementCriteria
from ..models.registration import Registration, RegistrationStatus
from ..models.resume import Resume
from ..models.user import Mentor, Student, User
from ..resume_pdf import render_resume_pdf
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
    # The mentor's institutional identity, as the roster holds it. Nullable for
    # the same reason it is on the leave form: the roster does not carry it for
    # every row, and the screen says "not on record" rather than inventing one.
    department: str | None
    designation: str | None
    # settings.mentor_capacity — programme policy, not a per-mentor fact. The
    # assignment screen derives "N free" from it; nothing enforces it.
    capacity: int
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
        select(Mentor.id, User.name, User.department, User.designation)
        .join(User, Mentor.user_id == User.id)
        .order_by(User.name)
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
            department=department,
            designation=designation,
            capacity=settings.mentor_capacity,
            mentee_count=len(by_mentor.get(mid, [])),
            mentees=by_mentor.get(mid, []),
        )
        for mid, name, department, designation in mentors
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
    # Students with an Enrollment row on this course, any status. The catalogue
    # table's "Enrolled" column; a course nobody is on is a real finding.
    enrolled: int
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
    enrolled = {
        code: n
        for code, n in db.execute(
            select(Enrollment.course_code, func.count()).group_by(Enrollment.course_code)
        ).all()
    }
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
            enrolled=enrolled.get(c.code, 0),
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
    return [_job_sheet_row(j, counts.get(j.id, 0)) for j in rows]


def _job_sheet_row(j: Job, applicants: int) -> JobSheetOut:
    return JobSheetOut(
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
        applicants=applicants,
    )


class JobIn(BaseModel):
    """A new opening, as the Jobs sheet's form asks for it: role, company,
    level, location and a closing date. The eligibility gates (min CGPA, live
    backlogs) are deliberately NOT here — they default to the programme's
    placement criteria, and a form that invites a per-posting override is how a
    cut-off gets set a notch too high by accident (see the sheet's own note)."""

    title: str = Field(min_length=1, max_length=200)
    company: str = Field(min_length=1, max_length=200)
    degree_level: str = "PG"
    location: str | None = Field(default=None, max_length=200)
    closes_on: date | None = None
    apply_url: str | None = Field(default=None, max_length=1000)
    required_skills: list[str] = Field(default_factory=list, max_length=30)


@router.post("/jobs", response_model=JobSheetOut, status_code=status.HTTP_201_CREATED)
def create_job(
    body: JobIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> JobSheetOut:
    """Publish an opening to the sheet. Visible to students and alumni at once —
    both boards read the same `jobs` table, which is what "publish" means here."""
    require_director(session)
    try:
        level = DegreeLevel(body.degree_level.upper())
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Level must be PG or UG."
        )
    apply_url = (body.apply_url or "").strip() or None
    if apply_url and not apply_url.lower().startswith(("http://", "https://")):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The apply link must start with http:// or https://.",
        )
    now = datetime.now(timezone.utc)
    closes = (
        datetime(body.closes_on.year, body.closes_on.month, body.closes_on.day, 23, 59, tzinfo=timezone.utc)
        if body.closes_on
        else None
    )
    job = Job(
        title=body.title.strip(),
        company=body.company.strip(),
        degree_level=level,
        location=(body.location or "").strip() or None,
        apply_url=apply_url,
        required_skills=[skill.strip() for skill in body.required_skills if skill.strip()],
        posted_on=now,
        closes_on=closes,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return _job_sheet_row(job, 0)


@router.delete("/jobs/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_job(
    job_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> None:
    """Remove a posting. REFUSED once anyone has applied: job_applications
    cascade on delete, and a student's application is part of their record —
    the row a mentor reads when the student says "I applied to TCS". A posting
    that has done its job stays on the sheet as history."""
    require_director(session)
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Posting not found.")
    applicants = (
        db.scalar(
            select(func.count()).select_from(JobApplication).where(JobApplication.job_id == job_id)
        )
        or 0
    )
    if applicants:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"{applicants} student{'s have' if applicants != 1 else ' has'} applied to this "
                "posting, so it cannot be removed — the applications are part of their records."
            ),
        )
    db.delete(job)
    db.commit()



# --- the analytics header and stat tiles ------------------------------------


def _modal_semester(db: Session) -> int | None:
    """The semester most students are in, or None with no students. There is no
    programme-wide "current semester" row; the header says the one that holds
    for most of the cohort rather than inventing a setting for it."""
    row = db.execute(
        select(Student.current_semester, func.count())
        .group_by(Student.current_semester)
        .order_by(func.count().desc(), Student.current_semester.desc())
        .limit(1)
    ).first()
    return int(row[0]) if row else None


class AnalyticsSummaryOut(BaseModel):
    students_total: int
    pending_registrations: int
    mentors_total: int
    # Assigned students per mentor. None with no mentors — an average over
    # nobody is not zero.
    mentees_per_mentor: float | None
    badges_awarded: int
    evidence_awaiting_verification: int
    placed_students: int
    placement_percent: float
    approved_offers: int
    semester: int | None
    generated_at: datetime


@router.get("/analytics-summary", response_model=AnalyticsSummaryOut)
def analytics_summary(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> AnalyticsSummaryOut:
    """The four tiles across the top of Programme analytics, in one call."""
    require_director(session)

    def count(stmt) -> int:
        return db.scalar(select(func.count()).select_from(stmt.subquery())) or 0

    total = db.scalar(select(func.count()).select_from(Student)) or 0
    pending_regs = count(
        select(Registration.id).where(Registration.status == RegistrationStatus.PENDING_REVIEW)
    )
    mentors = db.scalar(select(func.count()).select_from(Mentor)) or 0
    assigned = count(select(Student.id).where(Student.mentor_id.is_not(None)))
    badges = count(select(StudentBadge.id).where(StudentBadge.status == StudentBadgeStatus.EARNED))
    awaiting = count(
        select(BadgeEvidence.id).where(BadgeEvidence.status == EvidenceStatus.PENDING_VERIFICATION)
    )
    approved_offers = count(
        select(PlacementOffer.id).where(PlacementOffer.status == OfferStatus.APPROVED)
    )
    placed = (
        db.scalar(
            select(func.count(func.distinct(PlacementOffer.student_id))).where(
                PlacementOffer.status == OfferStatus.APPROVED
            )
        )
        or 0
    )
    return AnalyticsSummaryOut(
        students_total=total,
        pending_registrations=pending_regs,
        mentors_total=mentors,
        mentees_per_mentor=round(assigned / mentors, 1) if mentors else None,
        badges_awarded=badges,
        evidence_awaiting_verification=awaiting,
        placed_students=placed,
        placement_percent=round(100 * placed / total, 1) if total else 0.0,
        approved_offers=approved_offers,
        semester=_modal_semester(db),
        generated_at=datetime.now(timezone.utc),
    )


# --- one student, read from the mentorship map ------------------------------

#: Weeks of history the analytics detail draws, this week included.
WEEKLY_WINDOW = 6


class WeekOut(BaseModel):
    label: str
    start: date
    end: date


class SkillCategoryOut(BaseModel):
    category: str
    count: int


class StudentWeeklyOut(BaseModel):
    student_id: str
    name: str
    usn: str | None
    weekly_hour_target: float
    # Whether "Download CV" has anything to download — checked here so the
    # button is never drawn for a student with no resume on record.
    has_resume: bool
    weeks: list[WeekOut]
    # Per week, present / total sessions. None for a week with no sessions at
    # all — that is "no classes", not 0 % attendance.
    attendance_percent: list[float | None]
    # Per week, hours entered in the Time Allocation Ledger.
    logged_hours: list[float]
    # Verified skills, grouped by the catalogue's category — the one honest
    # breakdown of "skill badges" for one student. Verification carries no
    # timestamp, so there is no weekly series for it.
    skills_by_category: list[SkillCategoryOut]


@router.get("/students/{student_id}/weekly", response_model=StudentWeeklyOut)
def student_weekly(
    student_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> StudentWeeklyOut:
    """The last six ISO weeks of one student's attendance and ledger hours —
    what the analytics bar chart draws when a student arc is clicked. Director/
    admin only (rule 2: they see all); a mentor's view of a mentee lives under
    /mentor/students/{id}/... behind the scope gate."""
    require_director(session)
    row = db.execute(
        select(Student, User.name)
        .join(User, Student.user_id == User.id)
        .where(Student.id == student_id)
    ).first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")
    student, name = row

    today = datetime.now(timezone.utc).date()
    this_monday = today - timedelta(days=today.weekday())
    starts = [this_monday - timedelta(weeks=WEEKLY_WINDOW - 1 - i) for i in range(WEEKLY_WINDOW)]
    window_start = starts[0]

    def bucket(d: date) -> int | None:
        idx = (d - window_start).days // 7
        return idx if 0 <= idx < WEEKLY_WINDOW else None

    present = [0] * WEEKLY_WINDOW
    total = [0] * WEEKLY_WINDOW
    for session_date, was_present in db.execute(
        select(AttendanceRecord.session_date, AttendanceRecord.present).where(
            AttendanceRecord.student_id == student_id,
            AttendanceRecord.session_date >= datetime(
                window_start.year, window_start.month, window_start.day, tzinfo=timezone.utc
            ),
        )
    ).all():
        idx = bucket(session_date.date())
        if idx is None:
            continue
        total[idx] += 1
        if was_present:
            present[idx] += 1

    halves = [0] * WEEKLY_WINDOW
    for day, half in db.execute(
        select(TimeLedgerDay.day, func.sum(TimeLedgerCell.half_hours))
        .join(TimeLedgerCell, TimeLedgerCell.ledger_day_id == TimeLedgerDay.id)
        .where(TimeLedgerDay.student_id == student_id, TimeLedgerDay.day >= window_start)
        .group_by(TimeLedgerDay.day)
    ).all():
        idx = bucket(day)
        if idx is not None:
            halves[idx] += int(half or 0)

    skills = db.execute(
        select(Skill.category, func.count())
        .join(StudentSkill, StudentSkill.skill_id == Skill.id)
        .where(StudentSkill.student_id == student_id, StudentSkill.verified.is_(True))
        .group_by(Skill.category)
        .order_by(func.count().desc(), Skill.category)
    ).all()

    has_resume = (
        db.scalar(select(func.count()).select_from(Resume).where(Resume.student_id == student_id))
        or 0
    ) > 0

    return StudentWeeklyOut(
        student_id=student.id,
        name=name,
        usn=student.usn,
        weekly_hour_target=student.weekly_hour_target,
        has_resume=has_resume,
        weeks=[
            WeekOut(label=start.strftime("%-d %b"), start=start, end=start + timedelta(days=6))
            for start in starts
        ],
        attendance_percent=[
            round(100 * present[i] / total[i], 1) if total[i] else None
            for i in range(WEEKLY_WINDOW)
        ],
        logged_hours=[h / 2 for h in halves],
        skills_by_category=[SkillCategoryOut(category=c, count=n) for c, n in skills],
    )


@router.get("/students/{student_id}/resume.pdf")
def student_resume_pdf(
    student_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> Response:
    """The student's latest REEP resume, rendered to PDF for the reader of the
    analytics map. LOCAL render (ReportLab, no model, no network), so rule 1's
    egress gate does not apply. Rule 2 does: director/admin only — a mentor
    reading a mentee's resume would need the scope gate, and that endpoint does
    not exist yet, so this one does not pretend to be it."""
    require_director(session)
    row = db.execute(
        select(Resume, Student.usn)
        .join(Student, Resume.student_id == Student.id)
        .where(Resume.student_id == student_id)
        .order_by(Resume.created_at.desc())
        .limit(1)
    ).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No resume on record for this student."
        )
    resume, usn = row
    pdf = render_resume_pdf(resume.markdown or "", fallback_title=resume.title or "REEP Resume")
    stem = (usn or student_id).replace('"', "")
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="resume-{stem}-v{resume.version}.pdf"'},
    )


# --- placement ------------------------------------------------------------


class PlacementOfferRowOut(BaseModel):
    id: str
    student_id: str
    student_name: str
    usn: str | None
    organisation: str
    job_title: str
    role_type: str
    ctc_inr: int
    status: str
    created_at: datetime
    decided_at: datetime | None


class RecruiterOut(BaseModel):
    organisation: str
    count: int


class PlacementOut(BaseModel):
    semester: int | None
    # The funnel. Four stages, because four are recorded: nothing in the schema
    # says who was interviewed, and a tile for it would be a permanent dash.
    eligible: int  # students in the programme
    applied: int  # distinct students with at least one job application
    offers: int  # offers submitted for approval (pending, approved or refused)
    approved: int  # offers approved — the ones that count towards placement
    approved_students: int
    recent: list[PlacementOfferRowOut]
    top_recruiters: list[RecruiterOut]


#: Rows the Recent offers table shows. Newest first; the export carries all.
RECENT_OFFERS = 25


@router.get("/placement", response_model=PlacementOut)
def placement(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> PlacementOut:
    require_director(session)
    submitted = PlacementOffer.status != OfferStatus.DRAFT

    eligible = db.scalar(select(func.count()).select_from(Student)) or 0
    applied = db.scalar(select(func.count(func.distinct(JobApplication.student_id)))) or 0
    offers = db.scalar(select(func.count()).select_from(PlacementOffer).where(submitted)) or 0
    approved = (
        db.scalar(
            select(func.count())
            .select_from(PlacementOffer)
            .where(PlacementOffer.status == OfferStatus.APPROVED)
        )
        or 0
    )
    approved_students = (
        db.scalar(
            select(func.count(func.distinct(PlacementOffer.student_id))).where(
                PlacementOffer.status == OfferStatus.APPROVED
            )
        )
        or 0
    )
    recent = db.execute(
        select(PlacementOffer, User.name, Student.usn)
        .join(Student, PlacementOffer.student_id == Student.id)
        .join(User, Student.user_id == User.id)
        .where(submitted)
        .order_by(PlacementOffer.created_at.desc())
        .limit(RECENT_OFFERS)
    ).all()
    recruiters = db.execute(
        select(PlacementOffer.organisation, func.count())
        .where(PlacementOffer.status == OfferStatus.APPROVED)
        .group_by(PlacementOffer.organisation)
        .order_by(func.count().desc(), PlacementOffer.organisation)
        .limit(10)
    ).all()
    return PlacementOut(
        semester=_modal_semester(db),
        eligible=eligible,
        applied=applied,
        offers=offers,
        approved=approved,
        approved_students=approved_students,
        recent=[
            PlacementOfferRowOut(
                id=o.id,
                student_id=o.student_id,
                student_name=name,
                usn=usn,
                organisation=o.organisation,
                job_title=o.job_title,
                role_type=o.role_type.value,
                ctc_inr=o.ctc_inr,
                status=o.status.value,
                created_at=o.created_at,
                decided_at=o.decided_at,
            )
            for o, name, usn in recent
        ],
        top_recruiters=[RecruiterOut(organisation=org, count=n) for org, n in recruiters],
    )


# --- the badge catalogue, for the certification form ------------------------


class BadgeCatalogueOut(BaseModel):
    code: str
    name: str
    category: str
    category_label: str
    stage: str
    points: int


@router.get("/badge-catalogue", response_model=list[BadgeCatalogueOut])
def badge_catalogue(session: dict = Depends(get_current_session)) -> list[BadgeCatalogueOut]:
    """The 48-badge catalogue (code, not rows — see models/badge.py), so the
    Approved Certification form can offer the badge a certification maps to.
    No database read; the gate is here because the catalogue's points are what
    the Certifications table shows and that table is a director screen."""
    require_director(session)
    return [
        BadgeCatalogueOut(
            code=b.code,
            name=b.name,
            category=b.category.value,
            category_label=CATEGORY_LABEL[b.category],
            stage=b.stage.value,
            points=b.points,
        )
        for b in BADGES
    ]


# --- exports ----------------------------------------------------------------


def _csv_cell(value: object) -> str:
    """CSV formula injection guard, same convention as the badge export: a name
    registered as "=HYPERLINK(...)" becomes a live formula the moment the file
    is opened in Excel/Sheets. The leading apostrophe is the spreadsheet
    convention for "this is text"."""
    text = "" if value is None else str(value)
    return f"'{text}" if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def _csv_response(header: list[str], rows: list[list[object]], filename: str) -> Response:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    for row in rows:
        writer.writerow([_csv_cell(v) for v in row])
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/exports/students.csv")
def export_students_csv(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> Response:
    """Admitted students with their stage, semester, cohort and mentor — the
    "registrations & mentor map" a placement office forwards."""
    require_director(session)
    mentor_name = {
        mid: name
        for mid, name in db.execute(
            select(Mentor.id, User.name).join(User, Mentor.user_id == User.id)
        ).all()
    }
    cohort_name = dict(db.execute(select(Cohort.id, Cohort.name)).all())
    rows = db.execute(
        select(Student, User.name).join(User, Student.user_id == User.id).order_by(User.name)
    ).all()
    return _csv_response(
        ["Name", "USN", "REEP stage", "Semester", "Cohort", "Mentor"],
        [
            [
                name,
                s.usn or "",
                s.current_stage.value,
                s.current_semester,
                cohort_name.get(s.cohort_id, "") if s.cohort_id else "",
                mentor_name.get(s.mentor_id, "") if s.mentor_id else "Unassigned",
            ]
            for s, name in rows
        ],
        "reep-students-mentor-map.csv",
    )


@router.get("/exports/placement.csv")
def export_placement_csv(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> Response:
    """Every submitted offer: student, company, role, CTC and the decision."""
    require_director(session)
    rows = db.execute(
        select(PlacementOffer, User.name, Student.usn)
        .join(Student, PlacementOffer.student_id == Student.id)
        .join(User, Student.user_id == User.id)
        .where(PlacementOffer.status != OfferStatus.DRAFT)
        .order_by(PlacementOffer.created_at.desc())
    ).all()
    return _csv_response(
        ["Student", "USN", "Company", "Role", "Role type", "CTC (INR)", "Status", "Submitted", "Decided"],
        [
            [
                name,
                usn or "",
                o.organisation,
                o.job_title,
                o.role_type.value,
                o.ctc_inr,
                o.status.value,
                o.created_at.date().isoformat() if o.created_at else "",
                o.decided_at.date().isoformat() if o.decided_at else "",
            ]
            for o, name, usn in rows
        ],
        "reep-placement-summary.csv",
    )


@router.get("/exports/ledger.csv")
def export_ledger_csv(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> Response:
    """Time Allocation Ledger compliance per student: days logged, days
    submitted, hours entered and the productive share (lectures, coursework,
    skilling — the same three heads the student's own metrics strip counts)."""
    require_director(session)
    days: dict[str, tuple[int, int]] = {
        sid: (int(logged or 0), int(submitted or 0))
        for sid, logged, submitted in db.execute(
            select(
                TimeLedgerDay.student_id,
                func.count(),
                func.count().filter(TimeLedgerDay.status == LedgerDayStatus.SUBMITTED),
            ).group_by(TimeLedgerDay.student_id)
        ).all()
    }
    hours: dict[str, tuple[int, int]] = {
        sid: (int(total or 0), int(productive or 0))
        for sid, total, productive in db.execute(
            select(
                TimeLedgerDay.student_id,
                func.sum(TimeLedgerCell.half_hours),
                func.sum(TimeLedgerCell.half_hours).filter(
                    TimeLedgerCell.activity.in_(list(PRODUCTIVE))
                ),
            )
            .join(TimeLedgerCell, TimeLedgerCell.ledger_day_id == TimeLedgerDay.id)
            .group_by(TimeLedgerDay.student_id)
        ).all()
    }
    rows = db.execute(
        select(Student, User.name).join(User, Student.user_id == User.id).order_by(User.name)
    ).all()
    out: list[list[object]] = []
    for s, name in rows:
        logged, submitted = days.get(s.id, (0, 0))
        total_h, productive_h = hours.get(s.id, (0, 0))
        out.append([name, s.usn or "", logged, submitted, total_h / 2, productive_h / 2])
    return _csv_response(
        ["Name", "USN", "Days logged", "Days submitted", "Hours logged", "Productive hours"],
        out,
        "reep-ledger-compliance.csv",
    )
