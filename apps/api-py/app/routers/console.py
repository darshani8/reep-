"""The Main Admin console — programme-wide aggregates. Main Admin only; reuses
an admin.* capability per screen (Governance). Compute-only over existing data.
"""

from collections import Counter
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
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
from ..models.institution import Department
from ..models.registration import Registration, RegistrationStatus
from ..models.resume import Resume
from ..models.user import Mentor, Role, Student, User
from ..staff_placement import UNFILED, placements_for
# Rule 2's gate, imported rather than reimplemented — see its docstring for why
# there is exactly one of it.
from .mentor import _assert_can_access_student
# The response shape is defined once, next to the endpoints that own faculty.
# Redefining it here would be the "one name, two shapes" the guard in
# tests/test_codebase_guards.py exists to stop.
from .admin_faculty import StaffPlacementOut
from ..resume_pdf import render_resume_pdf
from ..architecture_events import record_change
from ..governance import ancestry_of_student, ancestry_of_user, require_capability
from ..models.governance import ScopeLevel
from ..policies import scope_filter
# B1.4. The projection of ONE reach onto `registrations`, and the response
# header that states the caller's scope. See app/scope_views.py for why
# neither belongs in policies.py.
from ..scope_views import registration_scope_clause, scope_header
# B14. What an extract may carry and the receipt it leaves are decided in ONE
# module, shared with the badge export in routers/badge_verification.py — an
# export rule written twice is an export rule applied once.
from ..exports import (
    carries_personal_columns,
    csv_response,
    drop_personal,
    record_export,
    scope_note,
)
from ..models.account_events import ExportEvent

