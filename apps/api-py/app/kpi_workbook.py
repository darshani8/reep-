"""The student-engagement KPI workbook: `python -m app.kpi_workbook`.

The office asked four questions of the data REEP already holds -- what the
registration form captures, how often students sign in, which screens they
visit, and which functionality they use -- plus one about the student record
itself (is a LinkedIn profile on file, and is it a real one). This module
answers them as ONE Excel workbook: data sheets, KPI sheets whose numbers are
spreadsheet formulas over those data sheets, and a pie chart beside every
part-to-whole table. `docs/student-engagement-kpis.md` is the catalogue of
every KPI here, with its definition and the table it reads.

WHAT IT READS, AND WHAT IT CANNOT.

  * Registration -- `registrations` and `registration_documents`: every box
    on `/register`, the rule or reviewer that decided it, when, and whether a
    CV and a photo came with it.
  * Sign-ins -- `login_days` (one row per student per calendar day, the
    streak's own table) and `login_events` (every successful sign-in, with the
    door and the browser). `users.last_login_at` is read too.
  * Functionality -- the rows each student screen writes when it is USED:
    `interview_sessions`, `agent_runs`, `resumes`, `uploads`, `badge_evidence`,
    `time_ledger_days`, `english_baselines`, `job_applications` and the SWOC
    acknowledgement stamp. `FEATURES` below is the list, each naming its
    screen and its table.
  * The record -- `students`, `student_profiles` and the spine the batch hangs
    on, plus whether marks and attendance have ever been imported for them.

  * PAGE VISITS ARE NOT RECORDED ANYWHERE IN THIS PRODUCT, and this workbook
    says so on a sheet of its own rather than drawing a chart from a proxy. A
    screen that only READS -- Leaderboards, Jobs, Records, Courses -- leaves
    no row when it is opened, the API logs no per-route counters, and the
    browser sends no beacon. "Most visited pages" therefore cannot be
    answered today; "most used functionality" can, from the rows above, and
    is. The gap sheet names what a page-view table would need to be.

AGGREGATES BY DEFAULT, NAMES ONLY WHEN ASKED. A spreadsheet of KPIs leaves
the building the moment it is downloaded (AGENTS.md on exports), and none of
the KPIs needs a name to be true. So the data sheets carry a student NUMBER,
never a name, USN or address -- unless `--roster` is passed, which adds them
for the one use that needs them: the office's follow-up list of who has no
LinkedIn profile on file. The run says, in its log line, which kind of file it
wrote. Nothing here writes to the database; it is SELECTs and a file.

FORMULAS, NOT PASTED NUMBERS. Every count and share on a KPI sheet is a
`COUNTIF`/`SUMIF`/`MEDIAN` over a data sheet, so the office can filter or
correct a row and watch the KPIs and the charts follow. openpyxl stores no
cached values, so the workbook asks Excel to calculate on open
(`fullCalcOnLoad`); a file opened in a previewer that cannot calculate shows
empty cells where the formulas are, which is the honest state of an
uncalculated workbook and not a bug in this module.

TIME IS THE PROGRAMME'S. "Today", "last 30 days" and the hour-of-day chart
are all in `clock.programme_tz()`, the zone the ledger's lock already uses,
because a sign-in at 23:30 IST is 18:00 UTC and a chart drawn in UTC would
tell the office its students study at six in the evening.

REAL DATA ONLY. There is no sample mode and no illustrative number anywhere
in this module: every cell comes from the database the process is pointed
at, and a deployment with nothing to count gets a workbook whose counts are
zero rather than one somebody filled in. To see the shape before a college
has data, run it against the dev seed.
"""

from __future__ import annotations

import argparse
import logging
import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, tzinfo
from pathlib import Path
from typing import Any, Iterable, NamedTuple

from openpyxl import Workbook
from openpyxl.chart import BarChart, PieChart, Reference
from openpyxl.chart.label import DataLabelList
from openpyxl.chart.series import DataPoint
from openpyxl.chart.shapes import GraphicalProperties
from openpyxl.drawing.line import LineProperties
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.workbook.properties import CalcProperties
from openpyxl.worksheet.worksheet import Worksheet
from sqlalchemy import func, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from .batch_labels import compose as compose_batch_label
from .clock import local_now, programme_tz
from .config import settings
from .db import SessionLocal
from .models.academics import SemesterResult
from .models.account_events import LoginEvent
from .models.agent_run import AgentRun
from .models.attendance import AttendanceRecord
from .models.badge import BadgeEvidence
from .models.cohort import Cohort
from .models.english_baseline import EnglishBaseline
from .models.institution import AcademicCourse, AcademicSpecialization, Department
from .models.interview import InterviewSession
from .models.job import JobApplication
from .models.registration import (
    DOCUMENT_KIND_CV,
    DOCUMENT_KIND_PHOTO,
    Registration,
    RegistrationDocument,
    RegistrationStatus,
)
from .models.resume import Resume
from .models.student_profile import StudentProfile
from .models.swoc import SwocEntry
from .models.time_ledger import TimeLedgerDay
from .models.upload import Upload
from .models.user import (
    STUDENT_STATUS_ACTIVE,
    STUDENT_STATUS_GRADUATED,
    LoginDay,
    Role,
    Student,
    User,
)

log = logging.getLogger(__name__)

#: How far back "recent" reaches when the command line does not say.
DEFAULT_WINDOW_DAYS = 30

# --------------------------------------------------------------------------- #
# Vocabulary. Every label the data sheets carry is spelled HERE, once, so the
# KPI tables' COUNTIF criteria and the cells they count cannot disagree.
# --------------------------------------------------------------------------- #

#: `login_events.door`, as `app/routers/auth.py` spells them (DOOR_*). A String
#: column, so an unknown value folds into "Other" rather than vanishing.
#: Pinned against the router's constants by tests/test_kpi_workbook.py, which
#: is why they are not imported from it: this module must not pull a FastAPI
#: router into a command-line process.
DOORS: tuple[str, ...] = ("password", "code", "google", "activation")
DOOR_LABELS: dict[str, str] = {
    "password": "Password",
    "code": "Emailed code",
    "google": "Google",
    "activation": "Activation link",
}
DOOR_OTHER = "Other"

DEVICE_ANDROID = "Android phone or tablet"
DEVICE_IOS = "iPhone or iPad"
DEVICE_WINDOWS = "Windows PC"
DEVICE_MAC = "Mac"
DEVICE_OTHER = "Other or unknown"
DEVICES: tuple[str, ...] = (DEVICE_ANDROID, DEVICE_IOS, DEVICE_WINDOWS, DEVICE_MAC, DEVICE_OTHER)

FREQ_NONE = "Not at all"
FREQ_1_2 = "1–2 days"
FREQ_3_7 = "3–7 days"
FREQ_8_15 = "8–15 days"
FREQ_16_PLUS = "16+ days"
FREQUENCY_BUCKETS: tuple[str, ...] = (FREQ_NONE, FREQ_1_2, FREQ_3_7, FREQ_8_15, FREQ_16_PLUS)

RECENCY_TODAY = "Today"
RECENCY_WEEK = "In the last 7 days"
RECENCY_MONTH = "8–30 days ago"
RECENCY_DORMANT = "Dormant (31–90 days)"
RECENCY_LOST = "Lost (over 90 days)"
RECENCY_NEVER = "Never signed in"
RECENCY_BUCKETS: tuple[str, ...] = (
    RECENCY_TODAY, RECENCY_WEEK, RECENCY_MONTH, RECENCY_DORMANT, RECENCY_LOST, RECENCY_NEVER,
)

LINKEDIN_PERSONAL = "Personal profile (linkedin.com/in/…)"
LINKEDIN_OTHER_PAGE = "Other LinkedIn page (company, school, post)"
LINKEDIN_SHORT = "Short link (lnkd.in)"
LINKEDIN_NOT_LINKEDIN = "Not a LinkedIn link"
LINKEDIN_MISSING = "Missing"
LINKEDIN_STATUSES: tuple[str, ...] = (
    LINKEDIN_PERSONAL, LINKEDIN_OTHER_PAGE, LINKEDIN_SHORT, LINKEDIN_NOT_LINKEDIN, LINKEDIN_MISSING,
)

COMPLETE_FULL = "Complete (90% or more)"
COMPLETE_MOST = "Mostly complete (60–89%)"
COMPLETE_STARTED = "Started (30–59%)"
COMPLETE_BARELY = "Barely started (under 30%)"
COMPLETE_NONE = "No profile yet"
COMPLETENESS_BUCKETS: tuple[str, ...] = (
    COMPLETE_FULL, COMPLETE_MOST, COMPLETE_STARTED, COMPLETE_BARELY, COMPLETE_NONE,
)

#: The profile fields that count towards completeness, in the order the
#: "Fields on file" table lists them. Twelve, all on `student_profiles`, all
#: things the student types or attaches themselves -- `placement_eligible` is
#: the office's and is reported separately.
PROFILE_FIELDS: tuple[str, ...] = (
    "Phone",
    "Contact email",
    "LinkedIn",
    "GitHub",
    "Portfolio",
    "City",
    "Career summary",
    "Education",
    "Experience",
    "Projects",
    "Skills",
    "Photo",
)

STAGE_LABELS: dict[str, str] = {
    "REBOOT": "Reboot",
    "EXCEL": "Excel",
    "EXCEL_ADVANCED": "Excel Advanced",
    "ELEVATE": "Elevate",
}

REGISTRATION_STATUS_LABELS: dict[str, str] = {
    RegistrationStatus.PENDING_REVIEW.value: "Waiting for review",
    RegistrationStatus.HOLD.value: "On hold",
    RegistrationStatus.AUTO_APPROVED.value: "Approved by rule",
    RegistrationStatus.APPROVED.value: "Approved by the office",
    RegistrationStatus.REJECTED.value: "Rejected",
    # Unreachable since 9b2d47f0ce15; kept so a legacy row labels itself.
    RegistrationStatus.PENDING_VERIFICATION.value: "Awaiting email confirmation (legacy)",
    RegistrationStatus.DRAFT.value: "Draft (legacy)",
}
#: The statuses the status pie draws, in a fixed order so a slice keeps its
#: colour from one month's workbook to the next.
REGISTRATION_STATUS_ORDER: tuple[str, ...] = (
    "Waiting for review",
    "On hold",
    "Approved by rule",
    "Approved by the office",
    "Rejected",
)

WEEKDAYS: tuple[str, ...] = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

YES = "Yes"
NO = "No"
#: What a registration row shows where the applicant named no rung.
NOT_STATED = "Not stated"


class Feature(NamedTuple):
    """One thing a student can DO in REEP that leaves a row behind."""

    key: str
    label: str
    #: The route under `apps/web/src/app/app.routes.ts` the action lives on.
    #: Pinned by a test so a KPI cannot name a screen that no longer exists.
    route: str
    #: Where the count comes from, in words, for the Definitions sheet.
    source: str


