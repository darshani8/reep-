"""Student self-service endpoints. First slice: read your own profile."""

import threading
import time

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import bindparam, func, select
from sqlalchemy.orm import Session

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from ..ai.llm import complete_chat, llm_config, student_data_egress_allowed
from ..db import get_db
from ..identity import get_current_session
from ..document_store import (
    MAX_BYTES,
    MAX_UPLOAD_BYTES_PER_STUDENT,
    MAX_UPLOADS_PER_STUDENT,
    UploadRejected,
    content_disposition,
    delete as document_store_delete,
    read_bytes,
    VolumeQuota,
    QuotaRejected,
    save_bytes,
)
from ..resume_pdf import EvidenceProof, append_evidence, render_resume_pdf
from ..models.academic_history import AcademicGap, AcademicQualification
from ..models.academics import SemesterResult
from ..models.attendance import AttendanceRecord
from ..models.certification import Certification, CertificationProgress
from ..models.cohort import Cohort
from ..models.institution import AcademicCourse, AcademicSpecialization, College, Department
from ..models.course import Course, Enrollment, ProgressStatus
from ..models.job import Job, JobApplication
from ..models.lab import ActivityType, CheckInSource, LabSession, LearningMode
from ..models.mock_test import MockAttempt
from ..models.offer import (
    OfferChannel,
    OfferRoleType,
    OfferStatus,
    OfferWorkMode,
    PlacementOffer,
)
from ..models.placement_criteria import PlacementCriteria
from ..models.student_profile import StudentProfile
from ..models.resume import Resume, ResumeStatus
from ..models.schedule import ScheduleItem
from ..models.skill import Skill, SkillClaim, StudentSkill
from ..models.swoc import SwocEntry
from ..models.resume_profile import ResumeProfile
from ..models.timesheet import DayActivity, TimeSheetEntry
from ..models.upload import Upload, UploadKind, UploadStatus
from ..models.user import LoginDay, Mentor, Student, User
from ..ratelimit import llm_rate_limited

router = APIRouter(prefix="/student", tags=["student"])


class InstitutionLevelOut(BaseModel):
    """One row of the locked card, with its STATE — because a blank means two
    different things and the card must not confuse them.

    `set`         the level has a value; render label + value.
    `pending`     the level is expected and this student does not have it yet.
                  Render a dash AND the words "Not yet recorded" — text and
                  colour together, never colour alone. Something to chase.
    `not_in_use`  the level is optional and this institution does not use it.
                  Nothing is pending and nobody should chase it. The card HIDES
                  the row and then SAYS what was hidden, once, in
                  `not_in_use_note` — because a silently omitted row is the
                  confident blank the English-baseline rule forbids, while a
                  row omitted and counted in a sentence is stated, not blank.

    Rendering a not-in-use level as a dash would tell the student their record
    is incomplete when it is complete: a false pending, the mirror image of a
    confident zero. Both lie about state. Only the server can tell them apart,
    because only it knows the switch (HIERARCHY_LEVELS) and the chain.
    """

    key: str
    label: str
    value: str | None
    state: str  # "set" | "pending" | "not_in_use"


class InstitutionOut(BaseModel):
    """The locked "Institutional assignment — verified by Main Admin" card.

    EVERY FLAT FIELD IS NULLABLE, and that is the contract rather than laziness.
    The card is read through `students.cohort_id -> cohorts -> ...`, and any
    hop in that chain may legitimately be unset: a student is provisioned
    before an admin seats them, `cohorts` predates `departments` so older
    batches have no department, and the two optional levels are optional. A
    missing value is never defaulted and never invented — the same rule the
    English baseline follows for a pending score, and for the same reason: an
    invented institution on a screen headed "verified by Main Admin" is worse
    than an honest blank.

    `levels` is what the card actually renders, in the server's order with the
    server's labels (typed once, in HIERARCHY_LEVELS) — so the client never
    names a level, and the next level insertion costs it nothing. The flat
    fields stay for anything that reads them by name.

    STUDENTS CANNOT WRITE THESE. `update_profile` refuses them; the card says
    "Locked — not editable by students" and the API is what makes that true.
    """

    college_name: str | None
    college_code: str | None
    department_name: str | None
    course_name: str | None
    specialization_name: str | None
    batch_label: str | None
    entry_date: date | None
    expected_completion: date | None
    levels: list[InstitutionLevelOut]
    not_in_use_note: str | None


#: ONE round trip, not a chain of db.get() calls. The first version walked
#: Cohort -> Department -> College as three sequential queries on
#: GET /api/student/profile — the app's hottest endpoint — and extending that
#: pattern to five levels would have made it five. Every join here is LEFT
#: OUTER on a primary key: a level the admin never filled yields NULL for its
#: columns and drops nothing, which is `_institution_for`'s promise ("walks as
#: far as the data allows") written as SQL instead of as four early returns.
#:
#: The joins are FLAT, each hanging off `cohorts`, not chained through one
#: another. That is what the ancestor pointers on `cohorts` buy: a batch
#: attached at department level with no specialization still resolves its
#: department and college, where a chain spec -> course -> department would
#: have yielded NULL for all three.
_INSTITUTION_Q = (
    select(
        College.name.label("college_name"),
        College.code.label("college_code"),
        Department.name.label("department_name"),
        AcademicCourse.name.label("course_name"),
        AcademicSpecialization.name.label("specialization_name"),
        Cohort.batch_label.label("batch_label"),
        Cohort.start_date.label("start_date"),
        Cohort.end_date.label("end_date"),
    )
    .select_from(Cohort)
    .join(Department, Department.id == Cohort.department_id, isouter=True)
    .join(College, College.id == Department.college_id, isouter=True)
    .join(AcademicCourse, AcademicCourse.id == Cohort.course_id, isouter=True)
    .join(
        AcademicSpecialization,
        AcademicSpecialization.id == Cohort.specialization_id,
        isouter=True,
    )
    .where(Cohort.id == bindparam("cohort_id"))
)

#: The same two top levels reached WITHOUT a batch (31f7a4c60b12).
#:
#: College and Department are required at registration while Course,
#: Specialization and Batch are not, so "named a department, seated in nothing"
#: is the normal state of a college that has not built its batches yet. Before
#: `students.department_id` existed there was no query that could answer it and
#: the card came back blank.
#:
#: INNER on college, because `departments.college_id` is NOT NULL — a department
#: without a college cannot exist, so an outer join here would only invent a
#: half-resolved row that no caller knows how to render.
_DEPARTMENT_Q = (
    select(
        College.name.label("college_name"),
        College.code.label("college_code"),
        Department.name.label("department_name"),
    )
    .select_from(Department)
    .join(College, College.id == Department.college_id)
    .where(Department.id == bindparam("department_id"))
)

#: The fixed levels either side of the optional ones, in card order. These are
#: not in HIERARCHY_LEVELS because they are not switchable: a batch always
#: belongs to a department in a college. Their labels are the design's.
_FIXED_UPPER = (("college", "College"), ("department", "Department"))
_FIXED_LOWER = (("batch", "Batch"),)


def _join_names(names: list[str]) -> str:
    """"A", "A and B", "A, B and C". Grammar assembled here, once, rather than
    in a template that ends up reading "Course, and ."."""
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]


def _compose_levels(values: dict[str, str | None], seated: bool) -> tuple[list[InstitutionLevelOut], str | None]:
    """Turn a flat name-per-level dict into the card's rows and its footnote.

    `seated` distinguishes "no cohort at all" (every level pending — the admin
    has not seated this student) from "seated in a batch that does not use a
    level" (that level is not in use). The switch decides the second case: a
    level flipped to required is `pending` when blank, because the admin now
    owes it; a level still optional is `not_in_use`.
    """
    from ..models import institution as institution_model

    rows: list[InstitutionLevelOut] = []
    not_in_use: list[str] = []

    def add(key: str, label: str, value: str | None, optional: bool) -> None:
        if value is not None:
            state = "set"
        elif not seated or not optional:
            state = "pending"
        else:
            state = "not_in_use"
            not_in_use.append(label)
        rows.append(InstitutionLevelOut(key=key, label=label, value=value, state=state))

    for key, label in _FIXED_UPPER:
        add(key, label, values.get(key), optional=False)
    for lv in institution_model.HIERARCHY_LEVELS:
        add(lv.key, lv.label, values.get(lv.key), optional=not lv.required)
    for key, label in _FIXED_LOWER:
        add(key, label, values.get(key), optional=False)

    note = None
    if not_in_use:
        where = values.get("college_code") or "this college"
        verb = "is" if len(not_in_use) == 1 else "are"
        note = f"{_join_names(not_in_use)} {verb} not used at {where}."
    return rows, note


def _empty_institution() -> InstitutionOut:
    levels, _ = _compose_levels({}, seated=False)
    return InstitutionOut(
        college_name=None,
        college_code=None,
        department_name=None,
        course_name=None,
        specialization_name=None,
        batch_label=None,
        entry_date=None,
        expected_completion=None,
        levels=levels,
        not_in_use_note=None,
    )


def _department_only(db: Session, department_id: str | None) -> InstitutionOut | None:
    """The card for a student placed by department alone, or None if unplaced.

    Two levels resolve (College, Department) and the rest read `pending`, which
    is the honest word: the admin owes this student a batch. `seated=False` is
    what produces that — a level left blank on a student with no batch is work
    outstanding, never "not in use at this college".
    """
    if not department_id:
        return None
    row = db.execute(_DEPARTMENT_Q, {"department_id": department_id}).mappings().first()
    if row is None:  # department_id names a department that is gone
        return None
    values = {
        "college": row["college_name"],
        "college_code": row["college_code"],
        "department": row["department_name"],
    }
    levels, note = _compose_levels(values, seated=False)
    return InstitutionOut(
        college_name=row["college_name"],
        college_code=row["college_code"],
        department_name=row["department_name"],
        course_name=None,
        specialization_name=None,
        batch_label=None,
        # The two dates belong to the BATCH, and there is no batch.
        entry_date=None,
        expected_completion=None,
        levels=levels,
        not_in_use_note=note,
    )


def _institution_for(db: Session, stu: Student | None) -> InstitutionOut:
    """Resolve the student's institutional assignment.

    TWO POINTERS, tried deepest first. `cohort_id` resolves all five levels; if
    there is no batch — or the batch is gone, or the batch was never filed under
    a department — `students.department_id` still places the student in a
    college and a department (31f7a4c60b12). Before that column existed this
    returned an empty card for every unseated student, which is every student at
    a college that has not built its batches, even though the registration form
    had REQUIRED them to name a department.

    Walks as far as the data allows and stops without complaint: nulls rather
    than a 404. The card is one block on a screen that has plenty else to show.
    """
    if stu is None:
        return _empty_institution()
    row = (
        db.execute(_INSTITUTION_Q, {"cohort_id": stu.cohort_id}).mappings().first()
        if stu.cohort_id
        else None
    )
    if row is None:  # no batch, or cohort_id names a cohort that is gone
        return _department_only(db, stu.department_id) or _empty_institution()
    if row["department_name"] is None:
        # A batch nobody filed under a department. The student's own pointer is
        # allowed to stand alone in exactly this case (see
        # `student_placement.resolve_student_department`), so prefer the fuller
        # card over printing a blank Department beside a real batch.
        by_department = _department_only(db, stu.department_id)
        if by_department is not None:
            row = dict(row) | {
                "college_name": by_department.college_name,
                "college_code": by_department.college_code,
                "department_name": by_department.department_name,
            }
    values = {
        "college": row["college_name"],
        "college_code": row["college_code"],
        "department": row["department_name"],
        "course": row["course_name"],
        "specialization": row["specialization_name"],
        "batch": row["batch_label"],
    }
    levels, note = _compose_levels(values, seated=True)
    return InstitutionOut(
        college_name=row["college_name"],
        college_code=row["college_code"],
        department_name=row["department_name"],
        course_name=row["course_name"],
        specialization_name=row["specialization_name"],
        batch_label=row["batch_label"],
        # The two dates belong to the BATCH, not the student — which is what the
        # design shows, and why they are not columns on `students`.
        entry_date=row["start_date"].date() if row["start_date"] else None,
        expected_completion=row["end_date"].date() if row["end_date"] else None,
        levels=levels,
        not_in_use_note=note,
    )