router = APIRouter(prefix="/admin", tags=["admin"])


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
    require_capability(db, session, "admin.analytics")

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
    require_capability(db, session, "admin.analytics")
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
# THE ANALYTICS SURFACE CHECKS A CAPABILITY, NOT A ROLE. The Main Admin holds
# every capability through ROLE_BASELINE, so for them this is identical to
# require_admin; the difference is a MENTOR an admin has granted
# admin.analytics to. It is PROGRAMME scope — no mentor group narrows it — which
# is why the console paints that grant red and demands a reason.
def criteria(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> CriteriaOut:
    require_capability(db, session, "admin.analytics")
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
    require_capability(db, session, "admin.analytics")
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
    require_capability(db, session, "admin.analytics")
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
    require_capability(db, session, "admin.analytics")
    if db.get(Cohort, body.cohort_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cohort not found.")
    try:
        rule_key = AlertRuleKey(body.rule_key)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Unknown rule_key."
        )
    try:
        severity = AlertSeverity(body.severity)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Unknown severity."
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
    require_capability(db, session, "admin.jobs")
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
    # B1.5. TRUE when this pair spans two departments. The pair is KEPT and
    # flagged, never broken: `set_student_mentor` refuses a NEW cross-COLLEGE
    # assignment, and everything already on the roster was assigned under the
    # old rule by somebody who meant it. Breaking those on deploy would empty
    # real mentor groups, which is rule 2's input — a mentor with no group sees
    # nobody — so the office would discover the change as mentors losing their
    # mentees rather than as a policy taking effect.
    #
    # False when either side is unfiled, and that is not the same fact: an
    # unfiled faculty account or an unseated student hangs under nothing, so
    # "different departments" is not something anyone can assert about the pair.
    # The Faculty screen already has a list of the unfiled; this column is not
    # a second one.
    cross_department: bool = False


class MentorLoadOut(BaseModel):
    # NULL until the Main Admin assigns this faculty member their first
    # student: every MENTOR-role account is listed here, and the assignment is
    # what creates the `Mentor` row (the group rule 2 filters on). Consumers
    # that key on mentor_id skip the null rows; the assignment screen keys on
    # user_id and sends mentor_user_id instead.
    mentor_id: str | None
    # The USER id, beside the mentor id: department and designation below are
    # columns on `users`, and the console edits them through
    # PATCH /api/admin/users/{user_id}/institutional-identity. Without this the
    # screen could read the two fields and had no way to address the row that
    # holds them — which is how "(synced)" stayed a promise for a year.
    user_id: str
    name: str
    # The mentor's institutional identity, as the roster holds it. Nullable for
    # the same reason it is on the leave form: the roster does not carry it for
    # every row, and the screen says "not on record" rather than inventing one.
    department: str | None
    designation: str | None
    # WHERE THEY ARE FILED, resolved through `users.department_id`.
    #
    # `department` above is free text and answers "what does the leave form
    # print". This answers "which department, and therefore which college, does
    # this person belong to" — a question the free-text line cannot answer,
    # because "DMS" and "Dept of Management Studies" are one department to a
    # reader and two to a GROUP BY. Students have carried this since
    # `students.cohort_id`; staff did not until now.
    placement: StaffPlacementOut = StaffPlacementOut()
    # settings.mentor_capacity — programme policy, not a per-mentor fact. The
    # assignment screen derives "N free" from it; nothing enforces it.
    capacity: int
    mentee_count: int
    mentees: list[MenteeMetricsOut]


#: The capability `mentor-load` is gated on, named once so the gate and the
#: scope that narrows it can never read two different grants.
#:
#: IT IS `admin.analytics`, AND THAT IS A DEFECT ON THE OWNER'S LIST rather
#: than a decision recorded here. The three screens of ONE workflow — see who
#: is loaded, see who is unassigned, assign somebody — are gated on two
#: different capabilities: this one on Analytics, `unassigned_students` and
#: `set_student_mentor` on `admin.mentors`. Scope makes that visible in a way
#: the bare capability check never did: a college admin granted Mentors &
#: students for their college can open the picker and perform the assignment
#: and cannot see the load board, while an Analytics grant reads the mentor map
#: — names, USNs, attendance — of everyone it reaches. Reconciling them is a
#: change to who holds what on a live deployment, which is the owner's call and
#: not this task's; naming the constant is what makes the disagreement one line
#: to fix rather than three greps.
MENTOR_LOAD_CAPABILITY = "admin.analytics"


def _student_department_expr():
    """The department a student sits in, in SQL: the batch's, else their own.

    The same precedence as `governance.ancestry_of_student` and
    `policies.Reach.student_ids` — the batch wins where there is one, the
    student's own pointer stands alone for an unseated student. Two lines of SQL
    repeated rather than a scope rule repeated: what may be seen is still
    decided once, in `scope_filter`; this only says where a row sits so an
    optional `?department_id=` can narrow WITHIN that answer.
    """
    batch = select(Cohort.department_id).where(Cohort.id == Student.cohort_id).scalar_subquery()
    return func.coalesce(batch, Student.department_id)


def _departments_of(db: Session, college_id: str) -> list[str]:
    return list(db.scalars(select(Department.id).where(Department.college_id == college_id)).all())


@router.get("/mentor-load", response_model=list[MentorLoadOut])
def mentor_load(
    response: Response,
    college_id: str | None = None,
    department_id: str | None = None,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[MentorLoadOut]:
    """Every FACULTY account this caller may see, with their assigned students
    and each student's three headline metrics.

    NOT "Main Admin only", which is what this docstring said and the code has
    never done: the gate is `MENTOR_LOAD_CAPABILITY`, a GRANTABLE capability, so
    any faculty account the Main Admin grants it reaches this endpoint. That
    sentence mattered while the answer was the whole programme either way; with
    B1.4 it is the difference between a screen and a data leak, and a docstring
    that names the wrong gate is how the next reader decides no scope is needed
    here.

    SCOPED (B1.4). Faculty rows come from `reach.user_ids()` and mentee rows
    from `reach.student_ids()`, both narrowed in SQL. Narrowing only the faculty
    would have been the more obvious half and the wrong one: a mentor group can
    span departments (see `cross_department`), so a college admin reading a
    faculty member inside their college would otherwise read that faculty
    member's mentees in a college they hold nothing for.

    `?college_id=` and `?department_id=` narrow WITHIN the reach and cannot
    widen it: they are applied as additional predicates over the reach's own, so
    asking for a department the caller does not hold returns no rows rather than
    somebody else's. Re-validation is the shape of the query rather than a
    second check that could one day disagree with the first.

    Every MENTOR-role user is a row, including one who has never been assigned
    a student: that is the account the Main Admin needs to see in order to
    assign one, and until then `mentor_id` is null and rule 2 shows them
    nobody. A faculty account is not a mentor by existing; it becomes one when
    the office hands it a student."""
    require_capability(db, session, MENTOR_LOAD_CAPABILITY)
    reach = scope_filter(db, session, MENTOR_LOAD_CAPABILITY)
    scope_header(response, reach)
    if reach.nothing:
        return []

    faculty_where = [User.role == Role.MENTOR, User.id.in_(reach.user_ids())]
    student_where = [Student.id.in_(reach.student_ids())]
    if department_id:
        faculty_where.append(User.department_id == department_id)
        student_where.append(_student_department_expr() == department_id)
    if college_id:
        in_college = _departments_of(db, college_id)
        faculty_where.append(User.department_id.in_(in_college))
        student_where.append(_student_department_expr().in_(in_college))

    mentors = db.execute(
        select(
            Mentor.id, User.id, User.name, User.department, User.designation,
            User.department_id,
        )
        .select_from(User)
        .outerjoin(Mentor, Mentor.user_id == User.id)
        .where(*faculty_where)
        .order_by(User.name)
    ).all()

    students = db.execute(
        select(
            Student.id, User.name, Student.usn, Student.current_stage, Student.mentor_id,
            _student_department_expr().label("department_id"),
        )
        .join(User, Student.user_id == User.id)
        .where(*student_where)
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

    # mentor_id -> the department that faculty account is filed under, so a
    # mentee row can be compared against it without a second query per pair.
    faculty_department = {mid: dept for mid, _uid, _n, _d, _g, dept in mentors if mid}

    def metrics(sid: str, name: str, usn, stage, mentor_id, department_id) -> MenteeMetricsOut:
        present, total = att.get(sid, (0, 0))
        mentor_department = faculty_department.get(mentor_id)
        return MenteeMetricsOut(
            student_id=sid,
            name=name,
            usn=usn,
            stage=stage.value if stage is not None and hasattr(stage, "value") else stage,
            attendance_percent=round(100 * present / total, 1) if total else None,
            verified_skills=skills.get(sid, 0),
            logged_hours=hours.get(sid, 0.0),
            # Both sides must resolve before this can be asserted — see the
            # field's own note. `and` rather than `!=` on two possibly-None
            # values, which would call every unfiled pair cross-department.
            cross_department=bool(
                department_id and mentor_department and department_id != mentor_department
            ),
        )

    by_mentor: dict[str, list[MenteeMetricsOut]] = {}
    for sid, name, usn, stage, mentor_id, department_id in students:
        if mentor_id:
            by_mentor.setdefault(mentor_id, []).append(
                metrics(sid, name, usn, stage, mentor_id, department_id)
            )

    # One query for every faculty member's placement, not one per row.
    placements = placements_for(db, [uid for _mid, uid, *_ in mentors])

    return [
        MentorLoadOut(
            mentor_id=mid,
            user_id=uid,
            name=name,
            department=department,
            designation=designation,
            placement=StaffPlacementOut.of(placements.get(uid, UNFILED)),
            capacity=settings.mentor_capacity,
            mentee_count=len(by_mentor.get(mid, [])),
            mentees=by_mentor.get(mid, []),
        )
        for mid, uid, name, department, designation, _department_id in mentors
    ]


class UnassignedStudentOut(BaseModel):
    student_id: str
    name: str
    usn: str | None
    stage: str | None


@router.get("/unassigned-students", response_model=list[UnassignedStudentOut])
def unassigned_students(
    response: Response,
    college_id: str | None = None,
    department_id: str | None = None,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[UnassignedStudentOut]:
    """Students with no mentor yet — the pool the assignment screen draws from.

    SCOPED (B1.4) by `admin.mentors`, the capability that gates it. `?department_id=`
    is the picker's default filter (B1.5): the assignment it feeds refuses a
    mentor from another COLLEGE outright, and offering the same-department pool
    first is how an admin stops proposing pairs the next screen will reject. It
    narrows within the reach and can never widen it — the two predicates are
    ANDed, so an id outside the caller's grant simply matches nothing.
    """
    require_capability(db, session, "admin.mentors")
    reach = scope_filter(db, session, "admin.mentors")
    scope_header(response, reach)
    if reach.nothing:
        return []
    where = [Student.mentor_id.is_(None), Student.id.in_(reach.student_ids())]
    if department_id:
        where.append(_student_department_expr() == department_id)
    if college_id:
        where.append(_student_department_expr().in_(_departments_of(db, college_id)))
    rows = db.execute(
        select(Student.id, User.name, Student.usn, Student.current_stage)
        .join(User, Student.user_id == User.id)
        .where(*where)
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
    # The faculty member's USER id, for one who has no `Mentor` row yet: the
    # assignment creates it. This is how a faculty account becomes a mentor -
    # by the Main Admin's act on the assignment screen, not by a flag at
    # account creation.
    mentor_user_id: str | None = None


def ensure_mentor_group(db: Session, faculty_user_id: str) -> str:
    """The `Mentor` row for a faculty account, created on first use.

    A faculty account with no group yet: the assignment is what makes them a
    mentor. The row is created here, once, and never for anyone who is not a
    MENTOR-role account - a student handed a group would be rule 2 edited by a
    form. ONE IMPLEMENTATION: the single assignment above and the batch action
    in admin_students.py both come through here.
    """
    faculty = db.get(User, faculty_user_id)
    if faculty is None or faculty.role is not Role.MENTOR:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not a faculty account.")
    group = db.scalar(select(Mentor).where(Mentor.user_id == faculty.id))
    if group is None:
        group = Mentor(user_id=faculty.id)
        db.add(group)
        db.flush()
    return group.id


def _college_of_student(db: Session, student_id: str) -> str | None:
    return dict(ancestry_of_student(db, student_id)).get(ScopeLevel.COLLEGE)


def _college_of_faculty(db: Session, user_id: str) -> str | None:
    return dict(ancestry_of_user(db, user_id)).get(ScopeLevel.COLLEGE)


def _assert_same_college(db: Session, student: Student, mentor_user_id: str) -> None:
    """B1.5. A mentor must be in the student's own college. 422 when they are not.

    422 rather than 403: the caller holds the capability and is allowed to make
    assignments — this particular pair is the thing that is wrong, and the
    message says which two institutions it spans so the admin can pick somebody
    else rather than go asking for a wider grant.

    IT REFUSES ONLY WHEN BOTH SIDES RESOLVE. An unfiled faculty account
    (`users.department_id IS NULL`, a first-class state the Faculty screen keeps
    a list of) and an unseated student both hang under no college, and "these
    two are in different colleges" is not something anybody can assert about
    such a pair. Refusing there would make filing a precondition for mentoring
    on a deployment that has not finished filing anyone — which is every
    deployment on the day the spine arrives — and the failure would read as the
    assign button being broken.

    THE COLLEGE, NOT THE DEPARTMENT. A cross-DEPARTMENT pair inside one college
    is ordinary and stays legal: the placement cell mentors across departments
    routinely, the picker merely offers same-department first, and
    `MenteeMetricsOut.cross_department` flags the ones that span. A college is
    the tenant, and a mentor in another tenant reading a student's marks,
    attendance and USN through rule 2 is the thing this refuses.
    """
    student_college = _college_of_student(db, student.id)
    mentor_college = _college_of_faculty(db, mentor_user_id)
    if not student_college or not mentor_college or student_college == mentor_college:
        return
    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail=(
            "A faculty member can only mentor students in their own college. "
            "This student and this faculty account are filed under different "
            "colleges — pick a faculty member from the student's college, or "
            "file the account under it first."
        ),
    )


@router.post("/students/{student_id}/mentor", status_code=status.HTTP_204_NO_CONTENT)
def set_student_mentor(
    student_id: str,
    body: AssignMentorIn,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> None:
    """Assign a student to a mentor, or release them.

    Deliberately not available to a MENTOR by role: mentor_id is what rule 2's
    scope gate filters on, so a mentor who could set it could assign themselves
    any student in the programme and then read everything about them. Who
    mentors whom is an administrative decision, not a mentoring one.

    SCOPED (B1.4/B1.2). The capability is checked twice and they are different
    questions: once bare, for "may you assign at all", and once with the
    STUDENT'S ancestry as `target`, for "may you assign THIS one". A college
    admin can move students inside their college and is refused one in another.
    The faculty member is checked the same way, because an assignment is a
    statement about two people: a grant that reaches the student and not the
    mentor would let a scoped admin hand a student to staff they hold nothing
    for.

    SAME COLLEGE (B1.5): `_assert_same_college`. Existing pairs are untouched —
    nothing here rewrites a row it was not asked to.

    AUDITED, with the previous mentor in `before`. "Who moved this student, and
    off whom" is the first question asked when a mentee disappears from a
    group, and until now the only record was the row itself, which by then
    holds the answer to neither.
    """
    require_capability(db, session, "admin.mentors")
    student = db.get(Student, student_id)
    if student is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")
    require_capability(
        db, session, "admin.mentors", target=ancestry_of_student(db, student_id)
    )
    mentor_id = body.mentor_id
    if mentor_id is None and body.mentor_user_id is not None:
        mentor_id = ensure_mentor_group(db, body.mentor_user_id)
    if mentor_id is not None and db.get(Mentor, mentor_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mentor not found.")

    if mentor_id is not None:
        faculty_user_id = db.scalar(select(Mentor.user_id).where(Mentor.id == mentor_id))
        if faculty_user_id:
            require_capability(
                db, session, "admin.mentors", target=ancestry_of_user(db, faculty_user_id)
            )
            _assert_same_college(db, student, faculty_user_id)

    before = student.mentor_id
    student.mentor_id = mentor_id
    record_change(
        db, session=session, request=request, tenant_id=None,
        entity_type="student", entity_id=student.id, action="MENTOR_ASSIGNED",
        before={"mentor_id": before}, after={"mentor_id": mentor_id},
        event_type="student.mentor.assigned",
        payload={"student_id": student.id, "mentor_id": mentor_id, "released": mentor_id is None},
    )
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
    require_capability(db, session, "admin.catalogue")
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
    require_capability(db, session, "admin.jobs")
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
    require_capability(db, session, "admin.jobs")
    try:
        level = DegreeLevel(body.degree_level.upper())
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Level must be PG or UG."
        )
    apply_url = (body.apply_url or "").strip() or None
    if apply_url and not apply_url.lower().startswith(("http://", "https://")):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
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
    require_capability(db, session, "admin.jobs")
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


def _modal_semester(db: Session, reach=None) -> int | None:
    """The semester most students are in, or None with no students. There is no
    programme-wide "current semester" row; the header says the one that holds
    for most of the cohort rather than inventing a setting for it.

    NARROWED BY THE CALLER'S REACH when one is given (B1.4): the modal semester
    of a department is a different number from the modal semester of the
    programme, and a scoped screen showing the programme's would be quietly
    describing students the reader cannot see. `reach=None` keeps the
    programme-wide answer for the callers that have not resolved one.
    """
    stmt = select(Student.current_semester, func.count())
    if reach is not None and not reach.everything:
        stmt = stmt.where(Student.id.in_(reach.student_ids()))
    row = db.execute(
        stmt.group_by(Student.current_semester)
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
    response: Response,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> AnalyticsSummaryOut:
    """The four tiles across the top of Programme analytics, in one call.

    SCOPED (B1.4). A count is a smaller leak than a list and it is still a leak:
    "your college has 41 students" told to somebody granted Analytics for one
    department of it is a number they can subtract. Every tile is narrowed
    through the SAME reach, so the percentages stay consistent with each other —
    a scoped numerator over a programme-wide denominator would draw a placement
    rate nobody can reproduce from any screen.

    THE MENTOR COUNT IS FACULTY, NOT GROUPS. It used to count `mentors` rows,
    which are groups; scoping it needs the account behind the group anyway, and
    counting accounts is what `mentees_per_mentor` has always divided by on
    every deployment where the two agree. They disagree only for a `Mentor` row
    whose user has been purged, which is a row `purge_people` removes.

    `B8.5`'s analytics SERIES endpoints do not exist yet. This is the only
    analytics route there is, so it is the only one there was to scope.
    """
    require_capability(db, session, "admin.analytics")
    reach = scope_filter(db, session, "admin.analytics")
    scope_header(response, reach)

    def count(stmt) -> int:
        return db.scalar(select(func.count()).select_from(stmt.subquery())) or 0

    if reach.nothing:
        return AnalyticsSummaryOut(
            students_total=0, pending_registrations=0, mentors_total=0,
            mentees_per_mentor=None, badges_awarded=0,
            evidence_awaiting_verification=0, placed_students=0,
            placement_percent=0.0, approved_offers=0, semester=None,
            generated_at=datetime.now(timezone.utc),
        )

    in_reach = Student.id.in_(reach.student_ids())
    total = count(select(Student.id).where(in_reach))
    pending_regs = count(
        select(Registration.id).where(
            Registration.status == RegistrationStatus.PENDING_REVIEW,
            registration_scope_clause(reach),
        )
    )
    mentors = count(
        select(User.id).where(User.role == Role.MENTOR, User.id.in_(reach.user_ids()))
    )
    assigned = count(select(Student.id).where(in_reach, Student.mentor_id.is_not(None)))
    badges = count(
        select(StudentBadge.id).where(
            StudentBadge.status == StudentBadgeStatus.EARNED,
            StudentBadge.student_id.in_(reach.student_ids()),
        )
    )
    awaiting = count(
        select(BadgeEvidence.id).where(
            BadgeEvidence.status == EvidenceStatus.PENDING_VERIFICATION,
            BadgeEvidence.student_id.in_(reach.student_ids()),
        )
    )
    approved_offers = count(
        select(PlacementOffer.id).where(
            PlacementOffer.status == OfferStatus.APPROVED,
            PlacementOffer.student_id.in_(reach.student_ids()),
        )
    )
    placed = (
        db.scalar(
            select(func.count(func.distinct(PlacementOffer.student_id))).where(
                PlacementOffer.status == OfferStatus.APPROVED,
                PlacementOffer.student_id.in_(reach.student_ids()),
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
        semester=_modal_semester(db, reach),
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
    what the analytics bar chart draws when a student arc is clicked.

    BOTH GATES, and it used to be one. `admin.analytics` is GRANTABLE: the Main
    Admin can hand the Analytics screen to a faculty member in Governance. This
    docstring said "Main Admin only (rule 2: they see all)" while the code
    checked the capability alone — so a MENTOR granted that screen could read
    ANY student's six-week attendance and ledger series by putting their id in
    the path, including students in another mentor's group.

    app/governance.py states the rule this broke: the capability decides WHICH
    SCREENS, `_assert_can_access_student` decides WHICH STUDENTS, "and a
    capability can never relax the student filter". The Main Admin still sees
    every student, because that is what the scope gate says for ADMIN; a granted
    mentor now sees their own.
    """
    require_capability(db, session, "admin.analytics")
    _assert_can_access_student(session, student_id, db)
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
            # f"{d.day}" rather than strftime("%-d"): the %-d directive is a
            # glibc extension. It renders "6 Sep" on Linux and raises
            # ValueError("Invalid format string") on Windows, so this endpoint
            # passed in CI and 500-ed on every developer machine. Guarded now by
            # tests/test_codebase_guards.py::test_no_platform_specific_strftime.
            WeekOut(
                label=f"{start.day} {start:%b}",
                start=start,
                end=start + timedelta(days=6),
            )
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
    egress gate does not apply.

    RULE 2 DOES, and it is now actually applied. This docstring already said "a
    mentor reading a mentee's resume would need the scope gate" — and the code
    checked only `admin.analytics`, which is grantable to a mentor. Any faculty
    member holding the Analytics screen could download any student's resume,
    with their contact details and academic record, by id.
    """
    require_capability(db, session, "admin.analytics")
    _assert_can_access_student(session, student_id, db)
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
    response: Response,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> PlacementOut:
    """The placement funnel and the recent offers.

    SCOPED (B1.4) through the student, which is the only route there is: an
    offer hangs on a `students` row and a `jobs` row, and JOBS CARRY NO
    INSTITUTION AT ALL (`app/models/job.py` has no college, department or course
    column and no join path to one). 04-backend-changes.md lists jobs among
    B1.4's scope targets and they cannot be one until B12.1 adds those columns;
    the posting sheet is therefore programme-wide on purpose and says so here
    rather than growing a column this task invented.

    The funnel's stages are all narrowed by one reach, so the ratios between
    them stay readable. `top_recruiters` counts only offers inside it, which
    means a scoped reader sees the recruiters OF THEIR OWN students — the
    question that screen is asked.
    """
    require_capability(db, session, "admin.placement")
    reach = scope_filter(db, session, "admin.placement")
    scope_header(response, reach)
    if reach.nothing:
        return PlacementOut(
            semester=None, eligible=0, applied=0, offers=0, approved=0,
            approved_students=0, recent=[], top_recruiters=[],
        )
    submitted = PlacementOffer.status != OfferStatus.DRAFT
    mine = PlacementOffer.student_id.in_(reach.student_ids())

    eligible = (
        db.scalar(
            select(func.count())
            .select_from(Student)
            .where(Student.id.in_(reach.student_ids()))
        )
        or 0
    )
    applied = (
        db.scalar(
            select(func.count(func.distinct(JobApplication.student_id))).where(
                JobApplication.student_id.in_(reach.student_ids())
            )
        )
        or 0
    )
    offers = (
        db.scalar(select(func.count()).select_from(PlacementOffer).where(submitted, mine)) or 0
    )
    approved = (
        db.scalar(
            select(func.count())
            .select_from(PlacementOffer)
            .where(PlacementOffer.status == OfferStatus.APPROVED, mine)
        )
        or 0
    )
    approved_students = (
        db.scalar(
            select(func.count(func.distinct(PlacementOffer.student_id))).where(
                PlacementOffer.status == OfferStatus.APPROVED, mine
            )
        )
        or 0
    )
    recent = db.execute(
        select(PlacementOffer, User.name, Student.usn)
        .join(Student, PlacementOffer.student_id == Student.id)
        .join(User, Student.user_id == User.id)
        .where(submitted, mine)
        .order_by(PlacementOffer.created_at.desc())
        .limit(RECENT_OFFERS)
    ).all()
    recruiters = db.execute(
        select(PlacementOffer.organisation, func.count())
        .where(PlacementOffer.status == OfferStatus.APPROVED, mine)
        .group_by(PlacementOffer.organisation)
        .order_by(func.count().desc(), PlacementOffer.organisation)
        .limit(10)
    ).all()
    return PlacementOut(
        semester=_modal_semester(db, reach),
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
def badge_catalogue(session: dict = Depends(get_current_session), db: Session = Depends(get_db)) -> list[BadgeCatalogueOut]:
    """The 48-badge catalogue (code, not rows — see models/badge.py), so the
    Approved Certification form can offer the badge a certification maps to.
    No database read; the gate is here because the catalogue's points are what
    the Certifications table shows and that table is a Main Admin screen."""
    require_capability(db, session, "admin.catalogue")
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


# --- exports (B14) ----------------------------------------------------------
#
# Three extracts, one set of rules, and none of the rules live here: see
# app/exports.py for scope, the personal-column test and the receipt. What this
# section owns is which columns each file has and which of them name a person.


@router.get("/exports/students.csv")
def export_students_csv(
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> Response:
    """Admitted students with their stage, semester, cohort and mentor — the
    "registrations & mentor map" a placement office forwards.

    SCOPED (B1.4/B14). It used to select every `students` row on the
    deployment, so an `admin.exports` grant scoped to one department downloaded
    the other department's roster — the widest possible failure of the
    narrowest possible grant, on the one endpoint whose output cannot be
    recalled.
    """
    require_capability(db, session, "admin.exports")
    reach = scope_filter(db, session, "admin.exports")
    carried_pii = carries_personal_columns(db, session)

    mentor_name = {
        mid: name
        for mid, name in db.execute(
            select(Mentor.id, User.name).join(User, Mentor.user_id == User.id)
        ).all()
    }
    cohort_name = dict(db.execute(select(Cohort.id, Cohort.name)).all())
    rows = (
        []
        if reach.nothing
        else db.execute(
            select(Student, User.name)
            .join(User, Student.user_id == User.id)
            .where(Student.id.in_(reach.student_ids()))
            .order_by(User.name)
        ).all()
    )
    header, body = drop_personal(
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
        # The mentor's name stays. It is a member of staff acting in their
        # professional role on a map of who mentors whom — which is the whole
        # subject of this file — and dropping it would leave a spreadsheet of
        # anonymous students assigned to anonymous mentors, useful to nobody.
        ["Name", "USN"],
        carry=carried_pii,
    )
    record_export(
        db, session=session, request=request, kind="students",
        filters=scope_note(reach), rows=len(body), carried_pii=carried_pii,
    )
    return csv_response(
        header, body, "reep-students-mentor-map.csv",
        reach=reach, carried_pii=carried_pii,
    )


@router.get("/exports/placement.csv")
def export_placement_csv(
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> Response:
    """Every submitted offer: student, company, role, CTC and the decision."""
    require_capability(db, session, "admin.exports")
    reach = scope_filter(db, session, "admin.exports")
    carried_pii = carries_personal_columns(db, session)

    query = (
        select(PlacementOffer, User.name, Student.usn)
        .join(Student, PlacementOffer.student_id == Student.id)
        .join(User, Student.user_id == User.id)
        .where(PlacementOffer.status != OfferStatus.DRAFT)
        .order_by(PlacementOffer.created_at.desc())
    )
    if not reach.everything:
        query = query.where(Student.id.in_(reach.student_ids()))
    rows = [] if reach.nothing else db.execute(query).all()

    header, body = drop_personal(
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
        ["Student", "USN"],
        carry=carried_pii,
    )
    record_export(
        db, session=session, request=request, kind="placement",
        filters=scope_note(reach), rows=len(body), carried_pii=carried_pii,
    )
    return csv_response(
        header, body, "reep-placement-summary.csv",
        reach=reach, carried_pii=carried_pii,
    )


@router.get("/exports/ledger.csv")
def export_ledger_csv(
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> Response:
    """Time Allocation Ledger compliance per student: days logged, days
    submitted, hours entered and the productive share (lectures, coursework,
    skilling — the same three heads the student's own metrics strip counts).

    THE ONE EXTRACT THAT IS STILL WORTH READING WITHOUT NAMES, which is the
    argument for the whole personal-column rule: "42 students logged 6 days and
    submitted 2" is a compliance question, and it is answerable from the
    redacted file.
    """
    require_capability(db, session, "admin.exports")
    reach = scope_filter(db, session, "admin.exports")
    carried_pii = carries_personal_columns(db, session)

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
    rows = (
        []
        if reach.nothing
        else db.execute(
            select(Student, User.name)
            .join(User, Student.user_id == User.id)
            .where(Student.id.in_(reach.student_ids()))
            .order_by(User.name)
        ).all()
    )
    out: list[list[object]] = []
    for s, name in rows:
        logged, submitted = days.get(s.id, (0, 0))
        total_h, productive_h = hours.get(s.id, (0, 0))
        out.append([name, s.usn or "", logged, submitted, total_h / 2, productive_h / 2])
    header, body = drop_personal(
        ["Name", "USN", "Days logged", "Days submitted", "Hours logged", "Productive hours"],
        out,
        ["Name", "USN"],
        carry=carried_pii,
    )
    record_export(
        db, session=session, request=request, kind="ledger",
        filters=scope_note(reach), rows=len(body), carried_pii=carried_pii,
    )
    return csv_response(
        header, body, "reep-ledger-compliance.csv",
        reach=reach, carried_pii=carried_pii,
    )


class ExportEventOut(BaseModel):
    id: str
    kind: str
    at: datetime
    rows: int
    carried_pii: bool
    filters: dict
    #: The account that downloaded it. Never null on a fresh row; null once that
    #: account has been deleted, because the FK is ON DELETE SET NULL — the
    #: export still happened and the history must not lose the fact of it just
    #: because the person left.
    by_user_id: str | None
    by_name: str | None


class ExportHistoryOut(BaseModel):
    """The receipts, and the reach of the person reading them.

    `scope` IS IN THIS BODY and in no other export response, and that is not an
    inconsistency: this is the one B14 endpoint that returns JSON. The three
    CSVs state the same fact in response headers, because a JSON envelope around
    a CSV is not a CSV (app/exports.py says so at more length).
    """

    scope: dict
    events: list[ExportEventOut]


@router.get("/exports/history", response_model=ExportHistoryOut)
def export_history(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
    limit: int = 100,
) -> ExportHistoryOut:
    """Who has taken what out of the building (B14).

    WHO SEES WHOSE. A holder whose Exports grant covers the programme sees every
    receipt — that is the office, and the whole point of a receipt is that
    somebody else reads it. A NARROWED holder sees only their own downloads.
    That is not a scope filter in the usual sense, because an `export_events`
    row hangs under an account rather than under a student and has no ancestry
    to test; the honest narrowing is "you may audit what you can reach, and a
    department-scoped grant does not reach the office's downloads".
    """
    require_capability(db, session, "admin.exports")
    reach = scope_filter(db, session, "admin.exports")
    query = (
        select(ExportEvent, User.name)
        .outerjoin(User, ExportEvent.user_id == User.id)
        .order_by(ExportEvent.at.desc())
        .limit(max(1, min(limit, 500)))
    )
    if not reach.everything:
        query = query.where(ExportEvent.user_id == session.get("userId"))
    return ExportHistoryOut(
        scope=scope_note(reach),
        events=[
            ExportEventOut(
                id=row.id,
                kind=row.kind,
                at=row.at,
                rows=row.rows,
                carried_pii=bool(row.carried_pii),
                filters=row.filters or {},
                by_user_id=row.user_id,
                by_name=name,
            )
            for row, name in db.execute(query).all()
        ],
    )