#: The functionality the workbook counts. One row per ACTION, read from the
#: table that action writes; a screen that only reads is not here, because it
#: leaves nothing to count (see the module docstring on page views).
FEATURES: tuple[Feature, ...] = (
    Feature("mock_interview", "Mock interview", "student/assistant",
            "interview_sessions.started_at (one row per interview opened)"),
    Feature("assistant", "REEP Agent (typed assistant)", "student/agent",
            "agent_runs.created_at where role = STUDENT (one row per question)"),
    Feature("ledger", "Time allocation ledger", "student/time-log",
            "time_ledger_days.created_at (one row per day saved)"),
    Feature("upload", "Uploads (CV, certificates, photo, documents)", "student/uploads",
            "uploads.uploaded_at"),
    Feature("badge_claim", "Skilling badge claim", "student/skilling",
            "badge_evidence.created_at (one row per claim filed)"),
    Feature("resume", "Resume builder", "student/resume",
            "resumes.created_at (one row per resume built)"),
    Feature("job_application", "Job application", "student/jobs",
            "job_applications.applied_at"),
    Feature("english", "English baseline", "student/english",
            "english_baselines.created_at (one attempt per semester)"),
    Feature("swoc_ack", "SWOC line acknowledged", "student/mentor-log",
            "swoc_entries.acknowledged_at (stamped when the student acknowledges a line)"),
)

#: The dataviz skill's categorical palette, in its fixed order: a slice keeps
#: the colour of its POSITION in the table, never of its rank by size, so the
#: same bucket is the same colour in every workbook. Six, which is also the
#: most slices any pie here draws.
PALETTE: tuple[str, ...] = ("2A78D6", "EB6834", "1BAF7A", "EDA100", "E87BA4", "008300")

FONT = "Arial"


# --------------------------------------------------------------------------- #
# The snapshot: plain rows, no ORM, so everything downstream runs without a
# database and the one function that talks to Postgres is `load_snapshot`.
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class StudentFacts:
    """One CURRENT student (status ACTIVE, account not removed)."""

    student_id: str
    user_id: str
    name: str
    usn: str | None
    email: str
    account_created_at: datetime | None
    last_login_at: datetime | None
    google_linked: bool
    password_set: bool
    disabled: bool
    stage: str
    semester: int
    seated: bool
    batch: str | None
    department: str | None
    course: str | None
    specialization: str | None
    mentor_assigned: bool
    profile_on_record: bool
    #: Which of PROFILE_FIELDS are filled in, by name.
    fields_on_file: frozenset[str]
    linkedin_url: str | None
    placement_eligible: bool | None
    interested_in_jobs: bool | None
    interested_in_internships: bool | None
    profile_updated_at: datetime | None
    marks_on_record: bool
    attendance_on_record: bool
    #: feature key -> (uses all time, uses inside the window)
    feature_uses: dict[str, tuple[int, int]] = field(default_factory=dict)
    mock_interviews_completed: int = 0


@dataclass(frozen=True)
class RegistrationFacts:
    """One application to join, as `/register` wrote it."""

    name: str
    email: str
    created_at: datetime
    status: str
    reviewed_at: datetime | None
    degree_level: str
    department: str | None
    course: str | None
    specialization: str | None
    dual: bool
    has_usn: bool
    has_phone: bool
    has_personal_email: bool
    has_linkedin: bool
    has_cv: bool
    has_photo: bool
    repeat_application: bool
    became_student: bool


@dataclass(frozen=True)
class SignIn:
    user_id: str
    at: datetime
    door: str
    user_agent: str | None


@dataclass(frozen=True)
class Snapshot:
    taken_at: datetime
    window_days: int
    source: str
    students: list[StudentFacts]
    graduated: int
    removed: int
    registrations: list[RegistrationFacts]
    #: (user_id, local calendar day) for every student, all time.
    login_days: list[tuple[str, date]]
    #: Every successful sign-in inside the window.
    sign_ins: list[SignIn]

    @property
    def today(self) -> date:
        return self.taken_at.date()

    @property
    def window_start(self) -> date:
        """The first calendar day the window covers (today counts as one)."""
        return self.today - timedelta(days=self.window_days - 1)


# --------------------------------------------------------------------------- #
# The pure helpers: classification and bucketing. Tested without a database.
# --------------------------------------------------------------------------- #


def classify_linkedin(url: str | None) -> str:
    """Which kind of thing sits in a LinkedIn box.

    Mirrors the host rule `RegisterIn._linkedin_shape` applies on the form
    (any linkedin.com subdomain, or lnkd.in) and then asks one more question
    the form does not: is it a PERSONAL profile (`/in/<handle>`), or a
    company, school or post page somebody pasted instead? The profile screen's
    own LinkedIn box has no validator at all, so rows written there can hold
    anything -- an Instagram handle, a bare "linkedin", a blank -- and each of
    those is its own status rather than a silent "present".
    """
    if url is None or not url.strip():
        return LINKEDIN_MISSING
    bare = url.strip()
    lowered = bare.lower()
    for prefix in ("http://", "https://"):
        if lowered.startswith(prefix):
            bare = bare[len(prefix):]
            break
    host, _, path = bare.partition("/")
    host = host.lower().strip()
    path = path.split("?", 1)[0].split("#", 1)[0].strip("/")
    if host == "lnkd.in":
        return LINKEDIN_SHORT if path else LINKEDIN_NOT_LINKEDIN
    if host == "linkedin.com" or host.endswith(".linkedin.com"):
        parts = [p for p in path.split("/") if p]
        if len(parts) >= 2 and parts[0].lower() == "in":
            return LINKEDIN_PERSONAL
        if parts:
            return LINKEDIN_OTHER_PAGE
        return LINKEDIN_NOT_LINKEDIN
    return LINKEDIN_NOT_LINKEDIN


def device_family(user_agent: str | None) -> str:
    """A coarse family from the browser's User-Agent, never a model or version.

    Coarse on purpose: the office wants "mostly phones" or "mostly the lab's
    PCs", and a finer parse is a maintenance job (an iPad in desktop mode
    reports itself as a Mac, and that is left as it reads). Never raises.
    """
    if not user_agent:
        return DEVICE_OTHER
    ua = user_agent.lower()
    if "android" in ua:
        return DEVICE_ANDROID
    if "iphone" in ua or "ipad" in ua or "ipod" in ua:
        return DEVICE_IOS
    if "windows" in ua:
        return DEVICE_WINDOWS
    if "macintosh" in ua or "mac os x" in ua:
        return DEVICE_MAC
    return DEVICE_OTHER


def door_label(door: str | None) -> str:
    return DOOR_LABELS.get((door or "").strip().lower(), DOOR_OTHER)


def frequency_bucket(days_active: int) -> str:
    """How many distinct days a student signed in inside the window."""
    if days_active <= 0:
        return FREQ_NONE
    if days_active <= 2:
        return FREQ_1_2
    if days_active <= 7:
        return FREQ_3_7
    if days_active <= 15:
        return FREQ_8_15
    return FREQ_16_PLUS


def recency_bucket(days_since_last: int | None) -> str:
    """How long since the last sign-in day. `None` means there never was one."""
    if days_since_last is None:
        return RECENCY_NEVER
    if days_since_last <= 0:
        return RECENCY_TODAY
    if days_since_last <= 7:
        return RECENCY_WEEK
    if days_since_last <= 30:
        return RECENCY_MONTH
    if days_since_last <= 90:
        return RECENCY_DORMANT
    return RECENCY_LOST


def completeness_bucket(on_record: bool, filled: int, total: int = len(PROFILE_FIELDS)) -> str:
    if not on_record:
        return COMPLETE_NONE
    share = filled / total if total else 0.0
    if share >= 0.9:
        return COMPLETE_FULL
    if share >= 0.6:
        return COMPLETE_MOST
    if share >= 0.3:
        return COMPLETE_STARTED
    return COMPLETE_BARELY


def streaks(days: Iterable[date], today: date) -> tuple[int, int]:
    """(current, longest) consecutive-day runs, the way `/student/streak`
    counts them: the current run may end today or yesterday, so a day that
    has not been opened yet does not break it."""
    ordered = sorted(set(days))
    if not ordered:
        return 0, 0
    longest = run = 1
    for prev, cur in zip(ordered, ordered[1:]):
        run = run + 1 if cur - prev == timedelta(days=1) else 1
        longest = max(longest, run)
    current = 0
    if ordered[-1] in (today, today - timedelta(days=1)):
        current = 1
        i = len(ordered) - 1
        while i > 0 and ordered[i] - ordered[i - 1] == timedelta(days=1):
            current += 1
            i -= 1
    return current, longest


# --------------------------------------------------------------------------- #
# Reading the database. The only function here that needs Postgres.
# --------------------------------------------------------------------------- #


def _local(dt: datetime | None, tz: tzinfo) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        # Every timestamp column in this schema is DateTime(timezone=True);
        # a naive value can only be a test's hand-built row, read as UTC.
        from datetime import timezone as _tz
        dt = dt.replace(tzinfo=_tz.utc)
    return dt.astimezone(tz)


def _count_by_owner(db: Session, owner_col, at_col, since: datetime, *where) -> dict[str, tuple[int, int]]:
    """owner id -> (rows all time, rows at or after `since`), in one query."""
    stmt = (
        select(owner_col, func.count(), func.count().filter(at_col >= since))
        .where(at_col.is_not(None), *where)
        .group_by(owner_col)
    )
    return {owner: (int(total or 0), int(recent or 0)) for owner, total, recent in db.execute(stmt).all()}


def _db_label() -> str:
    """host/database of the configured URL, never its password."""
    try:
        url = make_url(settings.sqlalchemy_url)
        return f"{url.host or 'localhost'}/{url.database or ''}"
    except Exception:  # pragma: no cover - a malformed URL fails long before here
        return "database"