class ProfileOut(BaseModel):
    student_id: str
    # Identity, synced from the programme's student record and read-only on the
    # profile screen. Additive fields on an existing response: the v2 UI's
    # sidebar profile card and the profile screen's locked "Identity" block both
    # need them, and the SESSION cannot carry them — its claims are fixed by
    # contract (AGENTS.md: the require_* dependencies read the same payload the
    # Node app minted and were not changed), so widening the cookie to please a
    # sidebar is exactly the change that must not happen.
    usn: str | None
    full_name: str | None
    current_semester: int
    current_stage: str
    phone: str | None
    email: str | None
    linkedin_url: str | None
    github_url: str | None
    portfolio_url: str | None
    city: str | None
    career_summary: str | None
    placement_eligible: bool
    interested_in_jobs: bool
    interested_in_internships: bool
    education: list
    experience: list
    projects: list
    skills: list
    achievements: list
    leaderboard_opt_out: bool
    # Read-only, resolved through the cohort join. See InstitutionOut.
    institution: InstitutionOut
    # The assigned faculty mentor's name, or None when nobody is assigned yet.
    #
    # The Resume Builder's References step offers "add your mentor as a referee"
    # in one click, and it used to offer a HARD-CODED name — a person who does
    # not work here — which a student could put on a document a recruiter then
    # calls. A referee has to be the real one or there must be no button, and
    # the client cannot know which without being told. None here is what turns
    # that card off.
    mentor_name: str | None = None


@router.get("/profile", response_model=ProfileOut)
def my_profile(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> ProfileOut:
    student_id = session.get("studentId")
    if not student_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Not a student account."
        )
    prof = db.scalar(select(StudentProfile).where(StudentProfile.student_id == student_id))
    if prof is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No profile yet.")
    return _profile_out(db, prof)


class SubjectMarkOut(BaseModel):
    subject_code: str
    subject_name: str
    credits: int
    internal: int
    external: int
    total: int
    passed: bool


class SemesterResultOut(BaseModel):
    semester: int
    sgpa: float | None
    cgpa: float | None
    closed_backlogs: int
    live_backlogs: int
    result_class: str | None
    subjects: list[SubjectMarkOut]


def _require_student(session: dict) -> str:
    student_id = session.get("studentId")
    if not student_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a student account.")
    return student_id