def load_snapshot(db: Session, *, window_days: int = DEFAULT_WINDOW_DAYS, now: datetime | None = None) -> Snapshot:
    """Read everything the workbook needs, as plain rows.

    Current students only (`students.status = ACTIVE`, account not removed):
    AGENTS.md is explicit that `status` filters nothing by itself and a query
    that means "current students" must say so. Graduates and removed accounts
    are COUNTED, so the Summary can say how many rows the roster denominator
    leaves out, and read for nothing else.
    """
    tz = programme_tz()
    taken_at = (now or local_now()).astimezone(tz)
    today = taken_at.date()
    window_start = today - timedelta(days=window_days - 1)
    since = datetime.combine(window_start, time.min, tzinfo=tz)

    # --- the spine, as id -> name ---------------------------------------- #
    departments = {d.id: d.name for d in db.scalars(select(Department)).all()}
    courses = {c.id: c.name for c in db.scalars(select(AcademicCourse)).all()}
    specializations = {s.id: s.name for s in db.scalars(select(AcademicSpecialization)).all()}
    cohorts = {c.id: c for c in db.scalars(select(Cohort)).all()}

    def cohort_label(cohort_id: str | None) -> str | None:
        cohort = cohorts.get(cohort_id) if cohort_id else None
        if cohort is None:
            return None
        return compose_batch_label(
            courses.get(cohort.course_id) if cohort.course_id else None,
            specializations.get(cohort.specialization_id) if cohort.specialization_id else None,
            cohort.name,
            cohort.batch_label,
        )

    # --- students --------------------------------------------------------- #
    rows = db.execute(
        select(Student, User)
        .join(User, User.id == Student.user_id)
        .where(Student.status == STUDENT_STATUS_ACTIVE, User.deleted_at.is_(None))
        .order_by(User.created_at, User.email)
    ).all()
    user_ids = [u.id for _, u in rows]

    graduated = int(db.scalar(select(func.count()).select_from(Student).where(Student.status == STUDENT_STATUS_GRADUATED)) or 0)
    removed = int(db.scalar(select(func.count()).select_from(User).where(User.role == Role.STUDENT, User.deleted_at.is_not(None))) or 0)

    profiles = {p.student_id: p for p in db.scalars(select(StudentProfile)).all()}
    with_marks = set(db.scalars(select(SemesterResult.student_id).distinct()).all())
    with_attendance = set(db.scalars(select(AttendanceRecord.student_id).distinct()).all())

    # --- the functionality counts, one GROUP BY per feature ---------------- #
    by_student: dict[str, dict[str, tuple[int, int]]] = {
        "mock_interview": _count_by_owner(db, InterviewSession.student_id, InterviewSession.started_at, since),
        "ledger": _count_by_owner(db, TimeLedgerDay.student_id, TimeLedgerDay.created_at, since),
        "upload": _count_by_owner(db, Upload.student_id, Upload.uploaded_at, since),
        "badge_claim": _count_by_owner(db, BadgeEvidence.student_id, BadgeEvidence.created_at, since),
        "resume": _count_by_owner(db, Resume.student_id, Resume.created_at, since),
        "job_application": _count_by_owner(db, JobApplication.student_id, JobApplication.applied_at, since),
        "english": _count_by_owner(db, EnglishBaseline.student_id, EnglishBaseline.created_at, since),
        "swoc_ack": _count_by_owner(db, SwocEntry.student_id, SwocEntry.acknowledged_at, since),
    }
    assistant_by_user = _count_by_owner(
        db, AgentRun.actor_id, AgentRun.created_at, since, AgentRun.role == Role.STUDENT
    )
    completed_by_student = _count_by_owner(
        db, InterviewSession.student_id, InterviewSession.started_at, since,
        InterviewSession.status == "completed",
    )
    missing = {f.key for f in FEATURES} - set(by_student) - {"assistant"}
    if missing:  # pragma: no cover - a FEATURES entry nobody wired a query for
        raise RuntimeError(f"FEATURES names {sorted(missing)} but load_snapshot counts nothing for them")

    students: list[StudentFacts] = []
    for s, u in rows:
        cohort = cohorts.get(s.cohort_id) if s.cohort_id else None
        department_id = (cohort.department_id if cohort and cohort.department_id else None) or s.department_id
        p = profiles.get(s.id)
        on_file: set[str] = set()
        if p is not None:
            if p.phone and p.phone.strip():
                on_file.add("Phone")
            if p.email and p.email.strip():
                on_file.add("Contact email")
            if p.linkedin_url and p.linkedin_url.strip():
                on_file.add("LinkedIn")
            if p.github_url and p.github_url.strip():
                on_file.add("GitHub")
            if p.portfolio_url and p.portfolio_url.strip():
                on_file.add("Portfolio")
            if p.city and p.city.strip():
                on_file.add("City")
            if p.career_summary and p.career_summary.strip():
                on_file.add("Career summary")
            if p.education:
                on_file.add("Education")
            if p.experience:
                on_file.add("Experience")
            if p.projects:
                on_file.add("Projects")
            if p.skills:
                on_file.add("Skills")
            if p.photo_upload_id:
                on_file.add("Photo")
        uses = {key: counts.get(s.id, (0, 0)) for key, counts in by_student.items()}
        uses["assistant"] = assistant_by_user.get(u.id, (0, 0))
        students.append(
            StudentFacts(
                student_id=s.id,
                user_id=u.id,
                name=u.name,
                usn=s.usn,
                email=u.email,
                account_created_at=_local(u.created_at, tz),
                last_login_at=_local(u.last_login_at, tz),
                google_linked=u.google_sub is not None,
                password_set=(u.password_hash or "").startswith("scrypt:"),
                disabled=u.disabled_at is not None,
                stage=s.current_stage.value if hasattr(s.current_stage, "value") else str(s.current_stage),
                semester=int(s.current_semester or 1),
                seated=s.cohort_id is not None,
                batch=cohort_label(s.cohort_id),
                department=departments.get(department_id) if department_id else None,
                course=courses.get(cohort.course_id) if cohort and cohort.course_id else None,
                specialization=(
                    specializations.get(cohort.specialization_id) if cohort and cohort.specialization_id else None
                ),
                mentor_assigned=s.mentor_id is not None,
                profile_on_record=p is not None,
                fields_on_file=frozenset(on_file),
                linkedin_url=(p.linkedin_url if p is not None else None),
                placement_eligible=(bool(p.placement_eligible) if p is not None else None),
                interested_in_jobs=(bool(p.interested_in_jobs) if p is not None else None),
                interested_in_internships=(bool(p.interested_in_internships) if p is not None else None),
                profile_updated_at=_local(p.updated_at, tz) if p is not None else None,
                marks_on_record=s.id in with_marks,
                attendance_on_record=s.id in with_attendance,
                feature_uses=uses,
                mock_interviews_completed=completed_by_student.get(s.id, (0, 0))[0],
            )
        )

    # --- sign-ins ----------------------------------------------------------- #
    login_days: list[tuple[str, date]] = []
    sign_ins: list[SignIn] = []
    if user_ids:
        login_days = [
            (uid, day)
            for uid, day in db.execute(
                select(LoginDay.user_id, LoginDay.day).where(LoginDay.user_id.in_(user_ids))
            ).all()
        ]
        sign_ins = [
            SignIn(user_id=uid, at=_local(at, tz), door=door, user_agent=agent)
            for uid, at, door, agent in db.execute(
                select(LoginEvent.user_id, LoginEvent.at, LoginEvent.door, LoginEvent.user_agent)
                .where(LoginEvent.user_id.in_(user_ids), LoginEvent.at >= since)
                .order_by(LoginEvent.at)
            ).all()
        ]

    # --- registrations ------------------------------------------------------ #
    documents: dict[str, set[str]] = defaultdict(set)
    for reg_id, kind in db.execute(select(RegistrationDocument.registration_id, RegistrationDocument.kind)).all():
        documents[reg_id].add(kind)
    repeated = {
        email
        for (email,) in db.execute(
            select(Registration.email).group_by(Registration.email).having(func.count() > 1)
        ).all()
    }
    registrations: list[RegistrationFacts] = []
    for r in db.scalars(select(Registration).order_by(Registration.created_at)).all():
        cohort = cohorts.get(r.cohort_id or r.requested_cohort_id or "") if (r.cohort_id or r.requested_cohort_id) else None
        department_id = r.department_id or (cohort.department_id if cohort else None)
        course_id = r.course_id or (cohort.course_id if cohort else None)
        spec_id = r.specialization_id or (cohort.specialization_id if cohort else None)
        status = r.status.value if hasattr(r.status, "value") else str(r.status)
        registrations.append(
            RegistrationFacts(
                name=r.name,
                email=r.email,
                created_at=_local(r.created_at, tz),
                status=status,
                reviewed_at=_local(r.reviewed_at, tz),
                degree_level=r.degree_level.value if hasattr(r.degree_level, "value") else str(r.degree_level),
                department=departments.get(department_id) if department_id else None,
                course=courses.get(course_id) if course_id else None,
                specialization=specializations.get(spec_id) if spec_id else None,
                dual=r.second_specialization_id is not None,
                has_usn=bool(r.usn and r.usn.strip()),
                has_phone=bool(r.phone and r.phone.strip()),
                has_personal_email=bool(r.personal_email and r.personal_email.strip()),
                has_linkedin=bool(r.linkedin_url and r.linkedin_url.strip()),
                has_cv=DOCUMENT_KIND_CV in documents.get(r.id, set()),
                has_photo=DOCUMENT_KIND_PHOTO in documents.get(r.id, set()),
                repeat_application=r.email in repeated,
                became_student=r.approved_student_id is not None,
            )
        )

    return Snapshot(
        taken_at=taken_at,
        window_days=window_days,
        source=_db_label(),
        students=students,
        graduated=graduated,
        removed=removed,
        registrations=registrations,
        login_days=login_days,
        sign_ins=sign_ins,
    )


# --------------------------------------------------------------------------- #
# Writing the workbook.
# --------------------------------------------------------------------------- #

SHEET_SUMMARY = "Summary"
SHEET_REGISTRATION = "Registration"
SHEET_SIGN_INS = "Sign-ins"
SHEET_FUNCTIONALITY = "Functionality"
SHEET_PROFILE = "Profile & LinkedIn"
SHEET_PAGE_VIEWS = "Page views (not recorded)"
SHEET_DEFINITIONS = "Definitions"
SHEET_DATA_STUDENTS = "Data - Students"
SHEET_DATA_REGISTRATIONS = "Data - Registrations"
SHEET_DATA_SIGN_INS = "Data - Sign-ins"

#: The columns `--roster` adds. Their absence is what the no-names test pins.
ROSTER_STUDENT_COLUMNS: tuple[str, ...] = ("Name", "USN", "College email", "LinkedIn URL")
ROSTER_REGISTRATION_COLUMNS: tuple[str, ...] = ("Applicant name", "College email")

_HEADER_FILL = PatternFill("solid", fgColor="E8E6E1")
_BAND_FILL = PatternFill("solid", fgColor="F6F5F2")
_INK = "0B0B0B"
_INK_MUTED = "52514E"

FMT_INT = "#,##0"
FMT_PCT = "0.0%"
FMT_DEC = "0.0"
FMT_DATE = "yyyy-mm-dd"
FMT_DATETIME = "yyyy-mm-dd hh:mm"
FMT_MONTH = "mmm yyyy"


def _font(*, bold: bool = False, size: int = 10, color: str = _INK, italic: bool = False) -> Font:
    return Font(name=FONT, bold=bold, size=size, color=color, italic=italic)


def _qs(sheet: str) -> str:
    """A sheet name quoted for a formula; every title here has a space or an
    ampersand, and an unquoted one evaluates to #VALUE!."""
    return "'" + sheet.replace("'", "''") + "'"


def _naive(dt: datetime | None) -> datetime | None:
    """openpyxl writes naive datetimes; ours are already in the programme's zone."""
    return dt.replace(tzinfo=None) if dt is not None else None


def _yes(value: bool | None) -> str | None:
    if value is None:
        return None
    return YES if value else NO


class DataSheet:
    """A flat table: one header row, one row per thing, frozen and filterable.

    `rng(header)` hands back the absolute range of a column for the KPI
    sheets' formulas, so a column added or re-ordered here moves every formula
    with it; a formula written as `$J$2:$J$141` by hand would not.
    """

    def __init__(self, ws: Worksheet, headers: list[str]) -> None:
        if len(set(headers)) != len(headers):
            raise ValueError("data sheet headers must be unique")
        self.ws = ws
        self.headers = headers
        self.col = {h: i + 1 for i, h in enumerate(headers)}
        self.n = 0
        for c, h in enumerate(headers, start=1):
            cell = ws.cell(row=1, column=c, value=h)
            cell.font = _font(bold=True)
            cell.fill = _HEADER_FILL
            cell.alignment = Alignment(wrap_text=True, vertical="top")
        ws.freeze_panes = "B2"
        ws.row_dimensions[1].height = 42

    def add(self, values: dict[str, Any], formats: dict[str, str] | None = None) -> None:
        self.n += 1
        r = self.n + 1
        for header, value in values.items():
            c = self.col[header]
            cell = self.ws.cell(row=r, column=c, value=value)
            cell.font = _font()
            if formats and header in formats:
                cell.number_format = formats[header]

    def finish(self, widths: dict[str, float] | None = None, default_width: float = 14) -> None:
        last_row = max(self.n + 1, 2)
        self.ws.auto_filter.ref = f"A1:{get_column_letter(len(self.headers))}{last_row}"
        for h, c in self.col.items():
            self.ws.column_dimensions[get_column_letter(c)].width = (widths or {}).get(h, default_width)

    def rng(self, header: str) -> str:
        letter = get_column_letter(self.col[header])
        last = max(self.n + 1, 2)
        return f"{_qs(self.ws.title)}!${letter}$2:${letter}${last}"


class KpiSheet:
    """A report sheet: a title block, then blocks of labelled formulas and
    small tables, each table with its chart to the right."""

    CHART_COL = "F"
    CHART_ROWS = 16

    def __init__(self, wb: Workbook, title: str, snapshot: Snapshot, blurb: str) -> None:
        self.ws = wb.create_sheet(title)
        self.snapshot = snapshot
        self.cells: dict[str, str] = {}
        self.r = 1
        ws = self.ws
        ws.column_dimensions["A"].width = 44
        ws.column_dimensions["B"].width = 16
        ws.column_dimensions["C"].width = 14
        ws.column_dimensions["D"].width = 16
        ws.column_dimensions["E"].width = 4
        self._write(1, 1, title, _font(bold=True, size=14))
        self._write(2, 1, blurb, _font(color=_INK_MUTED, italic=True))
        stamp = (
            f"Generated {snapshot.taken_at:%d %b %Y %H:%M} ({snapshot.taken_at.tzname()}) · "
            f"source: {snapshot.source} · window: last {snapshot.window_days} days "
            f"({snapshot.window_start:%d %b %Y} – {snapshot.today:%d %b %Y})"
        )
        self._write(3, 1, stamp, _font(color=_INK_MUTED))
        self.r = 5

    # -- primitives ------------------------------------------------------- #

    def _write(self, row: int, col: int, value: Any, font: Font | None = None, fmt: str | None = None):
        cell = self.ws.cell(row=row, column=col, value=value)
        cell.font = font or _font()
        if fmt:
            cell.number_format = fmt
        return cell

    def ref(self, row: int, col: int) -> str:
        return f"${get_column_letter(col)}${row}"

    def xref(self, row: int, col: int) -> str:
        return f"{_qs(self.ws.title)}!{self.ref(row, col)}"

    def heading(self, text: str) -> None:
        self.r += 1
        self._write(self.r, 1, text, _font(bold=True, size=12))
        self.r += 1

    def note(self, text: str) -> None:
        cell = self._write(self.r, 1, text, _font(color=_INK_MUTED, italic=True))
        cell.alignment = Alignment(wrap_text=True, vertical="top")
        self.ws.merge_cells(start_row=self.r, start_column=1, end_row=self.r, end_column=4)
        self.ws.row_dimensions[self.r].height = max(15, 15 * math.ceil(len(text) / 95))
        self.r += 1

    def kpi(self, label: str, formula: Any, fmt: str = FMT_INT, note: str | None = None, key: str | None = None) -> str:
        """One labelled number. Returns the absolute ref of the value cell."""
        self._write(self.r, 1, label)
        self._write(self.r, 2, formula, _font(bold=True), fmt)
        if note:
            cell = self._write(self.r, 3, note, _font(color=_INK_MUTED))
            cell.alignment = Alignment(wrap_text=False)
        ref = self.ref(self.r, 2)
        if key:
            self.cells[key] = self.xref(self.r, 2)
        self.r += 1
        return ref

    def table(self, headers: list[str], rows: list[list[Any]], formats: dict[int, str] | None = None) -> tuple[int, int]:
        """Writes a small table at the cursor; returns (first data row, last data row)."""
        for c, h in enumerate(headers, start=1):
            cell = self._write(self.r, c, h, _font(bold=True))
            cell.fill = _HEADER_FILL
        self.r += 1
        first = self.r
        for i, row in enumerate(rows):
            for c, value in enumerate(row, start=1):
                cell = self._write(self.r, c, value, fmt=(formats or {}).get(c))
                if i % 2 == 1:
                    cell.fill = _BAND_FILL
            self.r += 1
        return first, self.r - 1

    def share_table(self, label_header: str, count_header: str, labels: list[str], count_formula, key_prefix: str | None = None) -> tuple[int, int, str]:
        """label | count (formula) | share (formula) + a total row. Returns
        (first data row, last data row, total cell ref)."""
        first = self.r + 1
        total_row = first + len(labels)
        total_ref = self.ref(total_row, 2)
        rows = []
        for i, label in enumerate(labels):
            r = first + i
            rows.append([label, count_formula(label, r), f'=IF({total_ref}=0,"",{self.ref(r, 2)}/{total_ref})'])
        self.table([label_header, count_header, "Share"], rows, {2: FMT_INT, 3: FMT_PCT})
        self._write(self.r, 1, "Total", _font(bold=True))
        self._write(self.r, 2, f"=SUM({self.ref(first, 2)}:{self.ref(total_row - 1, 2)})", _font(bold=True), FMT_INT)
        if key_prefix:
            for i, label in enumerate(labels):
                self.cells[f"{key_prefix}:{label}"] = self.xref(first + i, 2)
            self.cells[f"{key_prefix}:total"] = self.xref(total_row, 2)
        self.r += 1
        return first, total_row - 1, total_ref

    # -- charts ----------------------------------------------------------- #

    def pie(self, title: str, first: int, last: int, anchor_row: int, label_col: int = 1, value_col: int = 2) -> PieChart:
        """A pie beside a share table. Six slices at most, in the table's
        order, each the palette colour of its POSITION; a white hairline
        between slices; percentages on the slices and the names in the legend
        so identity is never colour alone."""
        if last - first + 1 > len(PALETTE):
            raise ValueError(f"a pie draws at most {len(PALETTE)} slices; fold the rest into Other")
        chart = PieChart()
        chart.title = title
        chart.height = 7.5
        chart.width = 13.5
        data = Reference(self.ws, min_col=value_col, min_row=first, max_row=last)
        labels = Reference(self.ws, min_col=label_col, min_row=first, max_row=last)
        chart.add_data(data, titles_from_data=False)
        chart.set_categories(labels)
        series = chart.series[0]
        series.dPt = []
        for i in range(last - first + 1):
            gp = GraphicalProperties(solidFill=PALETTE[i])
            gp.line = LineProperties(solidFill="FFFFFF", w=19050)
            series.dPt.append(DataPoint(idx=i, spPr=gp))
        chart.dataLabels = DataLabelList()
        chart.dataLabels.showPercent = True
        chart.dataLabels.showVal = False
        chart.dataLabels.showCatName = False
        chart.dataLabels.showSerName = False
        chart.dataLabels.showLeaderLines = True
        chart.legend.position = "r"
        self.ws.add_chart(chart, f"{self.CHART_COL}{anchor_row}")
        self.r = max(self.r, anchor_row + self.CHART_ROWS)
        return chart

    def bar(self, title: str, first: int, last: int, anchor_row: int, y_title: str, label_col: int = 1, value_col: int = 2, horizontal: bool = False) -> BarChart:
        chart = BarChart()
        chart.type = "bar" if horizontal else "col"
        chart.title = title
        chart.height = 7.5
        chart.width = 13.5 if not horizontal else 16
        data = Reference(self.ws, min_col=value_col, min_row=first, max_row=last)
        labels = Reference(self.ws, min_col=label_col, min_row=first, max_row=last)
        chart.add_data(data, titles_from_data=False)
        chart.set_categories(labels)
        series = chart.series[0]
        series.graphicalProperties = GraphicalProperties(solidFill=PALETTE[0])
        series.graphicalProperties.line = LineProperties(solidFill=PALETTE[0])
        chart.legend = None
        chart.y_axis.title = y_title
        chart.y_axis.majorGridlines = None
        chart.gapWidth = 60
        self.ws.add_chart(chart, f"{self.CHART_COL}{anchor_row}")
        self.r = max(self.r, anchor_row + self.CHART_ROWS)
        return chart


def _top_categories(counter: Counter, limit: int = 5) -> tuple[list[str], bool]:
    """The `limit` largest categories by count, then everything else folds
    into one 'Other' row -- the dataviz rule that a ninth series is never a
    ninth colour. Returns (categories, whether an Other row is needed)."""
    ordered = [name for name, _ in counter.most_common()]
    if len(ordered) <= limit:
        return ordered, False
    return ordered[:limit], True


# --- the data sheets --------------------------------------------------------- #


def _student_headers(window_days: int, roster: bool) -> list[str]:
    headers = ["Student #"]
    if roster:
        headers += ["Name", "USN", "College email"]
    headers += [
        "Stage", "Semester", "Department", "Course", "Specialization", "Batch",
        "Seated in a batch", "Faculty mentor assigned", "Google linked", "Password set", "Account disabled",
        "Account created", "Last sign-in", "Days since last sign-in",
        f"Sign-in days (last {window_days} days)", "Sign-in days (all time)",
        "Current streak (days)", "Longest streak (days)", "Sign-in frequency", "Sign-in recency",
        "Profile on record", "Profile completeness", "Completeness band", "LinkedIn status",
    ]
    if roster:
        headers += ["LinkedIn URL"]
    headers += [f"{name} on file" for name in PROFILE_FIELDS]
    headers += [
        "Placement eligible", "Interested in jobs", "Interested in internships",
        "Marks on record", "Attendance on record", f"Profile edited (last {window_days} days)",
    ]
    for feature in FEATURES:
        headers += [f"{feature.label} · last {window_days} days", f"{feature.label} · all time"]
    headers += [
        "Mock interviews completed · all time",
        f"Features used (last {window_days} days)",
        f"Used anything (last {window_days} days)",
    ]
    return headers