@router.get("/results", response_model=list[SemesterResultOut])
def my_results(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[SemesterResultOut]:
    student_id = _require_student(session)
    rows = db.scalars(
        select(SemesterResult)
        .where(SemesterResult.student_id == student_id)
        .order_by(SemesterResult.semester)
    ).all()
    return [
        SemesterResultOut(
            semester=r.semester,
            sgpa=r.sgpa,
            cgpa=r.cgpa,
            closed_backlogs=r.closed_backlogs,
            live_backlogs=r.live_backlogs,
            result_class=r.result_class,
            subjects=[
                SubjectMarkOut(
                    subject_code=s.subject_code,
                    subject_name=s.subject_name,
                    credits=s.credits,
                    internal=s.internal,
                    external=s.external,
                    total=s.total,
                    passed=s.passed,
                )
                for s in r.subjects
            ],
        )
        for r in rows
    ]


class CourseAttendanceOut(BaseModel):
    course_code: str
    present: int
    total: int
    percent: float


class AttendanceSummaryOut(BaseModel):
    overall_percent: float
    present: int
    total: int
    by_course: list[CourseAttendanceOut]


@router.get("/attendance", response_model=AttendanceSummaryOut)
def my_attendance(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> AttendanceSummaryOut:
    student_id = _require_student(session)
    rows = db.execute(
        select(AttendanceRecord.course_code, AttendanceRecord.present).where(
            AttendanceRecord.student_id == student_id
        )
    ).all()

    per_course: dict[str, list[int]] = defaultdict(lambda: [0, 0])  # code -> [present, total]
    present_total = grand_total = 0
    for course_code, present in rows:
        per_course[course_code][1] += 1
        grand_total += 1
        if present:
            per_course[course_code][0] += 1
            present_total += 1

    def pct(p: int, t: int) -> float:
        return round(100 * p / t, 1) if t else 0.0

    by_course = [
        CourseAttendanceOut(course_code=code, present=p, total=t, percent=pct(p, t))
        for code, (p, t) in sorted(per_course.items())
    ]
    return AttendanceSummaryOut(
        overall_percent=pct(present_total, grand_total),
        present=present_total,
        total=grand_total,
        by_course=by_course,
    )


class DashboardOut(BaseModel):
    name: str
    usn: str | None
    current_stage: str
    current_semester: int
    latest_cgpa: float | None
    attendance_percent: float


@router.get("/dashboard", response_model=DashboardOut)
def dashboard(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> DashboardOut:
    """One call for the landing page: REEP stage, latest CGPA, and attendance %."""
    student_id = _require_student(session)
    stu = db.get(Student, student_id)
    if stu is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")

    latest = db.scalar(
        select(SemesterResult)
        .where(SemesterResult.student_id == student_id)
        .order_by(SemesterResult.semester.desc())
        .limit(1)
    )
    att = db.execute(
        select(AttendanceRecord.present).where(AttendanceRecord.student_id == student_id)
    ).all()
    total = len(att)
    present = sum(1 for (p,) in att if p)

    return DashboardOut(
        name=session.get("name", ""),
        usn=stu.usn,
        current_stage=stu.current_stage.value,
        current_semester=stu.current_semester,
        latest_cgpa=latest.cgpa if latest else None,
        attendance_percent=round(100 * present / total, 1) if total else 0.0,
    )


@router.get("/overview")
def overview(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> dict:
    """Everything the landing page shows, in ONE request and ONE DB session.

    The Angular overview screen used to fire its ten GETs in a Promise.all —
    an 11-request volley (plus /auth/me) per view, each request taking its own
    threadpool slot and pooled connection, so TWO students landing at once
    already wanted more connections than the old pool had (2026-08 audit). The
    ten handlers are unchanged and still individually routed — sibling screens
    and older clients keep working — this endpoint simply composes them
    sequentially on this request's session: one connection, ten queries'
    worth of work, one JSON document.

    Keys mirror the client's destructuring, not the route paths, so the
    component's `load()` is a one-line change. Any handler's HTTPException
    (e.g. the 404 for a session that outlived its Student row) propagates for
    the whole document: a landing page for a student who no longer exists has
    no partial answer worth assembling.
    """
    return {
        "dashboard": dashboard(session, db),
        "attendance": my_attendance(session, db),
        "results": my_results(session, db),
        "streak": my_streak(session, db),
        "swoc": my_swoc(session, db),
        "mocks": my_mocks(session, db),
        "skills": my_skills(session, db),
        "next_actions": next_actions(session, db),
        "placement_readiness": placement_readiness(session, db),
        "recommendations": recommendations(session, db),
        # The landing's Academic History block (10th / 12th / UG cards and the
        # declared education gaps). Same reasoning as the ten above: the landing
        # already needs this document, and a separate GET per view is the
        # volley this endpoint exists to avoid.
        "academics": my_academics(session, db),
    }


class SwocItemOut(BaseModel):
    source: str
    text: str
    weight: int


class SwocBoardOut(BaseModel):
    strengths: list[SwocItemOut]
    weaknesses: list[SwocItemOut]
    opportunities: list[SwocItemOut]
    challenges: list[SwocItemOut]


@router.get("/swoc", response_model=SwocBoardOut)
def my_swoc(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> SwocBoardOut:
    student_id = _require_student(session)
    rows = db.scalars(
        select(SwocEntry)
        .where(SwocEntry.student_id == student_id)
        .order_by(SwocEntry.weight.desc())
    ).all()
    buckets: dict[str, list[SwocItemOut]] = {
        "STRENGTH": [],
        "WEAKNESS": [],
        "OPPORTUNITY": [],
        "CHALLENGE": [],
    }
    for r in rows:
        buckets[r.kind.value].append(
            SwocItemOut(source=r.source.value, text=r.text, weight=r.weight)
        )
    return SwocBoardOut(
        strengths=buckets["STRENGTH"],
        weaknesses=buckets["WEAKNESS"],
        opportunities=buckets["OPPORTUNITY"],
        challenges=buckets["CHALLENGE"],
    )


class MockAttemptOut(BaseModel):
    type: str
    taken_on: datetime
    score: float | None
    max_score: float | None
    percent: float | None
    notes: str | None


@router.get("/mocks", response_model=list[MockAttemptOut])
def my_mocks(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[MockAttemptOut]:
    student_id = _require_student(session)
    rows = db.scalars(
        select(MockAttempt)
        .where(MockAttempt.student_id == student_id)
        .order_by(MockAttempt.taken_on.desc())
    ).all()
    return [
        MockAttemptOut(
            type=r.type.value,
            taken_on=r.taken_on,
            score=r.score,
            max_score=r.max_score,
            percent=(
                round(100 * r.score / r.max_score, 1)
                if (r.score is not None and r.max_score)
                else None
            ),
            notes=r.notes,
        )
        for r in rows
    ]


class StudentSkillOut(BaseModel):
    slug: str
    name: str
    category: str
    level: int
    verified: bool
    # The upload the mentor verified this against, when there is one. The resume
    # builder's "View proof" needs it: a verified skill the student cannot open
    # the evidence for is an assertion, not a citation.
    evidence_upload_id: str | None = None


@router.get("/skills", response_model=list[StudentSkillOut])
def my_skills(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[StudentSkillOut]:
    student_id = _require_student(session)
    rows = db.scalars(
        select(StudentSkill).where(StudentSkill.student_id == student_id)
    ).all()
    out = [
        StudentSkillOut(
            slug=r.skill.slug,
            name=r.skill.name,
            category=r.skill.category,
            level=r.level,
            verified=r.verified,
            evidence_upload_id=r.evidence_upload_id,
        )
        for r in rows
    ]
    # Grouped by category, strongest first within each.
    return sorted(out, key=lambda s: (s.category, -s.level))


class SkillCatalogueOut(BaseModel):
    id: str
    slug: str
    name: str
    category: str


@router.get("/skills/catalogue", response_model=list[SkillCatalogueOut])
def skills_catalogue(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[SkillCatalogueOut]:
    """The full skill catalogue — what a student picks from when filing a claim."""
    _require_student(session)
    rows = db.scalars(select(Skill).order_by(Skill.category, Skill.name)).all()
    return [
        SkillCatalogueOut(id=s.id, slug=s.slug, name=s.name, category=s.category) for s in rows
    ]


class StreakOut(BaseModel):
    current: int
    longest: int
    days_active: int
    last_active: date | None


@router.get("/streak", response_model=StreakOut)
def my_streak(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> StreakOut:
    """Login streak from LoginDay (one row per active day). Current counts back
    from today (or yesterday, so an as-yet-unopened today doesn't break it)."""
    days = sorted(
        set(db.scalars(select(LoginDay.day).where(LoginDay.user_id == session["userId"])).all())
    )
    if not days:
        return StreakOut(current=0, longest=0, days_active=0, last_active=None)

    longest = run = 1
    for prev, cur in zip(days, days[1:]):
        run = run + 1 if cur - prev == timedelta(days=1) else 1
        longest = max(longest, run)

    today = date.today()
    current = 0
    if days[-1] in (today, today - timedelta(days=1)):
        current = 1
        i = len(days) - 1
        while i > 0 and days[i] - days[i - 1] == timedelta(days=1):
            current += 1
            i -= 1

    return StreakOut(
        current=current, longest=longest, days_active=len(days), last_active=days[-1]
    )


class TimeSheetEntryOut(BaseModel):
    day: date
    activity: str
    minutes: int


class TimeSheetSummaryOut(BaseModel):
    window_days: int
    by_activity_minutes: dict[str, int]
    skilling_hours: float
    weekly_hour_target: float
    entries: list[TimeSheetEntryOut]


@router.get("/timesheet", response_model=TimeSheetSummaryOut)
def my_timesheet(
    days: int = 7,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> TimeSheetSummaryOut:
    """The self-learning time log over the last `days`, with per-activity totals
    and the SKILLING-hours-vs-target the chart draws."""
    student_id = _require_student(session)
    window = max(1, min(days, 90))
    since = date.today() - timedelta(days=window - 1)
    rows = db.scalars(
        select(TimeSheetEntry)
        .where(TimeSheetEntry.student_id == student_id, TimeSheetEntry.day >= since)
        .order_by(TimeSheetEntry.day)
    ).all()

    by_activity: dict[str, int] = {}
    for r in rows:
        by_activity[r.activity.value] = by_activity.get(r.activity.value, 0) + r.minutes

    stu = db.get(Student, student_id)
    return TimeSheetSummaryOut(
        window_days=window,
        by_activity_minutes=by_activity,
        skilling_hours=round(by_activity.get("SKILLING", 0) / 60, 1),
        weekly_hour_target=stu.weekly_hour_target if stu else 12.0,
        entries=[
            TimeSheetEntryOut(day=r.day, activity=r.activity.value, minutes=r.minutes) for r in rows
        ],
    )


class QualificationOut(BaseModel):
    level: str
    institution: str
    board: str | None
    year: int
    marks: float
    max_marks: float
    percent: float
    medium: str | None
    location: str | None
    subjects: str | None


class AcademicGapOut(BaseModel):
    twelfth_to_grad_mo: int
    diploma_to_grad_mo: int
    grad_to_pg_mo: int
    other_mo: int
    total_mo: int


class AcademicsOut(BaseModel):
    qualifications: list[QualificationOut]
    gap: AcademicGapOut


@router.get("/academics", response_model=AcademicsOut)
def my_academics(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> AcademicsOut:
    student_id = _require_student(session)
    quals = db.scalars(
        select(AcademicQualification)
        .where(AcademicQualification.student_id == student_id)
        .order_by(AcademicQualification.year)
    ).all()
    gap = db.get(AcademicGap, student_id)
    gap_out = AcademicGapOut(
        twelfth_to_grad_mo=gap.twelfth_to_grad_mo if gap else 0,
        diploma_to_grad_mo=gap.diploma_to_grad_mo if gap else 0,
        grad_to_pg_mo=gap.grad_to_pg_mo if gap else 0,
        other_mo=gap.other_mo if gap else 0,
        total_mo=(
            gap.twelfth_to_grad_mo + gap.diploma_to_grad_mo + gap.grad_to_pg_mo + gap.other_mo
            if gap
            else 0
        ),
    )
    return AcademicsOut(
        qualifications=[
            QualificationOut(
                level=q.level.value,
                institution=q.institution,
                board=q.board,
                year=q.year,
                marks=q.marks,
                max_marks=q.max_marks,
                percent=round(100 * q.marks / q.max_marks, 1) if q.max_marks else 0.0,
                medium=q.medium,
                location=q.location,
                subjects=q.subjects,
            )
            for q in quals
        ],
        gap=gap_out,
    )


class JobRowOut(BaseModel):
    id: str
    title: str
    company: str
    degree_level: str
    location: str | None
    apply_url: str | None
    required_skills: list[str]
    match_percent: float
    eligible: bool
    reasons: list[str]
    applied: bool
    closes_on: str | None
    posted_on: str | None


@router.get("/jobs", response_model=list[JobRowOut])
def my_jobs(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[JobRowOut]:
    """The opportunities feed with a per-row skill match % and the eligibility
    verdict (per-posting CGPA / live-backlog gates)."""
    student_id = _require_student(session)

    skill_slugs = set(
        db.scalars(
            select(Skill.slug)
            .join(StudentSkill, StudentSkill.skill_id == Skill.id)
            .where(StudentSkill.student_id == student_id)
        ).all()
    )
    latest = db.scalar(
        select(SemesterResult)
        .where(SemesterResult.student_id == student_id)
        .order_by(SemesterResult.semester.desc())
        .limit(1)
    )
    latest_cgpa = latest.cgpa if latest else None
    live_backlogs = (
        db.scalar(
            select(func.coalesce(func.sum(SemesterResult.live_backlogs), 0)).where(
                SemesterResult.student_id == student_id
            )
        )
        or 0
    )
    applied_ids = set(
        db.scalars(
            select(JobApplication.job_id).where(JobApplication.student_id == student_id)
        ).all()
    )
    # Active placement criteria supply the defaults when a posting has no override.
    crit = db.scalar(
        select(PlacementCriteria)
        .where(PlacementCriteria.active.is_(True))
        .order_by(PlacementCriteria.updated_at.desc())
        .limit(1)
    )
    gap = db.get(AcademicGap, student_id)
    gap_months = (
        gap.twelfth_to_grad_mo + gap.diploma_to_grad_mo + gap.grad_to_pg_mo + gap.other_mo
        if gap
        else 0
    )

    rows: list[JobRowOut] = []
    for j in db.scalars(select(Job).order_by(Job.posted_on.desc())).all():
        required = set(j.required_skills or [])
        match = round(100 * len(skill_slugs & required) / len(required), 1) if required else 100.0
        # Per-posting override wins; else fall back to the active criteria.
        min_cgpa = j.min_cgpa if j.min_cgpa is not None else (crit.min_cgpa if crit else None)
        max_backlogs = (
            j.max_live_backlogs
            if j.max_live_backlogs is not None
            else (crit.max_live_backlogs if crit else None)
        )
        max_gap = crit.max_gap_months if crit else None
        reasons: list[str] = []
        # A null CGPA is unassessed (not blocking); only an actual below-cutoff blocks.
        if min_cgpa is not None and latest_cgpa is not None and latest_cgpa < min_cgpa:
            reasons.append(f"CGPA {latest_cgpa} is below the required {min_cgpa}")
        if max_backlogs is not None and live_backlogs > max_backlogs:
            reasons.append(f"{live_backlogs} live backlog(s) exceeds the limit of {max_backlogs}")
        if max_gap is not None and gap_months > max_gap:
            reasons.append(f"education gap {gap_months}mo exceeds the limit of {max_gap}mo")
        rows.append(
            JobRowOut(
                id=j.id,
                title=j.title,
                company=j.company,
                degree_level=j.degree_level.value,
                location=j.location,
                apply_url=j.apply_url,
                required_skills=j.required_skills or [],
                match_percent=match,
                eligible=not reasons,
                reasons=reasons,
                applied=j.id in applied_ids,
                closes_on=j.closes_on.isoformat() if j.closes_on else None,
                posted_on=j.posted_on.isoformat() if j.posted_on else None,
            )
        )
    return rows


class ApplyIn(BaseModel):
    notes: str | None = None


@router.post("/jobs/{job_id}/apply")
def apply_to_job(
    job_id: str,
    body: ApplyIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> dict:
    student_id = _require_student(session)
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found.")
    existing = db.scalar(
        select(JobApplication).where(
            JobApplication.student_id == student_id, JobApplication.job_id == job_id
        )
    )
    if existing:
        return {"applied": True, "already": True}
    db.add(JobApplication(student_id=student_id, job_id=job_id, notes=body.notes))
    db.commit()
    return {"applied": True, "already": False}


class OfferIn(BaseModel):
    role_type: str
    job_title: str
    organisation: str
    channel: str = "ON_CAMPUS"
    work_mode: str = "ONSITE"
    location: str | None = None
    ctc_inr: int = 0
    fixed_gross_inr: int = 0
    joining_date: datetime | None = None
    job_id: str | None = None


class OfferOut(BaseModel):
    id: str
    role_type: str
    job_title: str
    organisation: str
    channel: str
    work_mode: str
    location: str | None
    ctc_inr: int
    fixed_gross_inr: int
    status: str


def _offer_out(o: PlacementOffer) -> OfferOut:
    return OfferOut(
        id=o.id,
        role_type=o.role_type.value,
        job_title=o.job_title,
        organisation=o.organisation,
        channel=o.channel.value,
        work_mode=o.work_mode.value,
        location=o.location,
        ctc_inr=o.ctc_inr,
        fixed_gross_inr=o.fixed_gross_inr,
        status=o.status.value,
    )


@router.post("/offers", response_model=OfferOut, status_code=status.HTTP_201_CREATED)
def create_offer(
    body: OfferIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> OfferOut:
    student_id = _require_student(session)
    try:
        role = OfferRoleType(body.role_type)
        channel = OfferChannel(body.channel)
        mode = OfferWorkMode(body.work_mode)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Invalid role_type / channel / work_mode.",
        )
    # job_id is an optional FK the client fills in when the offer came from a
    # posting on the board. Unchecked, a typo reached Postgres and came back as a
    # foreign-key IntegrityError — a 500 that reads to the student as "the site is
    # broken" when the honest answer is "that job does not exist". Checked here,
    # in the same place the enum values are, so every bad field in this body gets
    # the same treatment. POST /jobs/{job_id}/apply already answers 404 this way.
    if body.job_id and db.get(Job, body.job_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found.")
    offer = PlacementOffer(
        student_id=student_id,
        role_type=role,
        job_title=body.job_title,
        organisation=body.organisation,
        channel=channel,
        work_mode=mode,
        location=body.location,
        ctc_inr=body.ctc_inr,
        fixed_gross_inr=body.fixed_gross_inr,
        joining_date=body.joining_date,
        job_id=body.job_id,
        status=OfferStatus.DRAFT,
    )
    db.add(offer)
    db.commit()
    db.refresh(offer)
    return _offer_out(offer)


@router.get("/offers", response_model=list[OfferOut])
def list_offers(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[OfferOut]:
    student_id = _require_student(session)
    rows = db.scalars(
        select(PlacementOffer)
        .where(PlacementOffer.student_id == student_id)
        .order_by(PlacementOffer.created_at.desc())
    ).all()
    return [_offer_out(o) for o in rows]


@router.post("/offers/{offer_id}/submit", response_model=OfferOut)
def submit_offer(
    offer_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> OfferOut:
    student_id = _require_student(session)
    offer = db.get(PlacementOffer, offer_id)
    if offer is None or offer.student_id != student_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Offer not found.")
    if offer.status != OfferStatus.DRAFT:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Only a draft offer can be submitted."
        )
    offer.status = OfferStatus.PENDING_APPROVAL
    db.commit()
    db.refresh(offer)
    return _offer_out(offer)


def _profile_out(db: Session, prof: StudentProfile) -> ProfileOut:
    """The ONE place a ProfileOut is built.

    It used to be two: `my_profile` composed the full response inline while this
    helper composed a shorter one for `update_profile`. When usn / full_name /
    current_semester / current_stage were added to ProfileOut only the inline
    copy was updated, so PUT /api/student/profile raised a 4-field
    ValidationError on every call — a break nothing caught, because no test
    exercises the update path's response body.

    Two constructions of one response is how that happens, so there is now one.
    """
    stu = db.get(Student, prof.student_id)
    owner = db.get(User, stu.user_id) if stu else None
    # A faculty account is not a mentor by existing: `students.mentor_id` is null
    # until the Main Admin assigns one, and a student with no mentor gets None
    # rather than a placeholder.
    mentor_name = None
    if stu is not None and stu.mentor_id:
        mentor = db.get(Mentor, stu.mentor_id)
        mentor_owner = db.get(User, mentor.user_id) if mentor is not None else None
        mentor_name = mentor_owner.name if mentor_owner is not None else None
    return ProfileOut(
        student_id=prof.student_id,
        usn=stu.usn if stu else None,
        full_name=owner.name if owner else None,
        current_semester=stu.current_semester if stu else 1,
        current_stage=stu.current_stage.value if stu else "EXCEL",
        institution=_institution_for(db, stu),
        mentor_name=mentor_name,
        phone=prof.phone,
        email=prof.email,
        linkedin_url=prof.linkedin_url,
        github_url=prof.github_url,
        portfolio_url=prof.portfolio_url,
        city=prof.city,
        career_summary=prof.career_summary,
        placement_eligible=prof.placement_eligible,
        interested_in_jobs=prof.interested_in_jobs,
        interested_in_internships=prof.interested_in_internships,
        education=prof.education or [],
        experience=prof.experience or [],
        projects=prof.projects or [],
        skills=prof.skills or [],
        achievements=prof.achievements or [],
        leaderboard_opt_out=prof.leaderboard_opt_out,
    )


class ProfileUpdateIn(BaseModel):
    phone: str | None = None
    email: str | None = None
    linkedin_url: str | None = None
    github_url: str | None = None
    portfolio_url: str | None = None
    city: str | None = None
    career_summary: str | None = None
    interested_in_jobs: bool | None = None
    interested_in_internships: bool | None = None
    leaderboard_opt_out: bool | None = None
    education: list | None = None
    experience: list | None = None
    projects: list | None = None
    achievements: list | None = None


@router.put("/profile", response_model=ProfileOut)
def update_profile(
    body: ProfileUpdateIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> ProfileOut:
    """Edit your own profile. Only the fields sent are changed; placement_eligible
    is admin-set and intentionally absent from the editable set."""
    student_id = _require_student(session)
    prof = db.scalar(select(StudentProfile).where(StudentProfile.student_id == student_id))
    if prof is None:
        prof = StudentProfile(student_id=student_id)
        db.add(prof)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(prof, field, value)
    db.commit()
    db.refresh(prof)
    return _profile_out(db, prof)


class ScheduleItemOut(BaseModel):
    id: str
    type: str
    title: str
    starts_at: datetime
    location: str | None
    course_code: str | None


@router.get("/schedule", response_model=list[ScheduleItemOut])
def my_schedule(
    upcoming: bool = True,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[ScheduleItemOut]:
    student_id = _require_student(session)
    query = select(ScheduleItem).where(ScheduleItem.student_id == student_id)
    if upcoming:
        query = query.where(ScheduleItem.starts_at >= datetime.now(timezone.utc))
    rows = db.scalars(query.order_by(ScheduleItem.starts_at)).all()
    return [
        ScheduleItemOut(
            id=i.id,
            type=i.type.value,
            title=i.title,
            starts_at=i.starts_at,
            location=i.location,
            course_code=i.course_code,
        )
        for i in rows
    ]


class TimeSheetLogIn(BaseModel):
    day: date
    activity: str  # DayActivity
    minutes: int = Field(ge=0, le=1440)


@router.post("/timesheet")
def log_timesheet(
    body: TimeSheetLogIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> dict:
    """Upsert the minutes for one (day, activity) — one row per bucket per day."""
    student_id = _require_student(session)
    try:
        activity = DayActivity(body.activity)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Invalid activity."
        )
    entry = db.scalar(
        select(TimeSheetEntry).where(
            TimeSheetEntry.student_id == student_id,
            TimeSheetEntry.day == body.day,
            TimeSheetEntry.activity == activity,
        )
    )
    if entry is None:
        entry = TimeSheetEntry(
            student_id=student_id, day=body.day, activity=activity, minutes=body.minutes
        )
        db.add(entry)
    else:
        entry.minutes = body.minutes
    db.commit()
    return {"day": str(body.day), "activity": activity.value, "minutes": body.minutes}


# --------------------------------------------------------------------------- #
# The resume document
# --------------------------------------------------------------------------- #
#
# THE BUILDER'S CONTENT IS WHAT THE DOCUMENT IS MADE OF, and until this was
# written it was not. The composer read the `student_profiles` row, the verified
# skills and the academic record — and nothing else. So a student could fill all
# fifteen sections of the builder, watch the sidebar climb to 100%, press
# Generate, and receive a five-line page carrying none of their experience,
# internships, projects, publications, certifications, positions, objective,
# achievements or referees, printed under a card that told them the resume was
# "drawing on your full record". The builder wrote `resume_profiles.data`; no
# reader existed. The screen said the work had landed and the document said it
# had not, which is the worse of the two ways to be wrong.

#: What a builder section contributes is decided HERE, by name, and that is the
#: point: the resume builder is also the placement office's intake form, so
#: `resume_profiles.data` holds material an employer must never see and that the
#: screens have already promised will not travel — `family` (next-of-kin,
#: "only used where the placement office requires next-of-kin details"),
#: `basic.dob` ("Used for placement eligibility only — not shown on your
#: exported resume"), `basic.medical_history` ("visible to your mentor and the
#: placement office, never to recruiters"), gender / blood group / marital
#: status, `basic.dream_company` (an aspiration addressed to the office),
#: `policy` (the student's acceptance of the placement terms) and `goal` (which
#: posting this copy is aimed at). The street lines and postal code of an
#: address are the office's delivery detail; a resume carries a city.
#:
#: A denylist would publish the NEXT section someone adds to the builder by
#: default, and the first person to find out would be the student, in front of
#: an employer. So nothing reaches the page unless a function below puts it
#: there, and `tests/test_resume_document.py` fills every section with a marker
#: and asserts the private ones are absent.
_PRIVATE_BUILDER_SECTIONS = ("family", "policy", "goal")


def _rt(value) -> str:
    """A trimmed string from an untrusted JSON leaf; "" for anything else.

    `resume_profiles.data` is an opaque map the client owns, so every leaf here
    is whatever the browser last sent — a number, a null, a nested object. The
    composer must never raise on one.
    """
    return value.strip() if isinstance(value, str) else ""


def _rrows(value) -> list[dict]:
    """The dict rows of a builder list, ignoring anything else it holds."""
    return [r for r in value if isinstance(r, dict)] if isinstance(value, list) else []


def _rstrs(value) -> list[str]:
    """The non-blank strings of a builder list."""
    return [s for s in (_rt(v) for v in value) if s] if isinstance(value, list) else []


def _rmap(value) -> dict:
    """A builder sub-object, or an empty one."""
    return value if isinstance(value, dict) else {}


def _entry(title: str, org: str, meta: str, body: str) -> list[str]:
    """One entry, in the only shapes `app/resume_pdf.py` can actually draw.

    The renderer understands `# `, `## `, `- ` and paragraphs. It has NO nested
    bullets, so an entry with a description is a bold headline paragraph
    followed by a plain one rather than a bullet with a child — which would
    render as two sibling bullets and read as two separate claims.
    """
    head = f"**{title}**"
    if org:
        head += f", {org}"
    if meta:
        head += f" ({meta})"
    return [head] + ([body] if body else []) + [""]


def _section(heading: str, body: list[str]) -> list[str]:
    """A heading and its body, or nothing at all when the body is empty.

    An empty section on a resume is a question the reader answers unkindly
    ("Publications — none"), so a section the student has not filled does not
    appear rather than appearing bare.
    """
    return [f"## {heading}", ""] + body if body else []


def _roles_block(rows: list[dict]) -> list[str]:
    """Experience and internships share one shape: title, org · sector, dates,
    location, description."""
    out: list[str] = []
    for e in rows:
        title = _rt(e.get("title"))
        if not title:
            # A row the student opened and left unnamed is not a claim. The
            # builder itself refuses to save one (its Save button is disabled
            # without a title); a row that predates that rule stays off the page.
            continue
        org = " · ".join(x for x in (_rt(e.get("org")), _rt(e.get("sector"))) if x)
        span = " — ".join(x for x in (_rt(e.get("start")), _rt(e.get("end"))) if x)
        meta = " · ".join(x for x in (span, _rt(e.get("location"))) if x)
        out += _entry(title, org, meta, _rt(e.get("description")))
    return out


def _projects_block(rows: list[dict]) -> list[str]:
    out: list[str] = []
    for p in rows:
        title = _rt(p.get("title"))
        if not title:
            continue
        meta = " · ".join(
            x for x in (" · ".join(_rstrs(p.get("tech"))), _rt(p.get("link"))) if x
        )
        out += _entry(title, "", meta, _rt(p.get("description")))
    return out


def _publications_block(rows: list[dict]) -> list[str]:
    out: list[str] = []
    for p in rows:
        title = _rt(p.get("title"))
        if not title:
            continue
        meta = " · ".join(x for x in (_rt(p.get("date")), _rt(p.get("coauthors"))) if x)
        out += _entry(title, _rt(p.get("publisher")), meta, _rt(p.get("doi")))
    return out


def _seminars_block(rows: list[dict]) -> list[str]:
    out: list[str] = []
    for s in rows:
        title = _rt(s.get("title"))
        if not title:
            continue
        out += _entry(title, _rt(s.get("provider")), _rt(s.get("date")), "")
    return out


def _positions_block(rows: list[dict]) -> list[str]:
    out: list[str] = []
    for p in rows:
        title = _rt(p.get("title"))
        if not title:
            continue
        out += _entry(title, _rt(p.get("org")), _rt(p.get("duration")), _rt(p.get("description")))
    return out


def _external_certs_block(rows: list[dict]) -> list[str]:
    out: list[str] = []
    for c in rows:
        title = _rt(c.get("name"))
        if not title:
            continue
        meta = " · ".join(x for x in (_rt(c.get("year")), _rt(c.get("link"))) if x)
        out += _entry(title, _rt(c.get("provider")), meta, "")
    return out


def _references_block(rows: list[dict]) -> list[str]:
    out: list[str] = []
    for r in rows:
        name = _rt(r.get("name"))
        if not name:
            continue
        org = ", ".join(x for x in (_rt(r.get("designation")), _rt(r.get("org"))) if x)
        reach = " · ".join(x for x in (_rt(r.get("email")), _rt(r.get("phone"))) if x)
        out += _entry(name, org, _rt(r.get("relationship")), reach)
    return out


def _bullets(items: list[str]) -> list[str]:
    return [f"- {i}" for i in items] + ([""] if items else [])


def _contact_line(profile, contact: dict) -> str:
    """One line of ways to reach the student, deduplicated, office detail dropped.

    The profile row and the builder's contact section overlap (both hold an
    email, a phone and links), and a resume that prints the same address twice
    reads as carelessness. `add` is case-insensitive because "Test@x.ac.in" and
    "test@x.ac.in" are one address to a reader and two to a set.
    """
    parts: list[str] = []
    seen: set[str] = set()

    def add(value) -> None:
        v = _rt(value)
        if v and v.lower() not in seen:
            seen.add(v.lower())
            parts.append(v)

    if profile is not None:
        add(profile.email)
        add(profile.phone)
    for email in _rstrs(contact.get("personal_emails")):
        add(email)
    for row in _rrows(contact.get("other_phones")):
        number = _rt(row.get("number"))
        if number:
            add(f"{_rt(row.get('code'))} {number}".strip())
    if profile is not None:
        add(profile.linkedin_url)
        add(profile.github_url)
        add(profile.portfolio_url)
    for row in _rrows(contact.get("web_links")):
        add(row.get("url"))

    # A city, never the street. See _PRIVATE_BUILDER_SECTIONS.
    address = _rmap(contact.get("current_address"))
    where = ", ".join(x for x in (_rt(address.get("city")), _rt(address.get("state"))) if x)
    add(where or (profile.city if profile is not None else ""))
    return " · ".join(parts)


def _compose_resume_markdown(name, profile, skill_names, cgpa, quals, builder=None) -> str:
    """The deterministic resume, composed on this machine from what REEP holds.

    `builder` is `resume_profiles.data` — the fifteen-section map the Resume
    Builder writes. It is optional so the signature stays callable with the
    older five arguments, but a caller that omits it publishes a document
    missing everything the student typed, which is the bug this parameter fixed.
    """
    b = builder if isinstance(builder, dict) else {}
    other = _rmap(b.get("other"))

    lines = [f"# {name or 'REEP Student'}", ""]

    # The objective the student wrote for THIS document outranks the one-line
    # career summary on their profile row: it is the more recent statement of
    # intent, and it is the paragraph the builder's own copy promises "the
    # generated resume opens with".
    objective = _rt(other.get("career_objective")) or _rt(
        profile.career_summary if profile is not None else ""
    )
    if objective:
        lines += [objective, ""]

    contact = _contact_line(profile, _rmap(b.get("contact")))
    if contact:
        lines += [f"**Contact:** {contact}", ""]

    lines += _section("Professional Experience", _roles_block(_rrows(b.get("experience"))))
    lines += _section("Internships", _roles_block(_rrows(b.get("internship"))))
    lines += _section("Projects", _projects_block(_rrows(b.get("projects"))))

    # VERIFIED means a mentor checked the evidence. `skill_names` is already
    # filtered to those; `key_expertise` is the student's own word for what they
    # can do, so it travels under its own heading saying exactly that. One
    # undifferentiated "Skills" line would present work in review as work
    # confirmed, which is the thing the whole verification flow exists to stop.
    expertise = _rstrs(other.get("key_expertise"))
    lines += _section("Verified Skills", [", ".join(skill_names), ""] if skill_names else [])
    lines += _section(
        "Key Expertise (self-reported)", [", ".join(expertise), ""] if expertise else []
    )
    lines += _section(
        "Certifications (self-reported)", _external_certs_block(_rrows(b.get("external_certs")))
    )

    lines += _section("Publications & Research", _publications_block(_rrows(b.get("publications"))))
    lines += _section("Seminars & Trainings", _seminars_block(_rrows(b.get("seminars"))))
    lines += _section("Positions of Responsibility", _positions_block(_rrows(b.get("por"))))
    lines += _section("Achievements", _bullets(_rstrs(other.get("achievements"))))
    lines += _section("Awards & Scholarships", _bullets(_rstrs(other.get("awards"))))
    lines += _section(
        "Activities",
        _bullets(_rstrs(other.get("co_curricular")) + _rstrs(other.get("extra_curricular"))),
    )

    academics = [f"- Latest CGPA: {cgpa}" if cgpa is not None else "- CGPA: not yet assessed"]
    for q in quals:
        pct = round(100 * q.marks / q.max_marks) if q.max_marks else 0
        academics.append(f"- {q.level.value.title()}: {q.institution} ({q.year}) — {pct}%")
    lines += _section("Academics", academics + [""])

    languages = _rstrs(_rmap(b.get("basic")).get("languages"))
    lines += _section("Languages", [", ".join(languages), ""] if languages else [])
    lines += _section("References", _references_block(_rrows(b.get("references"))))

    # Trailing blanks are free in markdown and cost a page break in the PDF.
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


class ResumeGenerateIn(BaseModel):
    title: str | None = None
    target_role: str | None = None


@router.post("/resume/generate", dependencies=[Depends(llm_rate_limited)])
def generate_resume(
    body: ResumeGenerateIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> dict:
    """Compose a resume from the student's REEP data. The prompt carries student
    PII, so a model is used ONLY when it is local or explicitly allowed; otherwise
    it composes deterministically and says so (the AGENTS.md egress rule)."""
    student_id = _require_student(session)
    name = session.get("name", "")
    profile = db.scalar(select(StudentProfile).where(StudentProfile.student_id == student_id))
    # ONLY VERIFIED SKILLS REACH THE DOCUMENT. A resume is a claim made to an
    # employer, and an unverified StudentSkill is a claim still with the mentor
    # — printing the two in one undifferentiated "Skills" line presented work in
    # review as work confirmed, which is the one thing the verification flow
    # exists to prevent.
    verified_rows = db.execute(
        select(Skill.slug, Skill.name)
        .join(StudentSkill, StudentSkill.skill_id == Skill.id)
        .where(StudentSkill.student_id == student_id, StudentSkill.verified.is_(True))
    ).all()
    # The builder lets the student switch individual verified skills off when
    # tailoring to a posting. An empty/absent list means they have not curated,
    # so everything verified goes in; an explicit list is respected as written.
    resume_state = db.scalar(
        select(ResumeProfile.data).where(ResumeProfile.student_id == student_id)
    )
    included = ((resume_state or {}).get("evidence_skills") or {}).get("included") or []
    if included:
        chosen = set(included)
        skill_names = [name for slug, name in verified_rows if slug in chosen]
    else:
        skill_names = [name for _slug, name in verified_rows]
    latest = db.scalar(
        select(SemesterResult)
        .where(SemesterResult.student_id == student_id)
        .order_by(SemesterResult.semester.desc())
        .limit(1)
    )
    cgpa = latest.cgpa if latest else None
    quals = db.scalars(
        select(AcademicQualification)
        .where(AcademicQualification.student_id == student_id)
        .order_by(AcademicQualification.year)
    ).all()

    # `resume_state` — the builder's fifteen sections — was already read above
    # for the curated skill list. It is the same map the document is composed
    # from, so it is passed rather than re-queried.
    markdown = _compose_resume_markdown(name, profile, skill_names, cgpa, quals, resume_state)
    generated_by, model, used_ai, note = "fallback", None, False, None

    # Release the pooled connection BEFORE the model call. The SELECTs above
    # opened a transaction that pins one of the pool's connections, and
    # complete_chat below can legally take LLM_TIMEOUT_MS — the 2026-08 audit's
    # arithmetic: ~15 concurrent generations against a slow provider held the
    # ENTIRE pool and 500'd every other request in the app. Every ORM attribute
    # this handler needs has been read into plain values by this line, so
    # expire_on_commit costs nothing; the version query below simply re-acquires
    # a connection when the model is done.
    db.commit()

    cfg = llm_config()
    if cfg is not None and student_data_egress_allowed(cfg.base_url):
        prompt = (
            "Rewrite this into a crisp one-page markdown resume for an MBA student. "
            "Keep every fact; invent nothing.\n\n" + markdown
        )
        try:
            markdown = complete_chat(
                [
                    {"role": "system", "content": "You are a concise resume writer."},
                    {"role": "user", "content": prompt},
                ],
                carries_student_data=True,
                # Was 1500, which was a one-page budget for a five-line draft.
                # Now that the document carries every builder section, a full
                # profile can exceed that — and a truncated polish silently
                # returns LESS than the deterministic draft the student would
                # have got for free.
                max_tokens=3000,
            )
            generated_by, model, used_ai = cfg.provider, cfg.model, True
        except Exception as exc:  # keep the deterministic draft on any failure
            note = f"AI polish failed ({exc}); kept the deterministic draft."
    elif cfg is None:
        # Two different facts used to share one sentence: "no model configured"
        # was reported as "the configured model runs off this machine", which
        # sends the reader looking for a setting that is not the reason.
        note = (
            "No language model is configured, so the resume was composed on this "
            "machine from your saved REEP records."
        )
    else:
        note = (
            "AI generation skipped: the resume carries student data and the configured "
            "model runs off this machine. Composed deterministically. Set "
            "LLM_ALLOW_REMOTE_STUDENT_DATA=true or use a local model to enable AI."
        )

    version = (
        db.scalar(select(func.max(Resume.version)).where(Resume.student_id == student_id)) or 0
    ) + 1
    resume = Resume(
        student_id=student_id,
        version=version,
        title=body.title or "REEP Resume",
        target_role=body.target_role,
        status=ResumeStatus.GENERATED,
        content={},
        markdown=markdown,
        generated_by=generated_by,
        model=model,
    )
    db.add(resume)
    db.commit()
    db.refresh(resume)
    return {
        "id": resume.id,
        "version": version,
        "generated_by": generated_by,
        "model": model,
        "used_ai": used_ai,
        "note": note,
        "markdown": markdown,
    }


class ResumeOut(BaseModel):
    id: str
    version: int
    title: str
    status: str
    generated_by: str
    model: str | None
    # When this version was composed — the "Updated …" line on the Export &
    # share step's version list. Additive; nothing else reads it.
    created_at: datetime | None = None


@router.get("/resume", response_model=list[ResumeOut])
def list_resumes(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[ResumeOut]:
    student_id = _require_student(session)
    rows = db.scalars(
        select(Resume).where(Resume.student_id == student_id).order_by(Resume.created_at.desc())
    ).all()
    return [
        ResumeOut(
            id=r.id,
            version=r.version,
            title=r.title,
            status=r.status.value,
            generated_by=r.generated_by,
            model=r.model,
            created_at=r.created_at,
        )
        for r in rows
    ]


def _evidence_proofs(db: Session, student_id: str) -> list[EvidenceProof]:
    """The files behind the verified skills this resume actually claims.

    Only VERIFIED and INCLUDED skills, in that order of authority:

      * verified, because an appendix is the evidence half of the document and a
        claim still with a mentor is not evidence of anything yet;
      * included, because the student curates which verified skills this copy
        presents, and an appendix that carries proofs the resume never mentions
        hands an employer answers to questions nobody asked.

    A skill whose upload row is gone, or whose bytes are missing from the store,
    is skipped rather than raising: the export of a resume must not fail because
    one certificate was deleted.
    """
    state = db.scalar(select(ResumeProfile.data).where(ResumeProfile.student_id == student_id))
    included = {s for s in (((state or {}).get("evidence_skills") or {}).get("included") or []) if s}
    if not included:
        return []

    rows = db.execute(
        select(Skill.slug, Skill.name, StudentSkill.evidence_upload_id, Skill.id)
        .join(StudentSkill, StudentSkill.skill_id == Skill.id)
        .where(StudentSkill.student_id == student_id, StudentSkill.verified.is_(True))
        .order_by(Skill.name)
    ).all()

    proofs: list[EvidenceProof] = []
    for slug, name, upload_id, skill_id in rows:
        if slug not in included:
            continue
        # The skill row points at its evidence; where it does not, the claim the
        # mentor reviewed does. Same fallback the student's own screen uses.
        if not upload_id:
            upload_id = db.scalar(
                select(SkillClaim.upload_id)
                .where(SkillClaim.student_id == student_id, SkillClaim.skill_id == skill_id)
                .order_by(SkillClaim.created_at.desc())
                .limit(1)
            )
        if not upload_id:
            continue
        upload = db.get(Upload, upload_id)
        if upload is None or upload.student_id != student_id:
            continue
        try:
            content = read_bytes(upload.stored_name)
        except FileNotFoundError:
            continue
        proofs.append(
            EvidenceProof(
                skill=name,
                title=upload.title or "",
                original_name=upload.original_name or "",
                mime_type=upload.mime_type or "",
                content=content,
                verified_on=upload.reviewed_at.strftime("%d %b %Y") if upload.reviewed_at else None,
            )
        )
    return proofs


@router.get("/resume/{resume_id}/pdf")
def resume_pdf(
    resume_id: str,
    appendix: bool = False,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> Response:
    """Render one of the student's own resumes to a PDF. Local render (no model,
    no network), so the egress gate does not apply — but ownership does: a
    student can only export their own resume.

    `appendix=true` binds the proof files of the included verified skills onto
    the end. The Export step's "Include an evidence appendix with proof links"
    checkbox used to change nothing at all — see app/resume_pdf.py — and a
    student who ticked it sent a document without the certificates they believed
    were attached. Links could never have served: an upload URL needs the
    student's own cookie, so a recruiter following one reaches a login page.
    """
    student_id = _require_student(session)
    resume = db.get(Resume, resume_id)
    if resume is None or resume.student_id != student_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Resume not found.")
    pdf = render_resume_pdf(resume.markdown or "", fallback_title=resume.title or "REEP Resume")
    if appendix:
        pdf = append_evidence(pdf, _evidence_proofs(db, student_id))
    filename = f"resume-v{resume.version}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


class CourseOut(BaseModel):
    code: str
    name: str
    stage: str
    dimension: str
    semester: int
    status: str
    teaching_hours_attended: float
    self_learning_hours_logged: float
    lectures_attended: int
    lectures_total: int
    lecture_percent: float
    # --- Progress-plan fields (rule-based; no LLM) ---
    progress_pct: float
    next_task: str
    unlocks: str


def _prettify_stage(stage_value: str) -> str:
    """EXCEL_ADVANCED -> 'Excel Advanced'."""
    return " ".join(word.capitalize() for word in stage_value.split("_"))


def _course_next_task(status: str, lectures_attended: int, lectures_total: int) -> str:
    """The single next action for a course, derived from lecture progress."""
    if status == "COMPLETED":
        return "Completed"
    if lectures_attended < lectures_total:
        return f"Attend lecture {lectures_attended + 1} of {lectures_total}"
    return "Finish the coursework / assessment"


@router.get("/courses", response_model=list[CourseOut])
def my_courses(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[CourseOut]:
    student_id = _require_student(session)
    rows = db.execute(
        select(Enrollment, Course)
        .join(Course, Enrollment.course_code == Course.code)
        .where(Enrollment.student_id == student_id)
        .order_by(Course.semester, Course.code)
    ).all()
    out: list[CourseOut] = []
    for enr, course in rows:
        lecture_percent = (
            round(100 * enr.lectures_attended / enr.lectures_total, 1)
            if enr.lectures_total
            else 0.0
        )
        out.append(
            CourseOut(
                code=course.code,
                name=course.name,
                stage=course.stage.value,
                dimension=course.dimension.value,
                semester=course.semester,
                status=enr.status.value,
                teaching_hours_attended=enr.teaching_hours_attended,
                self_learning_hours_logged=enr.self_learning_hours_logged,
                lectures_attended=enr.lectures_attended,
                lectures_total=enr.lectures_total,
                lecture_percent=lecture_percent,
                progress_pct=lecture_percent,
                next_task=_course_next_task(
                    enr.status.value, enr.lectures_attended, enr.lectures_total
                ),
                unlocks=f"Progresses your {_prettify_stage(course.stage.value)} stage",
            )
        )
    return out


class CertProgressOut(BaseModel):
    code: str
    name: str
    provider: str
    status: str
    progress_pct: float
    hours_logged: float
    required_hours: float
    due_date: datetime
    self_reported: bool
    # --- Progress-plan fields (rule-based; no LLM) ---
    est_hours_remaining: float
    days_until_due: int | None
    next_task: str
    unlocks: str


def _cert_next_task(status: str, self_reported: bool, est_hours_remaining: float) -> str:
    """The single next action for a certification, derived from its status."""
    if status == "NOT_STARTED":
        return "Start the course"
    if status == "IN_PROGRESS":
        return f"Log about {est_hours_remaining:.0f} more hours, then take the assessment"
    if status == "COMPLETED":
        if self_reported:
            return "Upload your certificate for verification"
        return "Done — verified"
    if status == "OVERDUE":
        return "Catch up — you're behind the pace to finish in time"
    return "Start the course"


@router.get("/certifications", response_model=list[CertProgressOut])
def my_certifications(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[CertProgressOut]:
    student_id = _require_student(session)
    rows = db.execute(
        select(CertificationProgress, Certification)
        .join(Certification, CertificationProgress.cert_code == Certification.code)
        .where(CertificationProgress.student_id == student_id)
        .order_by(CertificationProgress.due_date)
    ).all()
    now = datetime.now(timezone.utc)
    out: list[CertProgressOut] = []
    for prog, cert in rows:
        est_hours_remaining = max(0.0, cert.required_hours - prog.hours_logged)
        due = prog.due_date
        if due is None:
            days_until_due = None
        else:
            # Tolerate a naive due_date (some backends drop tzinfo) by assuming UTC.
            if due.tzinfo is None:
                due = due.replace(tzinfo=timezone.utc)
            days_until_due = (due - now).days
        out.append(
            CertProgressOut(
                code=cert.code,
                name=cert.name,
                provider=cert.provider,
                status=prog.status.value,
                progress_pct=prog.progress_pct,
                hours_logged=prog.hours_logged,
                required_hours=cert.required_hours,
                due_date=prog.due_date,
                self_reported=prog.self_reported,
                est_hours_remaining=round(est_hours_remaining, 1),
                days_until_due=days_until_due,
                next_task=_cert_next_task(
                    prog.status.value, prog.self_reported, est_hours_remaining
                ),
                unlocks="Raises your placement readiness (certification completion)",
            )
        )
    return out


class CheckInIn(BaseModel):
    course_code: str
    module: str
    activity: str = "ONLINE_COURSE"
    mode: str = "SUPERVISED_LAB"


@router.post("/checkin")
def check_in(
    body: CheckInIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> dict:
    """Open a focus session (self-reported). Close it with /student/checkout/{id}."""
    student_id = _require_student(session)
    try:
        activity = ActivityType(body.activity)
        mode = LearningMode(body.mode)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Invalid activity or mode."
        )
    ls = LabSession(
        student_id=student_id,
        course_code=body.course_code,
        module=body.module,
        activity=activity,
        mode=mode,
        source=CheckInSource.SELF_REPORTED,
        check_in_at=datetime.now(timezone.utc),
    )
    db.add(ls)
    db.commit()
    db.refresh(ls)
    return {"id": ls.id, "check_in_at": ls.check_in_at.isoformat(), "open": True}


@router.post("/checkout/{session_id}")
def check_out(
    session_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> dict:
    student_id = _require_student(session)
    ls = db.get(LabSession, session_id)
    if ls is None or ls.student_id != student_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found.")
    if ls.check_out_at is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Session already closed.")
    now = datetime.now(timezone.utc)
    ls.check_out_at = now
    ls.duration_min = max(0, int((now - ls.check_in_at).total_seconds() // 60))
    db.commit()
    return {"id": ls.id, "duration_min": ls.duration_min, "open": False}


class FocusSessionOut(BaseModel):
    id: str
    course_code: str
    module: str
    activity: str
    mode: str
    check_in_at: datetime
    check_out_at: datetime | None
    duration_min: int | None
    mentor_confirmed: bool


@router.get("/focus", response_model=list[FocusSessionOut])
def my_focus(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[FocusSessionOut]:
    student_id = _require_student(session)
    rows = db.scalars(
        select(LabSession)
        .where(LabSession.student_id == student_id)
        .order_by(LabSession.check_in_at.desc())
    ).all()
    return [
        FocusSessionOut(
            id=ls.id,
            course_code=ls.course_code,
            module=ls.module,
            activity=ls.activity.value,
            mode=ls.mode.value,
            check_in_at=ls.check_in_at,
            check_out_at=ls.check_out_at,
            duration_min=ls.duration_min,
            mentor_confirmed=ls.mentor_confirmed,
        )
        for ls in rows
    ]


class UploadRowOut(BaseModel):
    id: str
    kind: str
    cert_code: str | None
    title: str
    original_name: str
    mime_type: str
    size_bytes: int
    status: str
    review_note: str | None
    reviewed_at: datetime | None
    uploaded_at: datetime


@router.get("/uploads", response_model=list[UploadRowOut])
def my_uploads(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[UploadRowOut]:
    """A student's own submitted documents and their review state."""
    student_id = _require_student(session)
    rows = db.scalars(
        select(Upload)
        .where(Upload.student_id == student_id)
        .order_by(Upload.uploaded_at.desc())
    ).all()
    return [_upload_row(u) for u in rows]


def _upload_row(u: Upload) -> "UploadRowOut":
    return UploadRowOut(
        id=u.id,
        kind=u.kind.value,
        cert_code=u.cert_code,
        title=u.title,
        original_name=u.original_name,
        mime_type=u.mime_type,
        size_bytes=u.size_bytes,
        status=u.status.value,
        review_note=u.review_note,
        reviewed_at=u.reviewed_at,
        uploaded_at=u.uploaded_at,
    )


@router.post("/uploads", response_model=UploadRowOut, status_code=status.HTTP_201_CREATED)
def create_upload(
    file: UploadFile = File(...),
    kind: str = Form("DOCUMENT"),
    title: str = Form(""),
    cert_code: str | None = Form(None),
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> "UploadRowOut":
    """Upload a document (multipart). The type is decided by magic bytes, not the
    client — PDF/PNG/JPEG only, 10 MB max — and the row starts PENDING_REVIEW.

    Sync `def` ON PURPOSE (2026-08 audit): this used to be the one async
    endpoint in the file, which put its sync DB queries and a 10 MB
    `write_bytes` directly on the event loop — the loop every live interview's
    audio shares. A deadline-week upload burst produced 100-300 ms loop stalls
    (audible glitches in every running interview), and under pool contention
    the sync checkout parked the loop for the full pool timeout. In the
    threadpool, the only thing this endpoint can stall is itself. The one
    await it needed, `file.read()`, is `file.file.read()` here — same bytes,
    same SpooledTemporaryFile, no coroutine.
    """
    student_id = _require_student(session)
    try:
        upload_kind = UploadKind(kind)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Unknown upload kind."
        )

    # Quota before the body is buffered. document_store.MAX_BYTES caps ONE file at
    # 10 MB and nothing capped how many, so any authenticated student could fill
    # the uploads volume 10 MB at a time — after which every other student's
    # upload fails on a machine whose health checks all pass. The count is
    # checked first precisely so an over-quota student never gets their megabytes
    # read into this process's memory at all.
    used_count, used_bytes = db.execute(
        select(func.count(Upload.id), func.coalesce(func.sum(Upload.size_bytes), 0)).where(
            Upload.student_id == student_id
        )
    ).one()
    # 409 for a full shelf, 413 for the byte allowance: the file is fine either
    # way, so neither is 422. Deleting an upload (DELETE /student/uploads/{id})
    # removes the bytes and the row, so the student can act on this themselves —
    # the messages say so, or the limit reads as a dead end.
    quota = VolumeQuota(
        max_files=MAX_UPLOADS_PER_STUDENT,
        max_bytes=MAX_UPLOAD_BYTES_PER_STUDENT,
        used_files=used_count,
        used_bytes=used_bytes,
        noun="file",
    )
    try:
        quota.check_slot()
    except QuotaRejected as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))

    # read(MAX+1), never read(): the per-file cap is enforced by save_bytes on
    # len(content), so reading one byte past it is enough to trip the refusal —
    # while an unbounded read loads a body only nginx's client_max_body_size
    # bounds into RAM, and that bound does not exist when uvicorn is exposed
    # directly (the documented dev setup, or a different ingress).
    content = file.file.read(MAX_BYTES + 1)
    try:
        stored_name, mime, size = save_bytes(content, quota=quota)
    except QuotaRejected as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    except UploadRejected as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc))

    upload = Upload(
        student_id=student_id,
        kind=upload_kind,
        cert_code=cert_code or None,
        title=title.strip() or (file.filename or "Upload"),
        original_name=file.filename or stored_name,
        stored_name=stored_name,
        mime_type=mime,
        size_bytes=size,
    )
    db.add(upload)
    db.commit()
    db.refresh(upload)
    return _upload_row(upload)


@router.get("/uploads/{upload_id}/file")
def download_upload(
    upload_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> Response:
    """Stream one of the student's own uploaded files back."""
    student_id = _require_student(session)
    upload = db.get(Upload, upload_id)
    if upload is None or upload.student_id != student_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found.")
    try:
        content = read_bytes(upload.stored_name)
    except FileNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Stored file is missing."
        )
    return Response(
        content=content,
        media_type=upload.mime_type,
        # RFC 6266 via document_store.content_disposition -- interpolating the student's own
        # filename here raises UnicodeEncodeError inside Response.__init__ for any name
        # outside latin-1 (Kannada, Hindi, an emoji), 500-ing the download of a file that
        # uploaded perfectly. See document_store.content_disposition for the full reasoning.
        headers={"Content-Disposition": content_disposition(upload.original_name)},
    )


@router.delete("/uploads/{upload_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_upload(
    upload_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> Response:
    """Delete one of the student's own uploads — the stored bytes then the row.
    A student can only delete their own upload."""
    student_id = _require_student(session)
    upload = db.get(Upload, upload_id)
    if upload is None or upload.student_id != student_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found.")
    document_store_delete(upload.stored_name)
    db.delete(upload)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


class SkillClaimOut(BaseModel):
    id: str
    skill_id: str
    skill_name: str
    # NULL once the student has deleted the certificate this was filed against.
    # The claim, its level and the mentor's verdict survive; only the pointer to
    # the file goes. See models/skill.py's comment on the FK.
    upload_id: str | None
    claimed_level: int
    status: str
    student_note: str | None
    review_note: str | None
    reviewed_at: datetime | None
    created_at: datetime


class SkillClaimIn(BaseModel):
    skill_id: str
    upload_id: str
    # The claim form no longer asks the student to grade themselves — it asks for
    # the certificate and the badge it proves, and the mentor sets the level when
    # they grant it. The default stands in for the claim's "working" level.
    claimed_level: int = Field(default=3, ge=1, le=5)
    student_note: str | None = None


@router.get("/skill-claims", response_model=list[SkillClaimOut])
def my_skill_claims(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[SkillClaimOut]:
    """A student's own skill claims and their review state."""
    student_id = _require_student(session)
    rows = db.execute(
        select(SkillClaim, Skill.name)
        .join(Skill, SkillClaim.skill_id == Skill.id)
        .where(SkillClaim.student_id == student_id)
        .order_by(SkillClaim.created_at.desc())
    ).all()
    return [
        SkillClaimOut(
            id=sc.id,
            skill_id=sc.skill_id,
            skill_name=name,
            upload_id=sc.upload_id,
            claimed_level=sc.claimed_level,
            status=sc.status.value,
            student_note=sc.student_note,
            review_note=sc.review_note,
            reviewed_at=sc.reviewed_at,
            created_at=sc.created_at,
        )
        for sc, name in rows
    ]


@router.post("/skill-claims", response_model=SkillClaimOut, status_code=status.HTTP_201_CREATED)
def create_skill_claim(
    body: SkillClaimIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> SkillClaimOut:
    """Claim a skill level, backed by one of your own uploads, for mentor review."""
    student_id = _require_student(session)
    skill = db.get(Skill, body.skill_id)
    if skill is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Skill not found.")
    upload = db.get(Upload, body.upload_id)
    if upload is None or upload.student_id != student_id:
        # Never let a claim point at someone else's upload.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Evidence upload not found."
        )
    claim = SkillClaim(
        student_id=student_id,
        skill_id=body.skill_id,
        upload_id=body.upload_id,
        claimed_level=body.claimed_level,
        student_note=body.student_note,
    )
    db.add(claim)
    db.commit()
    db.refresh(claim)
    return SkillClaimOut(
        id=claim.id,
        skill_id=claim.skill_id,
        skill_name=skill.name,
        upload_id=claim.upload_id,
        claimed_level=claim.claimed_level,
        status=claim.status.value,
        student_note=claim.student_note,
        review_note=claim.review_note,
        reviewed_at=claim.reviewed_at,
        created_at=claim.created_at,
    )


# The resume-builder sections that ResumeProfile owns (the ones with no other
# home). Education / certifications / attachments are shown by the builder too
# but come from their own endpoints, so they don't count here.
_RESUME_SECTIONS = [
    "basic", "contact", "family", "experience", "internship", "projects",
    "publications", "seminars", "por", "other", "references", "policy",
]


#: Leaf keys whose value is FURNITURE THE FORM SUPPLIES, not content a student
#: entered. The contact section seeds `country: "India"` and a `+91` dial `code`
#: into every address and phone row the moment one is added, so pressing "Add
#: another number" and typing nothing used to mark the whole section filled.
#:
#: Observed: a fresh profile went from 8% to 17% — a twelfth of the bar — for one
#: empty phone row and one unticked checkbox, with nothing typed. The sidebar
#: advertises 70% as the point where the document gets materially stronger, and
#: a percentage reachable by clicking Add is not a measure of anything.
_STRUCTURAL_LEAF_KEYS = {"country", "code"}


def _section_filled(value, *, key: str | None = None) -> bool:
    """Does this section hold content the student actually put there?

    Only a non-blank string counts. Booleans and numbers are STRUCTURE — a
    checkbox has a value whether or not anyone has looked at it, and
    `permanent_same: false` says nothing about whether an address was written.
    The old rule returned True for any list with a row in it and for any
    non-empty leaf of any type, so an empty row counted the same as a filled one.
    """
    if isinstance(value, dict):
        return any(_section_filled(v, key=k) for k, v in value.items())
    if isinstance(value, list):
        return any(_section_filled(v) for v in value)
    if isinstance(value, str):
        return bool(value.strip()) and key not in _STRUCTURAL_LEAF_KEYS
    return False


def _resume_completeness(data: dict) -> int:
    if not data:
        return 0
    filled = sum(1 for k in _RESUME_SECTIONS if _section_filled(data.get(k)))
    return round(100 * filled / len(_RESUME_SECTIONS))


class ResumeProfileIn(BaseModel):
    data: dict = Field(default_factory=dict)


class ResumeProfileOut(BaseModel):
    data: dict
    completeness: int
    updated_at: datetime | None


@router.get("/resume-profile", response_model=ResumeProfileOut)
def get_resume_profile(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> ResumeProfileOut:
    """The student's saved resume-builder state (the free-form sections)."""
    student_id = _require_student(session)
    row = db.scalar(select(ResumeProfile).where(ResumeProfile.student_id == student_id))
    data = row.data if row else {}
    return ResumeProfileOut(
        data=data,
        completeness=_resume_completeness(data),
        updated_at=row.updated_at if row else None,
    )


@router.put("/resume-profile", response_model=ResumeProfileOut)
def put_resume_profile(
    body: ResumeProfileIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> ResumeProfileOut:
    """Upsert the whole builder state for the caller (one row per student)."""
    student_id = _require_student(session)
    row = db.scalar(select(ResumeProfile).where(ResumeProfile.student_id == student_id))
    if row is None:
        row = ResumeProfile(student_id=student_id, data=body.data)
        db.add(row)
    else:
        row.data = body.data
    db.commit()
    db.refresh(row)
    return ResumeProfileOut(
        data=row.data,
        completeness=_resume_completeness(row.data),
        updated_at=row.updated_at,
    )


# --- Leaderboards --------------------------------------------------------------

_BOARDS = ("certificates", "skills", "vtu", "streak", "mocks")


def _initials(name: str) -> str:
    parts = [p for p in name.split() if p]
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def _board_values(db: Session, board: str, roster: list[tuple[str, str]]) -> dict[str, tuple[float, str]]:
    """student_id -> (value, label) for the chosen board, over the cohort roster
    (list of (student_id, user_id)). Students with no activity score 0."""
    sids = [sid for sid, _ in roster]
    uid_by_sid = {sid: uid for sid, uid in roster}
    out: dict[str, tuple[float, str]] = {sid: (0.0, "") for sid in sids}

    if board == "certificates":
        rows = db.execute(
            select(CertificationProgress.student_id, func.count())
            .where(
                CertificationProgress.student_id.in_(sids),
                CertificationProgress.status == ProgressStatus.COMPLETED,
            )
            .group_by(CertificationProgress.student_id)
        ).all()
        counts = {sid: n for sid, n in rows}
        return {sid: (float(counts.get(sid, 0)), f"{counts.get(sid, 0)} certs") for sid in sids}

    if board == "skills":
        rows = db.execute(
            select(StudentSkill.student_id, func.count())
            .where(StudentSkill.student_id.in_(sids))
            .group_by(StudentSkill.student_id)
        ).all()
        counts = {sid: n for sid, n in rows}
        return {sid: (float(counts.get(sid, 0)), f"{counts.get(sid, 0)} skills") for sid in sids}

    if board == "mocks":
        rows = db.execute(
            select(MockAttempt.student_id, func.count())
            .where(MockAttempt.student_id.in_(sids))
            .group_by(MockAttempt.student_id)
        ).all()
        counts = {sid: n for sid, n in rows}
        return {sid: (float(counts.get(sid, 0)), f"{counts.get(sid, 0)} mocks") for sid in sids}

    if board == "vtu":
        # Latest semester's CGPA per student, decided by Postgres. This used to
        # fetch EVERY SemesterResult row for the cohort and keep the first per
        # student in Python — ~30,000 hydrated rows per call at a 5,000-student
        # cohort (2026-08 audit). DISTINCT ON with the matching ORDER BY is the
        # same "first row per student is the highest semester" idea, executed
        # where the rows live, returning one row per student.
        rows = db.execute(
            select(SemesterResult.student_id, SemesterResult.cgpa)
            .where(SemesterResult.student_id.in_(sids))
            .distinct(SemesterResult.student_id)
            .order_by(SemesterResult.student_id, SemesterResult.semester.desc())
        ).all()
        latest = {sid: float(cgpa) for sid, cgpa in rows}
        return {sid: (latest.get(sid, 0.0), f"CGPA {latest.get(sid, 0.0):.2f}") for sid in sids}

    if board == "streak":
        # Active-day count (LoginDay is keyed by user_id).
        uids = list(uid_by_sid.values())
        rows = db.execute(
            select(LoginDay.user_id, func.count())
            .where(LoginDay.user_id.in_(uids))
            .group_by(LoginDay.user_id)
        ).all()
        by_uid = {uid: n for uid, n in rows}
        return {
            sid: (float(by_uid.get(uid_by_sid[sid], 0)), f"{by_uid.get(uid_by_sid[sid], 0)} active days")
            for sid in sids
        }

    return out


class LeaderRow(BaseModel):
    rank: int
    student_id: str
    name: str
    initials: str
    value: float
    value_label: str
    is_me: bool


class LeaderboardOut(BaseModel):
    board: str
    opted_out: bool
    cohort_size: int  # number of ranked students on the board (for "Rank 8 of N")
    rows: list[LeaderRow]


# How much of a board one response carries: the top of the table plus the
# caller's own row (appended with its true rank when it falls outside). At a
# 5,000-student cohort the full board was a ~600 KB JSON document per request,
# and nobody scrolls to rank 4,000 — they look at the top and at themselves.
_LEADERBOARD_TOP_N = 50
# One ranked board per (cohort, board) is recomputed at most this often, per
# worker. Leaderboards tolerate staleness by definition — a rank that is 60 s
# old is still today's rank — and this turns a deadline-week thundering herd
# into at most one aggregate pass a minute per cohort per board.
_LEADERBOARD_CACHE_TTL_S = 60.0
_leaderboard_cache: dict[tuple[str | None, str], tuple[float, list[tuple]]] = {}
_leaderboard_cache_lock = threading.Lock()


def _ranked_board(
    db: Session, cohort_id: str | None, board: str
) -> list[tuple[int, str, str, float, str]]:
    """The whole ranked board — (rank, student_id, name, value, label) — for one
    cohort, cached per worker for _LEADERBOARD_CACHE_TTL_S.

    Cached WITHOUT the caller folded in: `is_me` is per-request decoration, so
    one cached list serves every student in the cohort. The opt-out set is part
    of the cached computation and therefore up to 60 s stale FOR OTHERS — the
    student who opts out vanishes from their own screen immediately, because
    `leaderboards` checks their own profile fresh on every request. A stampede
    on an expired entry recomputes it a couple of times concurrently rather
    than serialising every reader behind one computation; the work is idempotent
    and the last writer wins.
    """
    key = (cohort_id, board)
    now = time.monotonic()
    with _leaderboard_cache_lock:
        hit = _leaderboard_cache.get(key)
        if hit is not None and now - hit[0] < _LEADERBOARD_CACHE_TTL_S:
            return hit[1]

    opted_out = set(
        db.scalars(
            select(StudentProfile.student_id).where(
                StudentProfile.leaderboard_opt_out.is_(True)
            )
        ).all()
    )
    cohort_filter = (
        Student.cohort_id.is_(None) if cohort_id is None else Student.cohort_id == cohort_id
    )
    roster_rows = db.execute(
        select(Student.id, Student.user_id, User.name)
        .join(User, Student.user_id == User.id)
        .where(cohort_filter)
    ).all()
    roster = [(sid, uid, name) for sid, uid, name in roster_rows if sid not in opted_out]

    values = _board_values(db, board, [(sid, uid) for sid, uid, _ in roster])
    ranked = sorted(roster, key=lambda r: values[r[0]][0], reverse=True)
    entries = [
        (i + 1, sid, name, values[sid][0], values[sid][1])
        for i, (sid, _uid, name) in enumerate(ranked)
    ]
    with _leaderboard_cache_lock:
        _leaderboard_cache[key] = (now, entries)
    return entries


@router.get("/leaderboards", response_model=LeaderboardOut)
def leaderboards(
    board: str = "certificates",
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> LeaderboardOut:
    """Rank the caller's cohort on one board. A student who opted out is excluded
    from every board and — in both directions — sees no ranks themselves."""
    student_id = _require_student(session)
    if board not in _BOARDS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Unknown board. One of: {', '.join(_BOARDS)}.",
        )
    me = db.get(Student, student_id)
    if me is None:
        # A session outlives the row it describes: a 12h cookie stays valid after
        # a roster rekey or a deleted account, and this endpoint then read
        # me.cohort_id straight through and 500ed. Every sibling that
        # dereferences the caller's own Student answers 404 here (see
        # /dashboard); match them rather than inventing a third behaviour.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")
    my_profile = db.scalar(
        select(StudentProfile).where(StudentProfile.student_id == student_id)
    )
    if my_profile is not None and my_profile.leaderboard_opt_out:
        return LeaderboardOut(board=board, opted_out=True, cohort_size=0, rows=[])

    # The whole board, ranked, from the per-worker 60 s cache — see
    # _ranked_board for what is cached and what stays per-request.
    entries = _ranked_board(db, me.cohort_id, board)

    def _row(entry: tuple[int, str, str, float, str]) -> LeaderRow:
        rank, sid, name, value, label = entry
        return LeaderRow(
            rank=rank,
            student_id=sid,
            name=name,
            initials=_initials(name),
            value=value,
            value_label=label,
            is_me=(sid == student_id),
        )

    # Top of the table, plus the caller's own row with its TRUE rank when they
    # fall outside it — "Rank 1,247 of 4,890" is the sentence a student wants,
    # and shipping ranks 51-4,889 to render it was the 600 KB the audit flagged.
    rows = [_row(e) for e in entries[: _LEADERBOARD_TOP_N]]
    if not any(r.is_me for r in rows):
        mine = next((e for e in entries if e[1] == student_id), None)
        if mine is not None:
            rows.append(_row(mine))
    return LeaderboardOut(
        board=board, opted_out=False, cohort_size=len(entries), rows=rows
    )


class LeaderboardVisibilityIn(BaseModel):
    hidden: bool


@router.put("/leaderboard-visibility")
def set_leaderboard_visibility(
    body: LeaderboardVisibilityIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> dict:
    """Hide or show yourself on the Leaderboards screen — sets the caller's
    StudentProfile.leaderboard_opt_out (creating the profile row if missing)."""
    student_id = _require_student(session)
    prof = db.scalar(select(StudentProfile).where(StudentProfile.student_id == student_id))
    if prof is None:
        prof = StudentProfile(student_id=student_id)
        db.add(prof)
    prof.leaderboard_opt_out = body.hidden
    db.commit()
    # Drop this cohort's cached boards so the toggle is visible on the very
    # next read. Without this, opting BACK IN inside a still-fresh cache window
    # answered "You're now visible on the leaderboards" and then rendered a
    # board without them — the review of the 2026-08 fix wave caught the
    # contradiction. (Opting OUT never had the problem only because the
    # caller's own opt-out is checked fresh, before the cache, in
    # `leaderboards` above.) Per worker, like the cache itself: classmates on
    # another worker may see the old board for the remaining TTL, which is the
    # staleness the cache already declares acceptable — lying to the student
    # about their own setting was not.
    me = db.get(Student, student_id)
    if me is not None:
        with _leaderboard_cache_lock:
            for b in _BOARDS:
                _leaderboard_cache.pop((me.cohort_id, b), None)
    return {"hidden": body.hidden}


# --- Rule-based guidance (no LLM): next actions, readiness, recommendations ----
#
# Every value below is computed from the caller's own rows. These endpoints are
# STUDENT-only and never touch a model, so they carry no student-data egress.


def _attendance_pct(db: Session, student_id: str) -> float:
    """Overall attendance %, same computation the dashboard/attendance uses."""
    rows = db.execute(
        select(AttendanceRecord.present).where(AttendanceRecord.student_id == student_id)
    ).all()
    total = len(rows)
    present = sum(1 for (p,) in rows if p)
    return round(100 * present / total, 1) if total else 0.0


def _latest_cgpa(db: Session, student_id: str) -> float | None:
    latest = db.scalar(
        select(SemesterResult)
        .where(SemesterResult.student_id == student_id)
        .order_by(SemesterResult.semester.desc())
        .limit(1)
    )
    return latest.cgpa if latest else None


def _live_backlogs(db: Session, student_id: str) -> int:
    return int(
        db.scalar(
            select(func.coalesce(func.sum(SemesterResult.live_backlogs), 0)).where(
                SemesterResult.student_id == student_id
            )
        )
        or 0
    )


def _cert_completion_pct(db: Session, student_id: str) -> float:
    """Share of the student's certifications that are COMPLETED."""
    rows = db.execute(
        select(CertificationProgress.status).where(
            CertificationProgress.student_id == student_id
        )
    ).all()
    total = len(rows)
    if not total:
        return 0.0
    done = sum(1 for (s,) in rows if s == ProgressStatus.COMPLETED)
    return round(100 * done / total, 1)


def _resume_pct(db: Session, student_id: str) -> int:
    row = db.scalar(select(ResumeProfile).where(ResumeProfile.student_id == student_id))
    return _resume_completeness(row.data if row else {})


class NextActionOut(BaseModel):
    id: str
    title: str
    reason: str
    cta_label: str
    cta_route: str
    status: str
    deadline: datetime | None
    priority: int


class NextActionsOut(BaseModel):
    actions: list[NextActionOut]


@router.get("/next-actions", response_model=NextActionsOut)
def next_actions(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> NextActionsOut:
    """The student's 'what to do next' list — the top 5 candidate actions drawn
    from their real certification, course, profile, resume and skilling state,
    sorted by urgency (lower priority = more urgent). Rule-based; no model."""
    student_id = _require_student(session)
    actions: list[NextActionOut] = []

    # Certifications (join for the display name), split by status.
    cert_rows = db.execute(
        select(CertificationProgress, Certification)
        .join(Certification, CertificationProgress.cert_code == Certification.code)
        .where(CertificationProgress.student_id == student_id)
        .order_by(CertificationProgress.due_date)
    ).all()
    for prog, cert in cert_rows:
        if prog.status == ProgressStatus.OVERDUE:
            actions.append(
                NextActionOut(
                    id=f"cert-overdue-{cert.code}",
                    title=f"Finish {cert.name}",
                    reason="Overdue — behind the pace to complete in time",
                    cta_label="Continue",
                    cta_route="/student/certifications",
                    status="Overdue",
                    deadline=prog.due_date,
                    priority=1,
                )
            )
        elif prog.status == ProgressStatus.IN_PROGRESS:
            actions.append(
                NextActionOut(
                    id=f"cert-progress-{cert.code}",
                    title=f"Finish {cert.name}",
                    reason=f"In progress ({round(prog.progress_pct)}%)",
                    cta_label="Continue",
                    cta_route="/student/certifications",
                    status="In progress",
                    deadline=prog.due_date,
                    priority=3,
                )
            )

    # In-progress courses.
    course_rows = db.execute(
        select(Enrollment, Course)
        .join(Course, Enrollment.course_code == Course.code)
        .where(
            Enrollment.student_id == student_id,
            Enrollment.status == ProgressStatus.IN_PROGRESS,
        )
        .order_by(Course.semester, Course.code)
    ).all()
    for enr, course in course_rows:
        if enr.lectures_total:
            reason = f"{enr.lectures_attended}/{enr.lectures_total} lectures attended"
        else:
            reason = "In progress — keep logging your self-learning hours"
        actions.append(
            NextActionOut(
                id=f"course-{course.code}",
                title=f"Finish {course.name}",
                reason=reason,
                cta_label="Continue",
                cta_route="/student/courses",
                status="In progress",
                deadline=None,
                priority=3,
            )
        )

    # Missing placement-profile fields.
    prof = db.scalar(select(StudentProfile).where(StudentProfile.student_id == student_id))
    if not (prof and prof.phone):
        actions.append(
            NextActionOut(
                id="profile-phone",
                title="Add your phone number to your placement profile",
                reason="Recruiters need a way to reach you",
                cta_label="Add",
                cta_route="/student/profile",
                status="Missing",
                deadline=None,
                priority=2,
            )
        )
    if not (prof and prof.linkedin_url):
        actions.append(
            NextActionOut(
                id="profile-linkedin",
                title="Add your LinkedIn URL to your placement profile",
                reason="A LinkedIn profile strengthens your placement record",
                cta_label="Add",
                cta_route="/student/profile",
                status="Missing",
                deadline=None,
                priority=2,
            )
        )

    # Low resume completeness.
    resume_pct = _resume_pct(db, student_id)
    if resume_pct < 70:
        actions.append(
            NextActionOut(
                id="resume-completeness",
                title=f"Complete your resume profile ({resume_pct}%)",
                reason="A fuller resume profile means a stronger auto-generated CV",
                cta_label="Complete",
                cta_route="/student/resume",
                status="Incomplete",
                deadline=None,
                priority=4,
            )
        )

    # A pending skill claim under review, or a held-but-unverified skill.
    pending_claim = db.execute(
        select(SkillClaim, Skill.name)
        .join(Skill, SkillClaim.skill_id == Skill.id)
        .where(
            SkillClaim.student_id == student_id,
            SkillClaim.status == UploadStatus.PENDING_REVIEW,
        )
        .order_by(SkillClaim.created_at.desc())
        .limit(1)
    ).first()
    if pending_claim is not None:
        _claim, skill_name = pending_claim
        actions.append(
            NextActionOut(
                id="skill-claim-pending",
                title=f"Your {skill_name} skill claim is under review",
                reason="A mentor is reviewing your evidence",
                cta_label="View",
                cta_route="/student/skilling",
                status="Pending review",
                deadline=None,
                priority=4,
            )
        )
    else:
        unverified = db.execute(
            select(StudentSkill, Skill.name)
            .join(Skill, StudentSkill.skill_id == Skill.id)
            .where(
                StudentSkill.student_id == student_id,
                StudentSkill.verified.is_(False),
            )
            .order_by(StudentSkill.updated_at.desc())
            .limit(1)
        ).first()
        if unverified is not None:
            _ss, skill_name = unverified
            actions.append(
                NextActionOut(
                    id="skill-unverified",
                    title=f"Get your {skill_name} skill verified",
                    reason="Upload evidence so a mentor can verify it",
                    cta_label="Verify",
                    cta_route="/student/skilling",
                    status="Unverified",
                    deadline=None,
                    priority=4,
                )
            )

    actions.sort(key=lambda a: a.priority)
    return NextActionsOut(actions=actions[:5])


class ReadinessFactorOut(BaseModel):
    label: str
    met: bool
    detail: str
    weight: int


class PlacementReadinessOut(BaseModel):
    score: int
    band: str
    summary: str
    factors: list[ReadinessFactorOut]


def _readiness_band(score: int) -> str:
    if score < 40:
        return "Not ready"
    if score < 60:
        return "Developing"
    if score < 80:
        return "On track"
    return "Ready"


@router.get("/placement-readiness", response_model=PlacementReadinessOut)
def placement_readiness(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> PlacementReadinessOut:
    """A weighted placement-readiness score against the active PlacementCriteria
    (or sensible defaults when none is set). Rule-based; no model."""
    student_id = _require_student(session)

    crit = db.scalar(
        select(PlacementCriteria)
        .where(PlacementCriteria.active.is_(True))
        .order_by(PlacementCriteria.updated_at.desc())
        .limit(1)
    )
    # Defaults when the Main Admin has set no active criteria.
    min_cgpa = crit.min_cgpa if crit else 6.0
    max_backlogs = crit.max_live_backlogs if crit else 0
    min_att = crit.min_attendance_pct if crit else 75.0
    min_cert = crit.min_cert_completion_pct if crit else 50.0

    cgpa = _latest_cgpa(db, student_id)
    backlogs = _live_backlogs(db, student_id)
    att = _attendance_pct(db, student_id)
    cert_pct = _cert_completion_pct(db, student_id)
    prof = db.scalar(select(StudentProfile).where(StudentProfile.student_id == student_id))
    has_contacts = bool(prof and prof.phone and prof.linkedin_url)
    resume_pct = _resume_pct(db, student_id)

    factors = [
        ReadinessFactorOut(
            label="CGPA",
            met=(cgpa is not None and cgpa >= min_cgpa),
            detail=(
                f"CGPA {cgpa} meets the {min_cgpa} cut-off"
                if (cgpa is not None and cgpa >= min_cgpa)
                else (
                    f"CGPA {cgpa} is below the {min_cgpa} cut-off"
                    if cgpa is not None
                    else "CGPA not yet assessed"
                )
            ),
            weight=3,
        ),
        ReadinessFactorOut(
            label="Live backlogs",
            met=(backlogs <= max_backlogs),
            detail=f"{backlogs} live backlog(s); limit is {max_backlogs}",
            weight=3,
        ),
        ReadinessFactorOut(
            label="Attendance",
            met=(att >= min_att),
            detail=f"Attendance {att}% vs required {min_att}%",
            weight=2,
        ),
        ReadinessFactorOut(
            label="Certification completion",
            met=(cert_pct >= min_cert),
            detail=f"{cert_pct}% of certifications completed vs required {min_cert}%",
            weight=2,
        ),
        ReadinessFactorOut(
            label="Placement profile",
            met=has_contacts,
            detail=(
                "Phone and LinkedIn are on file"
                if has_contacts
                else "Add your phone number and LinkedIn URL"
            ),
            weight=1,
        ),
        ReadinessFactorOut(
            label="Resume profile",
            met=(resume_pct >= 70),
            detail=f"Resume profile {resume_pct}% complete (target 70%)",
            weight=1,
        ),
    ]

    total_weight = sum(f.weight for f in factors)
    met_weight = sum(f.weight for f in factors if f.met)
    score = round(100 * met_weight / total_weight) if total_weight else 0
    band = _readiness_band(score)
    met_count = sum(1 for f in factors if f.met)
    summary = f"{score}/100 — {band}. {met_count} of {len(factors)} placement checks met."

    return PlacementReadinessOut(score=score, band=band, summary=summary, factors=factors)


class RecommendationOut(BaseModel):
    title: str
    why: str
    cta_label: str
    cta_route: str


class RecommendationsOut(BaseModel):
    items: list[RecommendationOut]


@router.get("/recommendations", response_model=RecommendationsOut)
def recommendations(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> RecommendationsOut:
    """Up to three rule-based next-skill (or fallback) recommendations, drawn from
    the catalogue skills the student does not yet hold. Never empty when any
    sensible recommendation exists. No model."""
    student_id = _require_student(session)

    held_ids = set(
        db.scalars(
            select(StudentSkill.skill_id).where(StudentSkill.student_id == student_id)
        ).all()
    )
    catalogue = db.scalars(select(Skill).order_by(Skill.category, Skill.name)).all()
    missing = [s for s in catalogue if s.id not in held_ids]

    items: list[RecommendationOut] = []
    for s in missing[:3]:
        items.append(
            RecommendationOut(
                title=f"Learn {s.name}",
                why=f"Unlocks your {s.category} badge",
                cta_label="Start",
                cta_route="/student/skilling",
            )
        )

    # Holds every catalogue skill (or the catalogue is empty): fall back to
    # finishing an in-progress certification, then completing the resume profile.
    if not items:
        in_prog = db.execute(
            select(Certification.name)
            .join(
                CertificationProgress,
                CertificationProgress.cert_code == Certification.code,
            )
            .where(
                CertificationProgress.student_id == student_id,
                CertificationProgress.status.in_(
                    (ProgressStatus.IN_PROGRESS, ProgressStatus.OVERDUE)
                ),
            )
            .order_by(CertificationProgress.due_date)
            .limit(3)
        ).all()
        for (cert_name,) in in_prog:
            items.append(
                RecommendationOut(
                    title=f"Finish {cert_name}",
                    why="You have every catalogue skill — completing this certification is your next win",
                    cta_label="Continue",
                    cta_route="/student/certifications",
                )
            )
        if len(items) < 3 and _resume_pct(db, student_id) < 100:
            items.append(
                RecommendationOut(
                    title="Complete your resume profile",
                    why="A fuller resume profile means a stronger auto-generated CV",
                    cta_label="Complete",
                    cta_route="/student/resume",
                )
            )

    return RecommendationsOut(items=items[:3])