def write_students_sheet(wb: Workbook, snapshot: Snapshot, *, roster: bool) -> DataSheet:
    ws = wb.create_sheet(SHEET_DATA_STUDENTS)
    w = snapshot.window_days
    sheet = DataSheet(ws, _student_headers(w, roster))
    days_by_user: dict[str, set[date]] = defaultdict(set)
    for uid, day in snapshot.login_days:
        days_by_user[uid].add(day)
    formats = {
        "Account created": FMT_DATE, "Last sign-in": FMT_DATE, "Profile completeness": FMT_PCT,
    }
    for index, s in enumerate(snapshot.students, start=1):
        days = days_by_user.get(s.user_id, set())
        last_day = max(days) if days else (s.last_login_at.date() if s.last_login_at else None)
        days_since = (snapshot.today - last_day).days if last_day else None
        recent = sum(1 for d in days if d >= snapshot.window_start)
        current, longest = streaks(days, snapshot.today)
        filled = len(s.fields_on_file)
        features_used = sum(1 for f in FEATURES if s.feature_uses.get(f.key, (0, 0))[1] > 0)
        row: dict[str, Any] = {"Student #": index}
        if roster:
            row.update({"Name": s.name, "USN": s.usn, "College email": s.email, "LinkedIn URL": s.linkedin_url})
        row.update({
            "Stage": STAGE_LABELS.get(s.stage, s.stage),
            "Semester": s.semester,
            "Department": s.department,
            "Course": s.course,
            "Specialization": s.specialization,
            "Batch": s.batch,
            "Seated in a batch": _yes(s.seated),
            "Faculty mentor assigned": _yes(s.mentor_assigned),
            "Google linked": _yes(s.google_linked),
            "Password set": _yes(s.password_set),
            "Account disabled": _yes(s.disabled),
            "Account created": _naive(s.account_created_at),
            "Last sign-in": last_day,
            "Days since last sign-in": days_since,
            f"Sign-in days (last {w} days)": recent,
            "Sign-in days (all time)": len(days),
            "Current streak (days)": current,
            "Longest streak (days)": longest,
            "Sign-in frequency": frequency_bucket(recent),
            "Sign-in recency": recency_bucket(days_since),
            "Profile on record": _yes(s.profile_on_record),
            "Profile completeness": (filled / len(PROFILE_FIELDS)) if s.profile_on_record else None,
            "Completeness band": completeness_bucket(s.profile_on_record, filled),
            "LinkedIn status": classify_linkedin(s.linkedin_url) if s.profile_on_record else LINKEDIN_MISSING,
            "Placement eligible": _yes(s.placement_eligible),
            "Interested in jobs": _yes(s.interested_in_jobs),
            "Interested in internships": _yes(s.interested_in_internships),
            "Marks on record": _yes(s.marks_on_record),
            "Attendance on record": _yes(s.attendance_on_record),
            f"Profile edited (last {w} days)": _yes(
                s.profile_updated_at is not None and s.profile_updated_at.date() >= snapshot.window_start
            ),
            "Mock interviews completed · all time": s.mock_interviews_completed,
            f"Features used (last {w} days)": features_used,
            f"Used anything (last {w} days)": _yes(features_used > 0),
        })
        for name in PROFILE_FIELDS:
            row[f"{name} on file"] = _yes(name in s.fields_on_file) if s.profile_on_record else NO
        for feature in FEATURES:
            all_time, recent_uses = s.feature_uses.get(feature.key, (0, 0))
            row[f"{feature.label} · last {w} days"] = recent_uses
            row[f"{feature.label} · all time"] = all_time
        sheet.add(row, formats)
    sheet.finish(
        {"Name": 24, "College email": 30, "LinkedIn URL": 44, "Batch": 30, "Department": 22,
         "Course": 22, "Specialization": 20, "LinkedIn status": 34, "Completeness band": 26,
         "Sign-in recency": 22, "Sign-in frequency": 16},
    )
    return sheet


def write_registrations_sheet(wb: Workbook, snapshot: Snapshot, *, roster: bool) -> DataSheet:
    ws = wb.create_sheet(SHEET_DATA_REGISTRATIONS)
    headers = ["Application #"]
    if roster:
        headers += list(ROSTER_REGISTRATION_COLUMNS)
    headers += [
        "Submitted", "Month", "Status", "Decided", "Decided at", "Hours to decision", "Days waiting",
        "Degree level", "Department", "Course", "Specialization", "Dual specialization",
        "USN given", "Phone given", "Personal email given", "LinkedIn given", "CV attached", "Photo attached",
        "Repeat application", "Became a student",
    ]
    sheet = DataSheet(ws, headers)
    formats = {"Submitted": FMT_DATETIME, "Month": FMT_MONTH, "Decided at": FMT_DATETIME, "Hours to decision": FMT_DEC}
    now = snapshot.taken_at
    for index, r in enumerate(snapshot.registrations, start=1):
        status_label = REGISTRATION_STATUS_LABELS.get(r.status, r.status)
        decided_at: datetime | None
        hours: float | None
        waiting: int | None
        if r.status == RegistrationStatus.AUTO_APPROVED.value:
            decided_at, hours, waiting = r.created_at, 0.0, None  # decided at submit, by a rule
        elif r.status in (RegistrationStatus.APPROVED.value, RegistrationStatus.REJECTED.value):
            decided_at = r.reviewed_at
            hours = round((r.reviewed_at - r.created_at).total_seconds() / 3600, 1) if r.reviewed_at else None
            waiting = None
        else:
            decided_at, hours = None, None
            waiting = max(0, (now - r.created_at).days)
        row: dict[str, Any] = {"Application #": index}
        if roster:
            row.update({"Applicant name": r.name, "College email": r.email})
        row.update({
            "Submitted": _naive(r.created_at),
            "Month": date(r.created_at.year, r.created_at.month, 1),
            "Status": status_label,
            "Decided": _yes(decided_at is not None),
            "Decided at": _naive(decided_at),
            "Hours to decision": hours,
            "Days waiting": waiting,
            "Degree level": r.degree_level,
            "Department": r.department or NOT_STATED,
            "Course": r.course or NOT_STATED,
            "Specialization": r.specialization or NOT_STATED,
            "Dual specialization": _yes(r.dual),
            "USN given": _yes(r.has_usn),
            "Phone given": _yes(r.has_phone),
            "Personal email given": _yes(r.has_personal_email),
            "LinkedIn given": _yes(r.has_linkedin),
            "CV attached": _yes(r.has_cv),
            "Photo attached": _yes(r.has_photo),
            "Repeat application": _yes(r.repeat_application),
            "Became a student": _yes(r.became_student),
        })
        sheet.add(row, formats)
    sheet.finish({"Applicant name": 24, "College email": 30, "Submitted": 17, "Decided at": 17,
                  "Status": 24, "Department": 22, "Course": 22, "Specialization": 20})
    return sheet


def write_sign_ins_sheet(wb: Workbook, snapshot: Snapshot) -> DataSheet:
    ws = wb.create_sheet(SHEET_DATA_SIGN_INS)
    sheet = DataSheet(ws, ["Student #", "Signed in at", "Day", "Weekday", "Hour", "Door", "Device"])
    index_of = {s.user_id: i for i, s in enumerate(snapshot.students, start=1)}
    formats = {"Signed in at": FMT_DATETIME, "Day": FMT_DATE}
    for e in sorted(snapshot.sign_ins, key=lambda x: x.at):
        if e.user_id not in index_of:
            continue
        sheet.add({
            "Student #": index_of[e.user_id],
            "Signed in at": _naive(e.at),
            "Day": e.at.date(),
            "Weekday": WEEKDAYS[e.at.weekday()],
            "Hour": e.at.hour,
            "Door": door_label(e.door),
            "Device": device_family(e.user_agent),
        }, formats)
    sheet.finish({"Signed in at": 17, "Door": 16, "Device": 24})
    return sheet


# --- the KPI sheets -------------------------------------------------------- #


def write_sign_in_kpis(wb: Workbook, snapshot: Snapshot, students: DataSheet, events: DataSheet) -> KpiSheet:
    w = snapshot.window_days
    k = KpiSheet(wb, SHEET_SIGN_INS, snapshot,
                 "How often current students come back: active counts, frequency, recency, streaks, "
                 "the door they use and the device they use it from.")
    idx = students.rng("Student #")
    recent = students.rng(f"Sign-in days (last {w} days)")
    since = students.rng("Days since last sign-in")
    recency = students.rng("Sign-in recency")
    freq = students.rng("Sign-in frequency")
    current = students.rng("Current streak (days)")
    longest = students.rng("Longest streak (days)")

    k.heading("Active students")
    total = k.kpi("Current students", f"=COUNT({idx})", note="Status ACTIVE, account not removed.", key="students")
    k.kpi("Signed in today (daily active)", f"=COUNTIF({since},0)", note="A sign-in day equal to today.", key="dau")
    k.kpi("Signed in in the last 7 days (weekly active)", f'=COUNTIF({since},"<=6")', key="wau")
    mau = k.kpi(f"Signed in in the last {w} days (active)", f'=COUNTIF({recent},">0")',
                note=f"At least one sign-in day inside the {w}-day window.", key="mau")
    k.kpi("Active share", f'=IF({total}=0,"",{mau}/{total})', FMT_PCT,
          note="Active students as a share of current students.", key="active_share")
    k.kpi("Stickiness (daily ÷ active)", f'=IF({mau}=0,"",{k.cells["dau"].split("!")[1]}/{mau})', FMT_PCT,
          note="How much of the month's audience is there on a given day.", key="stickiness")
    k.kpi("Never signed in", f'=COUNTIF({recency},"{RECENCY_NEVER}")',
          note="Accounts that exist on the roster and have never been used.", key="never")
    k.kpi(f"Sign-in days per active student (last {w} days)",
          f'=IF(COUNTIF({recent},">0")=0,"",SUMIF({recent},">0")/COUNTIF({recent},">0"))', FMT_DEC,
          note="Average distinct days, over the students who signed in at all.", key="days_per_active")
    k.kpi(f"Sign-ins recorded (last {w} days)", f"=COUNT({events.rng('Student #')})",
          note="Every successful sign-in, every door; a student signing in twice a day counts twice.", key="sign_ins")

    k.heading(f"Sign-in frequency (distinct days, last {w} days)")
    first, last, _ = k.share_table("Days signed in", "Students", list(FREQUENCY_BUCKETS),
                                   lambda label, r: f"=COUNTIF({freq},{k.ref(r, 1)})", key_prefix="freq")
    k.pie("Sign-in frequency", first, last, first - 2)

    k.heading("Sign-in recency (days since the last sign-in)")
    first, last, _ = k.share_table("Last signed in", "Students", list(RECENCY_BUCKETS),
                                   lambda label, r: f"=COUNTIF({recency},{k.ref(r, 1)})", key_prefix="recency")
    k.pie("Sign-in recency", first, last, first - 2)

    k.heading("Streaks (consecutive sign-in days, as the student's own screen counts them)")
    k.kpi("Students on a streak of 7 days or more", f'=COUNTIF({current},">=7")', key="streak7")
    k.kpi("Median current streak (active students)",
          f'=IF(COUNTIF({current},">0")=0,"",MEDIAN({current}))', FMT_DEC,
          note="Median over every current student, zeros included.", key="streak_median")
    k.kpi("Longest streak on record", f"=MAX({longest})", key="streak_longest")

    door = events.rng("Door")
    k.heading(f"Which door (last {w} days)")
    first, last, _ = k.share_table("Door", "Sign-ins", [DOOR_LABELS[d] for d in DOORS] + [DOOR_OTHER],
                                   lambda label, r: f"=COUNTIF({door},{k.ref(r, 1)})", key_prefix="door")
    k.pie("Sign-in door", first, last, first - 2)

    device = events.rng("Device")
    k.heading(f"Which device (last {w} days)")
    first, last, _ = k.share_table("Device", "Sign-ins", list(DEVICES),
                                   lambda label, r: f"=COUNTIF({device},{k.ref(r, 1)})", key_prefix="device")
    k.pie("Device", first, last, first - 2)

    weekday = events.rng("Weekday")
    k.heading(f"When in the week (last {w} days)")
    first, last = k.table(["Weekday", "Sign-ins"],
                          [[d, None] for d in WEEKDAYS], {2: FMT_INT})
    for r in range(first, last + 1):
        k._write(r, 2, f"=COUNTIF({weekday},{k.ref(r, 1)})", fmt=FMT_INT)
    k.bar("Sign-ins by weekday", first, last, first - 2, "Sign-ins")

    hour = events.rng("Hour")
    k.heading(f"When in the day (hour, {snapshot.taken_at.tzname()}; last {w} days)")
    first, last = k.table(["Hour", "Sign-ins"], [[h, None] for h in range(24)], {2: FMT_INT})
    for r in range(first, last + 1):
        k._write(r, 2, f"=COUNTIF({hour},{k.ref(r, 1)})", fmt=FMT_INT)
    k.bar("Sign-ins by hour of day", first, last, first - 2, "Sign-ins")
    return k


def write_registration_kpis(wb: Workbook, snapshot: Snapshot, regs: DataSheet) -> KpiSheet:
    w = snapshot.window_days
    k = KpiSheet(wb, SHEET_REGISTRATION, snapshot,
                 "What the public /register form captured, how the office decided it, and how complete "
                 "the applications were.")
    idx = regs.rng("Application #")
    status = regs.rng("Status")
    submitted = regs.rng("Submitted")
    hours = regs.rng("Hours to decision")
    waiting = regs.rng("Days waiting")
    month = regs.rng("Month")
    became = regs.rng("Became a student")
    dual = regs.rng("Dual specialization")
    repeat = regs.rng("Repeat application")
    since = _naive(datetime.combine(snapshot.window_start, time.min, tzinfo=snapshot.taken_at.tzinfo))

    k.heading("Applications")
    total = k.kpi("Applications received (all time)", f"=COUNT({idx})", key="applications")
    k._write(k.r, 4, since, fmt=FMT_DATE)  # the window boundary, visible beside its KPI
    k.kpi(f"Applications in the last {w} days", f'=COUNTIF({submitted},">="&{k.ref(k.r, 4)})',
          note="Window start in column D.", key="applications_recent")
    approved = f'(COUNTIF({status},"Approved by rule")+COUNTIF({status},"Approved by the office"))'
    decided = f'({approved}+COUNTIF({status},"Rejected"))'
    k.kpi("Approval rate (of decided applications)", f'=IF({decided}=0,"",{approved}/{decided})', FMT_PCT,
          note="Approved by a rule or by the office, over everything decided either way.", key="approval_rate")
    k.kpi("Approved by a rule, as a share of approvals",
          f'=IF({approved}=0,"",COUNTIF({status},"Approved by rule")/{approved})', FMT_PCT,
          note="Auto-admitted at submit time, no reviewer involved.", key="auto_share")
    k.kpi("Waiting on the office now", f'=COUNTIF({status},"Waiting for review")+COUNTIF({status},"On hold")',
          note="The review queue, held applications included.", key="pending")
    k.kpi("Oldest application still waiting (days)", f"=MAX({waiting})", key="oldest_waiting")
    k.kpi("Median time to a decision (hours)", f'=IF(COUNT({hours})=0,"",MEDIAN({hours}))', FMT_DEC,
          note="Submit to decision. Rule decisions count as 0 hours; pending rows are left out.", key="decision_hours")
    k.kpi("Applications that became student accounts", f'=COUNTIF({became},"Yes")', key="became_students")
    k.kpi("Dual specialization applications", f'=COUNTIF({dual},"Yes")', key="dual")
    k.kpi("Addresses that applied more than once", f'=COUNTIF({repeat},"Yes")',
          note="A rejected applicant may apply again; both rows carry this flag.", key="repeat")

    k.heading("By status")
    first, last, _ = k.share_table("Status", "Applications", list(REGISTRATION_STATUS_ORDER),
                                   lambda label, r: f"=COUNTIF({status},{k.ref(r, 1)})", key_prefix="status")
    k.pie("Applications by status", first, last, first - 2)

    k.heading("By month submitted (last 12 months)")
    months: list[date] = []
    y, m = snapshot.today.year, snapshot.today.month
    for _ in range(12):
        months.append(date(y, m, 1))
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    months.reverse()
    first, last = k.table(["Month", "Applications"], [[d, None] for d in months], {1: FMT_MONTH, 2: FMT_INT})
    for r in range(first, last + 1):
        k._write(r, 2, f"=COUNTIF({month},{k.ref(r, 1)})", fmt=FMT_INT)
    k.bar("Applications per month", first, last, first - 2, "Applications")

    k.heading("What each application came with")
    fields = [
        ("USN", regs.rng("USN given")), ("Phone", regs.rng("Phone given")),
        ("Personal email", regs.rng("Personal email given")), ("LinkedIn profile", regs.rng("LinkedIn given")),
        ("CV", regs.rng("CV attached")), ("Photo", regs.rng("Photo attached")),
    ]
    first = k.r + 1
    rows = []
    for i, (label, rng) in enumerate(fields):
        r = first + i
        rows.append([label, f'=COUNTIF({rng},"Yes")', f'=IF({total}=0,"",{k.ref(r, 2)}/{total})'])
    k.table(["Given", "Applications", "Share"], rows, {2: FMT_INT, 3: FMT_PCT})
    k.note("Every box has been compulsory on the form since September 2026; a gap here is an older application.")
    k.bar("Applications carrying each field", first, first + len(fields) - 1, first - 2, "Applications", horizontal=True)

    k.heading("By department")
    counter = Counter(r.department or NOT_STATED for r in snapshot.registrations)
    categories, other = _top_categories(counter)
    dept = regs.rng("Department")
    # A deployment with no applications yet still gets a one-row table, so the
    # total's SUM has a range to sum and the sheet reads "0" rather than a gap.
    labels = (categories + (["Other"] if other else [])) or [NOT_STATED]
    first = k.r + 1

    def dept_formula(label: str, r: int) -> str:
        if label == "Other" and other:
            named = "+".join(f"COUNTIF({dept},{k.ref(first + i, 1)})" for i in range(len(categories)))
            return f"=COUNT({idx})-({named})"
        return f"=COUNTIF({dept},{k.ref(r, 1)})"

    first, last, _ = k.share_table("Department", "Applications", labels, dept_formula, key_prefix="department")
    k.pie("Applications by department", first, last, first - 2)
    return k


def write_functionality_kpis(wb: Workbook, snapshot: Snapshot, students: DataSheet) -> KpiSheet:
    w = snapshot.window_days
    k = KpiSheet(wb, SHEET_FUNCTIONALITY, snapshot,
                 "Which parts of REEP students actually use, counted from the rows each action writes. "
                 "A screen that only reads leaves no row and is not here (see the page-views sheet).")
    idx = students.rng("Student #")
    total = k.kpi("Current students", f"=COUNT({idx})", key="students")
    anything = students.rng(f"Used anything (last {w} days)")
    used_n = students.rng(f"Features used (last {w} days)")
    k.kpi(f"Students who used at least one feature (last {w} days)", f'=COUNTIF({anything},"Yes")', key="engaged")
    k.kpi("Engaged share", f'=IF({total}=0,"",{k.ref(k.r - 1, 2)}/{total})', FMT_PCT, key="engaged_share")
    k.kpi(f"Distinct features per engaged student (last {w} days)",
          f'=IF(COUNTIF({used_n},">0")=0,"",SUMIF({used_n},">0")/COUNTIF({used_n},">0"))', FMT_DEC,
          note=f"Out of the {len(FEATURES)} features counted.", key="features_per_engaged")

    k.heading("Per feature")
    headers = ["Feature", f"Uses · last {w} days", "Uses · all time", f"Students · last {w} days",
               "Students · all time", "Adoption (ever used)", f"Uses per user · last {w} days", "Screen"]
    first = k.r + 1
    rows = []
    for i, feature in enumerate(FEATURES):
        r = first + i
        recent = students.rng(f"{feature.label} · last {w} days")
        ever = students.rng(f"{feature.label} · all time")
        rows.append([
            feature.label,
            f"=SUM({recent})",
            f"=SUM({ever})",
            f'=COUNTIF({recent},">0")',
            f'=COUNTIF({ever},">0")',
            f'=IF({total}=0,"",{k.ref(r, 5)}/{total})',
            f'=IF({k.ref(r, 4)}=0,"",{k.ref(r, 2)}/{k.ref(r, 4)})',
            "/" + feature.route,
        ])
    k.ws.column_dimensions["F"].width = 16
    k.ws.column_dimensions["G"].width = 18
    k.ws.column_dimensions["H"].width = 22
    k.table(headers, rows, {2: FMT_INT, 3: FMT_INT, 4: FMT_INT, 5: FMT_INT, 6: FMT_PCT, 7: FMT_DEC})
    for i, feature in enumerate(FEATURES):
        k.cells[f"feature:{feature.key}:recent"] = k.xref(first + i, 2)
        k.cells[f"feature:{feature.key}:adoption"] = k.xref(first + i, 6)
    per_feature_last = first + len(FEATURES) - 1

    # The pie draws the five most-used features inside the window, by the
    # counts in THIS snapshot, and folds the rest into Other; the slice order is
    # therefore fixed at write time, which is what keeps its colours stable.
    k.r += 1
    k.heading(f"Share of use (last {w} days)")
    recent_counts = Counter({
        f.label: sum(s.feature_uses.get(f.key, (0, 0))[1] for s in snapshot.students) for f in FEATURES
    })
    categories, other = _top_categories(recent_counts)
    label_to_row = {f.label: first + i for i, f in enumerate(FEATURES)}
    labels = categories + (["Other"] if other else [])
    pie_first = k.r + 1

    def use_formula(label: str, r: int) -> str:
        if label == "Other":
            named = "+".join(k.ref(label_to_row[c], 2) for c in categories)
            return f"=SUM({k.ref(first, 2)}:{k.ref(per_feature_last, 2)})-({named})"
        return f"={k.ref(label_to_row[label], 2)}"

    pie_first, pie_last, _ = k.share_table("Feature", "Uses", labels, use_formula, key_prefix="use")
    k.pie("Share of use", pie_first, pie_last, pie_first - 2)

    k.heading("Mock interview outcomes (all time)")
    opened = students.rng(f"{FEATURES[0].label} · all time")
    completed = students.rng("Mock interviews completed · all time")
    k.kpi("Interviews opened", f"=SUM({opened})", key="interviews")
    k.kpi("Interviews completed (reached the verdict)", f"=SUM({completed})", key="interviews_completed")
    k.kpi("Completion rate", f'=IF(SUM({opened})=0,"",SUM({completed})/SUM({opened}))', FMT_PCT,
          note="The rest were abandoned, cut by the clock or failed upstream.", key="interview_completion")
    return k


def write_profile_kpis(wb: Workbook, snapshot: Snapshot, students: DataSheet) -> KpiSheet:
    w = snapshot.window_days
    k = KpiSheet(wb, SHEET_PROFILE, snapshot,
                 "What the student record holds: the LinkedIn profile on file, how complete the profile is, "
                 "and the roster facts that decide what a student can reach.")
    idx = students.rng("Student #")
    total = k.kpi("Current students", f"=COUNT({idx})", key="students")

    linkedin = students.rng("LinkedIn status")
    k.heading("LinkedIn profile on file")
    first, last, _ = k.share_table("LinkedIn box holds", "Students", list(LINKEDIN_STATUSES),
                                   lambda label, r: f"=COUNTIF({linkedin},{k.ref(r, 1)})", key_prefix="linkedin")
    k.kpi("Usable LinkedIn link (personal, other page or short link)",
          f'=IF({total}=0,"",(COUNTIF({linkedin},"{LINKEDIN_PERSONAL}")+COUNTIF({linkedin},"{LINKEDIN_OTHER_PAGE}")'
          f'+COUNTIF({linkedin},"{LINKEDIN_SHORT}"))/{total})', FMT_PCT, key="linkedin_usable")
    k.kpi("Personal profile link", f'=IF({total}=0,"",COUNTIF({linkedin},"{LINKEDIN_PERSONAL}")/{total})', FMT_PCT,
          note="linkedin.com/in/<handle>: the one shape a recruiter can open.", key="linkedin_personal")
    k.pie("LinkedIn on file", first, last, first - 2)

    band = students.rng("Completeness band")
    k.heading(f"Profile completeness ({len(PROFILE_FIELDS)} fields the student fills in)")
    first, last, _ = k.share_table("Completeness", "Students", list(COMPLETENESS_BUCKETS),
                                   lambda label, r: f"=COUNTIF({band},{k.ref(r, 1)})", key_prefix="completeness")
    completeness = students.rng("Profile completeness")
    k.kpi("Average completeness (students with a profile)",
          f'=IF(COUNT({completeness})=0,"",AVERAGE({completeness}))', FMT_PCT, key="completeness_avg")
    k.kpi(f"Profiles edited in the last {w} days",
          f'=COUNTIF({students.rng(f"Profile edited (last {w} days)")},"Yes")', key="profile_edited")
    k.pie("Profile completeness", first, last, first - 2)

    k.heading("Fields on file")
    first = k.r + 1
    rows = []
    for i, name in enumerate(PROFILE_FIELDS):
        r = first + i
        rng = students.rng(f"{name} on file")
        rows.append([name, f'=COUNTIF({rng},"Yes")', f'=IF({total}=0,"",{k.ref(r, 2)}/{total})'])
    k.table(["Field", "Students", "Share"], rows, {2: FMT_INT, 3: FMT_PCT})
    for i, name in enumerate(PROFILE_FIELDS):
        k.cells[f"field:{name}"] = k.xref(first + i, 3)
    k.bar("Profile fields on file", first, first + len(PROFILE_FIELDS) - 1, first - 2, "Students", horizontal=True)
    k.r = max(k.r, first + len(PROFILE_FIELDS) + 2)

    stage = students.rng("Stage")
    k.heading("Programme stage")
    first, last, _ = k.share_table("Stage", "Students", list(STAGE_LABELS.values()),
                                   lambda label, r: f"=COUNTIF({stage},{k.ref(r, 1)})", key_prefix="stage")
    k.pie("Students by stage", first, last, first - 2)

    k.heading("Roster facts")
    for label, header, key in (
        ("Seated in a batch", "Seated in a batch", "seated"),
        ("Faculty mentor assigned", "Faculty mentor assigned", "mentored"),
        ("Google account linked", "Google linked", "google"),
        ("Password set", "Password set", "password"),
        ("Placement eligible", "Placement eligible", "eligible"),
        ("Interested in jobs", "Interested in jobs", "jobs"),
        ("Interested in internships", "Interested in internships", "internships"),
        ("Marks on record (imported)", "Marks on record", "marks"),
        ("Attendance on record (imported)", "Attendance on record", "attendance"),
        ("Account disabled", "Account disabled", "disabled"),
    ):
        rng = students.rng(header)
        k.kpi(label, f'=IF({total}=0,"",COUNTIF({rng},"Yes")/{total})', FMT_PCT, key=key)
    k.kpi("Graduated (not in these counts)", snapshot.graduated, note="students.status = GRADUATED", key="graduated")
    k.kpi("Removed from the roster (not in these counts)", snapshot.removed, note="users.deleted_at set", key="removed")
    return k


def write_page_views_sheet(wb: Workbook, snapshot: Snapshot) -> None:
    ws = wb.create_sheet(SHEET_PAGE_VIEWS)
    ws.column_dimensions["A"].width = 120
    lines = [
        ("Most visited pages — not recorded, so not reported", _font(bold=True, size=14)),
        ("", None),
        ("REEP keeps no record of which screens a student opens. Nothing in the database, the API or the browser "
         "counts a page view:", None),
        ("  • The sign-in tables (login_days, login_events) record that a student came in, not where they went.", None),
        ("  • A screen that only reads — Leaderboards, Jobs, Records, Courses, the Faculty / TPO Log — writes no row "
         "when it is opened.", None),
        ("  • The API logs requests to CloudWatch for 30 days with no per-route counter, and the browser sends no "
         "analytics beacon (rule 1: nothing about a student leaves the machine unbidden).", None),
        ("", None),
        ("The Functionality sheet is the honest substitute: it counts what students DID, from the rows each action "
         "writes. It cannot say how often a screen was merely looked at.", None),
        ("", None),
        ("What it would take to answer this properly", _font(bold=True, size=12)),
        ("  1. A page_views table: user_id, role, the ROUTE PATTERN (e.g. student/jobs — never the full URL, whose "
         "query string carries setup and reset tokens), and a timestamp. No request body, no referer.", None),
        ("  2. One endpoint, POST /api/usage/page-views, taking a small batch from the signed-in session; the Angular "
         "shell posts on each route change with navigator.sendBeacon so a closing tab still reports.", None),
        ("  3. Retention: the nightly sweep deletes rows older than 180 days (interview_sessions' clock); a verdict in "
         "both purge modules (EMPTY for purge_people, by user for purge_students); CASCADE from users for the "
         "account walk.", None),
        ("  4. Then this sheet becomes: views per screen, unique students per screen, screens per sign-in — a table and "
         "a bar chart, not a pie, because a dozen screens is too many slices.", None),
        ("", None),
        ("Until that exists, any 'most visited pages' number would be a guess, and this workbook does not print guesses.",
         _font(italic=True, color=_INK_MUTED)),
    ]
    for i, (text, font) in enumerate(lines, start=1):
        cell = ws.cell(row=i, column=1, value=text)
        cell.font = font or _font()
        cell.alignment = Alignment(wrap_text=True, vertical="top")


def write_definitions_sheet(wb: Workbook, snapshot: Snapshot) -> None:
    ws = wb.create_sheet(SHEET_DEFINITIONS)
    w = snapshot.window_days
    headers = ["Sheet", "KPI", "Definition", "Source", "Caveat"]
    rows: list[tuple[str, str, str, str, str]] = [
        (SHEET_SIGN_INS, "Current students", "Rows on the Data - Students sheet.",
         "students.status = ACTIVE joined to users where deleted_at is null",
         "Graduates (role ALUMNI) and removed accounts are counted on the Profile sheet, not here."),
        (SHEET_SIGN_INS, "Daily / weekly / active",
         f"Students whose last sign-in day is today / within 7 days / who have a sign-in day inside the last {w} days.",
         "login_days (one row per student per local calendar day), users.last_login_at as a fallback",
         "A day is the programme's calendar day (Asia/Kolkata by default), not UTC."),
        (SHEET_SIGN_INS, "Stickiness", "Daily active ÷ active.", "derived", "A rough habit measure; 100% would mean everybody comes every day."),
        (SHEET_SIGN_INS, "Sign-in frequency", f"Distinct sign-in days per student inside the last {w} days, bucketed.",
         "login_days", "Two sign-ins on one day are one day."),
        (SHEET_SIGN_INS, "Sign-in recency", "Days since the student's most recent sign-in day, bucketed; Never means no sign-in on record.",
         "login_days, users.last_login_at", ""),
        (SHEET_SIGN_INS, "Streaks", "Consecutive sign-in days; the current streak may end today or yesterday.",
         "login_days, the same rule as GET /api/student/streak", ""),
        (SHEET_SIGN_INS, "Door", "Which sign-in path minted the session.", "login_events.door",
         "Successful sign-ins only; failed attempts are not recorded anywhere a report can read."),
        (SHEET_SIGN_INS, "Device", "A coarse family read from the browser's User-Agent string.", "login_events.user_agent",
         "An iPad in desktop mode reports as a Mac; Chromebooks and Linux fold into Other."),
        (SHEET_SIGN_INS, "Weekday / hour", "When sign-ins happen, in the programme's time zone.", "login_events.at", ""),
        (SHEET_REGISTRATION, "Applications", "Every row the public /register form ever wrote.", "registrations", ""),
        (SHEET_REGISTRATION, "Approval rate", "Approved (by rule or by the office) ÷ decided (approved + rejected).",
         "registrations.status", "Pending and held applications are not decided and are left out."),
        (SHEET_REGISTRATION, "Time to a decision", "Hours from submit to the reviewer's decision; a rule decision is 0 hours.",
         "registrations.created_at, reviewed_at", "A decision reopened and re-made keeps only the latest stamp."),
        (SHEET_REGISTRATION, "What each application came with", "Whether the box or file was present on the row.",
         "registrations.usn / phone / personal_email / linkedin_url; registration_documents (CV, PHOTO)",
         "Compulsory on the form since September 2026; gaps are older applications."),
        (SHEET_REGISTRATION, "By department", "The department the applicant named, or the one their batch implies.",
         "registrations.department_id, cohorts.department_id", "The five largest are named; the rest are Other."),
        (SHEET_FUNCTIONALITY, "Uses", "Rows written by the action, all time and inside the window.",
         "; ".join(f"{f.label}: {f.source}" for f in FEATURES), "Staff-entered records (mock_attempts, mentor notes) are not student usage and are not counted."),
        (SHEET_FUNCTIONALITY, "Adoption", "Students who have ever used the feature ÷ current students.", "derived", ""),
        (SHEET_FUNCTIONALITY, "Share of use", f"Each feature's uses in the last {w} days as a share of all uses.",
         "derived", "The five most-used features are named; the rest are Other."),
        (SHEET_FUNCTIONALITY, "Mock interview completion", "Interviews that reached the verdict ÷ interviews opened.",
         "interview_sessions.status = completed", "An abandoned interview still billed an upstream session."),
        (SHEET_PROFILE, "LinkedIn status", "What the LinkedIn box on the student profile holds.",
         "student_profiles.linkedin_url (copied from the application at approval)",
         "Format only: nobody here opens the link to see whether the profile exists."),
        (SHEET_PROFILE, "Profile completeness", f"Filled fields ÷ {len(PROFILE_FIELDS)}: {', '.join(PROFILE_FIELDS)}.",
         "student_profiles", "Placement eligibility is the office's flag and is reported separately."),
        (SHEET_PROFILE, "Roster facts", "Share of current students with each fact on their row.",
         "students, users, student_profiles, semester_results, attendance_records", ""),
        (SHEET_PAGE_VIEWS, "Most visited pages", "Not recorded; see the sheet.", "—", "—"),
    ]
    for c, h in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=c, value=h)
        cell.font = _font(bold=True)
        cell.fill = _HEADER_FILL
    for r, row in enumerate(rows, start=2):
        for c, value in enumerate(row, start=1):
            cell = ws.cell(row=r, column=c, value=value)
            cell.font = _font()
            cell.alignment = Alignment(wrap_text=True, vertical="top")
    for letter, width in (("A", 20), ("B", 28), ("C", 60), ("D", 60), ("E", 60)):
        ws.column_dimensions[letter].width = width
    ws.freeze_panes = "A2"


def write_summary_sheet(wb: Workbook, snapshot: Snapshot, sheets: dict[str, KpiSheet], *, roster: bool) -> None:
    ws = wb.create_sheet(SHEET_SUMMARY, 0)
    ws.column_dimensions["A"].width = 18
    ws.column_dimensions["B"].width = 52
    ws.column_dimensions["C"].width = 16
    ws.column_dimensions["D"].width = 70
    ws["A1"] = "REEP student engagement KPIs"
    ws["A1"].font = _font(bold=True, size=16)
    ws["A2"] = (
        f"Generated {snapshot.taken_at:%d %b %Y %H:%M} ({snapshot.taken_at.tzname()}) · source: {snapshot.source} · "
        f"window: last {snapshot.window_days} days ({snapshot.window_start:%d %b %Y} – {snapshot.today:%d %b %Y})"
    )
    ws["A2"].font = _font(color=_INK_MUTED)
    ws["A3"] = (
        "This file names students (--roster)." if roster
        else "This file carries no names, USNs or addresses: students are numbered."
    )
    ws["A3"].font = _font(color=_INK_MUTED, italic=True)
    r = 5
    for c, h in enumerate(["Area", "KPI", "Value", "What it means"], start=1):
        cell = ws.cell(row=r, column=c, value=h)
        cell.font = _font(bold=True)
        cell.fill = _HEADER_FILL
    r += 1
    w = snapshot.window_days
    s, g, f, p = sheets[SHEET_SIGN_INS], sheets[SHEET_REGISTRATION], sheets[SHEET_FUNCTIONALITY], sheets[SHEET_PROFILE]
    lines: list[tuple[str, str, str, str, str]] = [
        ("Roster", "Current students", s.cells["students"], FMT_INT, "Status ACTIVE, account not removed."),
        ("Sign-ins", f"Active in the last {w} days", s.cells["mau"], FMT_INT, "At least one sign-in day in the window."),
        ("Sign-ins", "Active share", s.cells["active_share"], FMT_PCT, "Active ÷ current students."),
        ("Sign-ins", "Signed in today", s.cells["dau"], FMT_INT, "Daily active students."),
        ("Sign-ins", "Stickiness", s.cells["stickiness"], FMT_PCT, "Daily ÷ active."),
        ("Sign-ins", "Never signed in", s.cells["never"], FMT_INT, "Accounts on the roster that have never been used."),
        ("Sign-ins", "Sign-in days per active student", s.cells["days_per_active"], FMT_DEC, f"Average distinct days in the last {w} days."),
        ("Sign-ins", "On a streak of 7+ days", s.cells["streak7"], FMT_INT, "Consecutive sign-in days."),
        ("Sign-ins", f"Google sign-ins (last {w} days)", s.cells["door:Google"], FMT_INT, "Sign-ins through the Google door."),
        ("Sign-ins", f"Phone sign-ins (last {w} days)", f"={s.cells[f'device:{DEVICE_ANDROID}'].lstrip('=')}+{s.cells[f'device:{DEVICE_IOS}']}", FMT_INT, "Android plus iPhone/iPad."),
        ("Registration", "Applications (all time)", g.cells["applications"], FMT_INT, "Every /register submission."),
        ("Registration", f"Applications (last {w} days)", g.cells["applications_recent"], FMT_INT, ""),
        ("Registration", "Approval rate", g.cells["approval_rate"], FMT_PCT, "Approved ÷ decided."),
        ("Registration", "Waiting on the office", g.cells["pending"], FMT_INT, "Pending plus held."),
        ("Registration", "Oldest waiting (days)", g.cells["oldest_waiting"], FMT_INT, ""),
        ("Registration", "Median hours to a decision", g.cells["decision_hours"], FMT_DEC, "Rule decisions count as 0."),
        ("Functionality", f"Students who used anything (last {w} days)", f.cells["engaged"], FMT_INT, ""),
        ("Functionality", "Engaged share", f.cells["engaged_share"], FMT_PCT, "Engaged ÷ current students."),
        ("Functionality", "Mock interview completion", f.cells["interview_completion"], FMT_PCT, "Reached the verdict ÷ opened."),
        ("Profile", "Personal LinkedIn profile on file", p.cells["linkedin_personal"], FMT_PCT, "linkedin.com/in/<handle>."),
        ("Profile", "Usable LinkedIn link on file", p.cells["linkedin_usable"], FMT_PCT, "Any linkedin.com page or lnkd.in link."),
        ("Profile", "Average profile completeness", p.cells["completeness_avg"], FMT_PCT, f"Over {len(PROFILE_FIELDS)} fields."),
        ("Profile", "Seated in a batch", p.cells["seated"], FMT_PCT, ""),
        ("Profile", "Faculty mentor assigned", p.cells["mentored"], FMT_PCT, ""),
        ("Profile", "Marks on record", p.cells["marks"], FMT_PCT, "A semester result has been imported."),
        ("Pages", "Most visited pages", "not recorded", None, f"See the '{SHEET_PAGE_VIEWS}' sheet."),
    ]
    for i, feature in enumerate(FEATURES):
        lines.insert(16 + 3 + i, ("Functionality", f"{feature.label} · uses (last {w} days)",
                                   f.cells[f"feature:{feature.key}:recent"], FMT_INT,
                                   "Adoption: see the Functionality sheet."))
    for area, label, value, fmt, meaning in lines:
        ws.cell(row=r, column=1, value=area).font = _font(color=_INK_MUTED)
        ws.cell(row=r, column=2, value=label).font = _font()
        cell = ws.cell(row=r, column=3, value=(value if value.startswith("=") or value == "not recorded" else f"={value}"))
        cell.font = _font(bold=True)
        if fmt:
            cell.number_format = fmt
        cell.alignment = Alignment(horizontal="right")
        ws.cell(row=r, column=4, value=meaning).font = _font(color=_INK_MUTED)
        r += 1
    r += 1
    ws.cell(row=r, column=1, value="Sheets").font = _font(bold=True)
    r += 1
    for name, what in (
        (SHEET_SIGN_INS, "active counts, frequency, recency, streaks, door, device, weekday and hour"),
        (SHEET_REGISTRATION, "applications by status and month, approval rate, decision time, what came with each"),
        (SHEET_FUNCTIONALITY, "uses and adoption per feature, share of use, interview completion"),
        (SHEET_PROFILE, "LinkedIn on file, profile completeness, fields on file, stage, roster facts"),
        (SHEET_PAGE_VIEWS, "why there is no page-view KPI and what it would take"),
        (SHEET_DEFINITIONS, "every KPI's definition, source table and caveat"),
        (SHEET_DATA_STUDENTS, "one row per current student (the KPIs are formulas over this)"),
        (SHEET_DATA_REGISTRATIONS, "one row per application"),
        (SHEET_DATA_SIGN_INS, f"one row per sign-in in the last {w} days"),
    ):
        ws.cell(row=r, column=2, value=name).font = _font(bold=True)
        ws.cell(row=r, column=4, value=what).font = _font(color=_INK_MUTED)
        r += 1


def build_workbook(snapshot: Snapshot, *, roster: bool = False) -> Workbook:
    """Every sheet, in reading order: Summary first, data last."""
    wb = Workbook()
    wb.remove(wb.active)
    students = write_students_sheet(wb, snapshot, roster=roster)
    regs = write_registrations_sheet(wb, snapshot, roster=roster)
    events = write_sign_ins_sheet(wb, snapshot)
    sheets = {
        SHEET_SIGN_INS: write_sign_in_kpis(wb, snapshot, students, events),
        SHEET_REGISTRATION: write_registration_kpis(wb, snapshot, regs),
        SHEET_FUNCTIONALITY: write_functionality_kpis(wb, snapshot, students),
        SHEET_PROFILE: write_profile_kpis(wb, snapshot, students),
    }
    write_page_views_sheet(wb, snapshot)
    write_definitions_sheet(wb, snapshot)
    write_summary_sheet(wb, snapshot, sheets, roster=roster)
    # Reading order: Summary, the four KPI sheets, the gap, the definitions, then data.
    order = [
        SHEET_SUMMARY, SHEET_SIGN_INS, SHEET_REGISTRATION, SHEET_FUNCTIONALITY, SHEET_PROFILE,
        SHEET_PAGE_VIEWS, SHEET_DEFINITIONS, SHEET_DATA_STUDENTS, SHEET_DATA_REGISTRATIONS, SHEET_DATA_SIGN_INS,
    ]
    wb._sheets = [wb[name] for name in order]  # noqa: SLF001 - openpyxl exposes no reorder API
    wb.active = 0
    # No cached values are written for the formulas, so ask the spreadsheet
    # application to compute everything when the file is opened.
    wb.calculation = CalcProperties(fullCalcOnLoad=True)
    return wb


def write_workbook(snapshot: Snapshot, path: Path, *, roster: bool = False) -> Path:
    wb = build_workbook(snapshot, roster=roster)
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    return path


# --------------------------------------------------------------------------- #
# Command line.
# --------------------------------------------------------------------------- #


def default_filename(today: date) -> str:
    return f"reep-kpis-{today:%Y-%m-%d}.xlsx"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.kpi_workbook",
        description=(
            "Write the student-engagement KPI workbook: registration, sign-ins, functionality used and the "
            "student record, as formula-driven sheets with pie charts. Read-only; aggregates by default."
        ),
    )
    parser.add_argument("--out", type=Path, default=None,
                        help="where to write the .xlsx (default: reep-kpis-<date>.xlsx in the current directory)")
    parser.add_argument("--days", type=int, default=DEFAULT_WINDOW_DAYS,
                        help=f"how many days 'recent' covers, today included (default {DEFAULT_WINDOW_DAYS})")
    parser.add_argument("--roster", action="store_true",
                        help="ALSO write each student's name, USN, college email and LinkedIn URL on the data "
                             "sheets, for the office's follow-up list. The file then carries personal data.")
    parser.add_argument("--force", action="store_true", help="overwrite an existing file at --out")
    args = parser.parse_args(argv)

    if args.days < 1 or args.days > 366:
        parser.error("--days must be between 1 and 366")

    out = args.out or Path(default_filename(local_now().date()))
    if out.exists() and not args.force:
        log.error("%s already exists; pass --force to overwrite it.", out)
        return 1

    db = SessionLocal()
    try:
        snapshot = load_snapshot(db, window_days=args.days)
    finally:
        db.close()

    write_workbook(snapshot, out, roster=args.roster)
    log.info(
        "KPI workbook: %d current students, %d applications, %d sign-ins in the last %d days -> %s (%s)",
        len(snapshot.students),
        len(snapshot.registrations),
        len(snapshot.sign_ins),
        snapshot.window_days,
        out,
        "NAMES INCLUDED (--roster): handle as personal data" if args.roster else "no names, students are numbered",
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    raise SystemExit(main())
