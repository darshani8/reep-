"""Programme sign-up flow (ported from the Next.js registration path).

Public submission runs the data-driven rule engine: among enabled rules, every
*populated* condition (email domain, USN regex, degree level) must match, and the
lowest `priority` among the matches decides. A matching auto-approve rule waves
the application through (AUTO_APPROVED) and assigns its cohort; a matching
non-auto rule routes it to a human (PENDING_REVIEW) with a label; no match falls
to manual review. Directors then approve/reject the queue.

Provisioning the actual Student (User row, cohort seat) is a deliberate
follow-up step, not done here — approval only stamps the decision, mirroring the
model note that a Student cannot exist until approval has decided a cohort.
"""

import logging
import re
import time
from datetime import datetime, timezone
from functools import lru_cache
from typing import Sequence

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from fastapi.responses import RedirectResponse

from .. import account_links
from ..config import settings
from ..db import get_db
from ..identity import get_current_session
from ..models.job import DegreeLevel
from ..models.cohort import Cohort
from ..models.institution import (
    HIERARCHY_LEVELS,
    STATUS_ACTIVE,
    AcademicCourse,
    AcademicSpecialization,
    College,
    Department,
)
from ..models.registration import (
    DOCUMENT_KIND_CV,
    DOCUMENT_KIND_PHOTO,
    Registration,
    RegistrationDocument,
    RegistrationRule,
    RegistrationStatus,
)
from ..models.student_profile import StudentProfile
from ..models.user import Role, Student, User
from ..governance import require_capability
from ..architecture_events import record_change
from ..document_store import MAX_BYTES, QuotaRejected, VolumeQuota, save_bytes
from ..document_store import delete as delete_stored
from ..models.upload import Upload, UploadKind

router = APIRouter(prefix="/register", tags=["registration"])

log = logging.getLogger(__name__)


# --- usn_pattern is DB-sourced regex run on an UNAUTHENTICATED endpoint -------
#
# `RegistrationRule.usn_pattern` is a regular expression that arrives from the
# database and is executed on POST /register, which has no cookie and no roster
# check in front of it. Two ways that ends badly, and in both the *rule* is the
# thing that is broken while the *front door* is the thing that falls over:
#
#   * an invalid pattern (a bare "[") raises re.error inside the engine, so every
#     USN-carrying application 500s and nothing in the response — or, before
#     this, in the log — names the rule that did it;
#   * a catastrophic pattern ("(a+)+$") backtracks exponentially: a ReDoS an
#     anonymous caller can fire at will, one HTTP request at a time.
#
# Planting either needs a director/DB write, so this is a blast-radius problem
# rather than an entry point. It is defended twice anyway, because a rule row can
# always be edited straight in psql and skip whatever the write path checks:
#
#   1. validate_usn_pattern() at rule-WRITE time. app/seed.py is the only writer
#      today (the RegistrationRule(...) block); any future director-facing rule
#      editor MUST call it before commit and hand the ValueError back to the
#      author, who is the only person able to fix the pattern.
#   2. _usn_matcher() at MATCH time, which refuses to run a pattern that fails
#      the same check and drops that one rule instead of the request.

# A USN format is a short fixed shape ("^1BG2[0-9]MBA[0-9]{3}$"). Nothing
# legitimate needs more than this, and the cap is what stops a pathological
# pattern being pasted in at all.
MAX_USN_PATTERN_LENGTH = 200

# Backtracking cost is a function of the SUBJECT length, so the engine is never
# handed a long one. RegisterIn already caps `usn` at 32, but _rule_matches is a
# module-level helper with its own tests and callers: it must not depend on its
# caller for the bound that keeps it cheap.
MAX_USN_MATCH_LENGTH = 64

# A quantifier applied to a group — "(...)+", "(...)*", "(...){2,}" — is the shape
# behind essentially every real-world ReDoS, including the overlapping-alternation
# form "(a|aa)+" that a nested-quantifier check alone would miss. Deciding whether
# an arbitrary regex backtracks catastrophically is not something to attempt in a
# router, and a USN pattern has no honest use for a quantified group, so the whole
# shape is refused. If you ever genuinely need one, the rule engine is the wrong
# place for it — match in code, not in a row an operator can edit.
_QUANTIFIED_GROUP = re.compile(r"\)[*+{]")


def validate_usn_pattern(pattern: str) -> re.Pattern[str]:
    """Compile a rule's `usn_pattern`, refusing what the public endpoint cannot
    afford to run. Raises ValueError with a message written for whoever is
    authoring the rule — they are the only person who can fix it."""
    if len(pattern) > MAX_USN_PATTERN_LENGTH:
        raise ValueError(f"usn_pattern is longer than {MAX_USN_PATTERN_LENGTH} characters")
    if _QUANTIFIED_GROUP.search(pattern):
        raise ValueError(
            "usn_pattern applies a quantifier to a group — refused as a "
            "catastrophic-backtracking risk on the public registration endpoint"
        )
    try:
        return re.compile(pattern)
    except re.error as exc:
        raise ValueError(f"usn_pattern is not a valid regular expression: {exc}") from exc


@lru_cache(maxsize=256)
def _usn_matcher(pattern: str) -> re.Pattern[str] | None:
    """The compiled matcher for a rule, or None for a pattern we refuse to run.

    The cache does two jobs. It keeps regex compilation off the path of every
    application, and it makes the "unusable rule" WARNING fire once per distinct
    pattern per process rather than once per applicant — a log flooded by the
    hundredth copy is a log in which nobody finds the one line naming the bad
    rule. Fix the pattern in the database and the new string is a new cache key,
    so the fix takes effect with no restart; the WARNING reappears once if the
    new pattern is also unusable.
    """
    try:
        return validate_usn_pattern(pattern)
    except ValueError as exc:
        log.warning(
            "Registration rule has an unusable usn_pattern (%s) — that rule is "
            "SKIPPED, not matched: %r",
            exc,
            pattern[:120],
        )
        return None


def _email_domain(email: str) -> str:
    return email.rsplit("@", 1)[-1].lower()


def _rule_matches(rule: RegistrationRule, email: str, usn: str | None, degree: DegreeLevel) -> bool:
    """All populated conditions must hold; an empty condition is a wildcard."""
    if rule.email_domain and _email_domain(email) != rule.email_domain.lower():
        return False
    if rule.usn_pattern:
        matcher = _usn_matcher(rule.usn_pattern)
        if matcher is None:
            # An unusable pattern is a broken RULE, not a broken APPLICATION.
            # Skipping it lets the engine fall through to the next rule — worst
            # case, manual review — where raising took every USN-carrying
            # submission down with it.
            return False
        if not usn or len(usn) > MAX_USN_MATCH_LENGTH:
            # Longer than any real USN. Refused rather than truncated: a
            # truncated subject would let "^...$" match a prefix of something
            # that is not a USN at all.
            return False
        try:
            if not matcher.search(usn):
                return False
        except (re.error, RecursionError) as exc:
            # Compilation already succeeded, so this is the rare match-time
            # failure. Same verdict as an unusable pattern: lose the rule, keep
            # the endpoint.
            log.warning(
                "Registration rule usn_pattern failed at match time (%s) — rule "
                "SKIPPED: %r",
                exc,
                rule.usn_pattern[:120],
            )
            return False
    if rule.degree_level is not None and rule.degree_level != degree:
        return False
    return True


# --- The one unauthenticated write in the app ---------------------------------
#
# POST /register takes no cookie, consults no roster, and INSERTs a row. Without
# a limit it is both a database flood anyone can start and — together with the
# duplicate-email branch in submit() — a free "has this person applied here"
# lookup for anyone holding a list of names.
#
# Fixed window, keyed on the socket peer, held in this process. Three caveats
# stated plainly so nobody reads more into it than it gives:
#
#   * PER WORKER. N uvicorn workers give N times this limit, and a restart
#     forgets every window. It raises the cost of a flood; it is not a quota, and
#     a real one needs shared state (Postgres or Redis) this endpoint does not
#     have.
#   * The key is request.client.host, the SOCKET peer. Behind a reverse proxy
#     that is the proxy, so an entire campus can share one bucket — which is why
#     the limit is deliberately generous rather than tight: a class of sixty
#     applying from one NAT on results day must not lock itself out. If you put a
#     trusted proxy in front, read the real client from ITS header and say so
#     here. X-Forwarded-For is not trusted as it stands, because a header the
#     caller sets is a limiter the caller can switch off.
#   * The table is bounded, so the limiter cannot itself become the memory
#     exhaustion it exists to prevent. An attacker with thousands of live source
#     addresses can flush it — but they can also just spend the limit from each
#     of those addresses, so the table size was never the control.
_RATE_WINDOW_SECONDS = 600
_RATE_MAX_PER_WINDOW = 20
_RATE_MAX_KEYS = 4096
_rate_windows: dict[str, tuple[float, int]] = {}


def _rate_limit_retry_after(client_ip: str) -> int | None:
    """Count this attempt. Returns None to proceed, or seconds until the window
    resets when the caller has spent it."""
    now = time.monotonic()
    window_start, count = _rate_windows.get(client_ip, (now, 0))
    if now - window_start >= _RATE_WINDOW_SECONDS:
        window_start, count = now, 0
    if count >= _RATE_MAX_PER_WINDOW:
        # Not recorded: a caller who keeps hammering must not extend their own
        # window, or a refusal would become a permanent block.
        return max(1, int(_RATE_WINDOW_SECONDS - (now - window_start)))
    if client_ip not in _rate_windows and len(_rate_windows) >= _RATE_MAX_KEYS:
        for key, (started, _n) in list(_rate_windows.items()):
            if now - started >= _RATE_WINDOW_SECONDS:
                del _rate_windows[key]
        if len(_rate_windows) >= _RATE_MAX_KEYS:
            _rate_windows.clear()  # every window still live: start over, never grow
    _rate_windows[client_ip] = (window_start, count + 1)
    return None


def _pick_rule(
    db: Session, email: str, usn: str | None, degree: DegreeLevel
) -> RegistrationRule | None:
    """Lowest priority among the enabled rules that match wins (ties broken by
    creation order, so a rule added later can't silently outrank an equal)."""
    candidates = db.scalars(
        select(RegistrationRule)
        .where(RegistrationRule.enabled.is_(True))
        .order_by(RegistrationRule.priority, RegistrationRule.created_at)
    ).all()
    for rule in candidates:
        if _rule_matches(rule, email, usn, degree):
            return rule
    return None


class RegisterIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    # A plain string with a light shape check (avoids the email-validator dep);
    # the domain is what the rule engine actually keys on.
    email: str = Field(min_length=3, max_length=200)
    usn: str | None = Field(default=None, max_length=32)
    phone: str | None = Field(default=None, max_length=32)
    degree_level: DegreeLevel = DegreeLevel.PG
    # WHERE THE APPLICANT SAYS THEY BELONG, from the hierarchy the admin built.
    # Send the DEEPEST level known; the API derives the ancestors and refuses a
    # contradiction. All optional at the API - the form requires College and
    # Department, but an older client, a rule or a reviewer may still fill them.
    college_id: str | None = None
    department_id: str | None = None
    course_id: str | None = None
    specialization_id: str | None = None
    requested_cohort_id: str | None = None


class RegistrationOut(BaseModel):
    id: str
    name: str
    email: str
    usn: str | None
    degree_level: str
    status: str
    cohort_id: str | None
    matched_rule_id: str | None
    decision_reason: str | None
    reviewed_by_id: str | None
    reviewed_at: datetime | None
    review_note: str | None
    approved_student_id: str | None
    created_at: datetime
    # The applicant's claim, ids and resolved names (names for the queue and the
    # result card; ids so a client can re-select). requested_cohort_id is the
    # batch THEY picked; cohort_id above is the rule's, and wins.
    college_id: str | None = None
    department_id: str | None = None
    course_id: str | None = None
    specialization_id: str | None = None
    requested_cohort_id: str | None = None
    college_name: str | None = None
    department_name: str | None = None
    course_name: str | None = None
    specialization_name: str | None = None
    requested_batch: str | None = None
    #: Kinds attached with the application - "CV", "PHOTO" - so the queue can
    #: show a reviewer what is there before they open anything.
    documents: list[str] = []


def _doc_kinds(db: Session, registration_ids: Sequence[str]) -> dict[str, list[str]]:
    """Which document kinds each application holds - one query for a whole list,
    so the queue does not fire a SELECT per row."""
    if not registration_ids:
        return {}
    out: dict[str, list[str]] = {}
    for reg_id, kind in db.execute(
        select(RegistrationDocument.registration_id, RegistrationDocument.kind).where(
            RegistrationDocument.registration_id.in_(list(registration_ids))
        )
    ).all():
        out.setdefault(reg_id, []).append(kind)
    return out


#: URL segment -> stored kind -> the mime types that kind may be. The store
#: sniffs magic bytes and hands back the real mime; this table is what turns a
#: PNG posted as a "cv" into a 415 instead of a CV nobody can open.
_DOCUMENT_ROUTES: dict[str, tuple[str, frozenset[str], str]] = {
    "cv": (DOCUMENT_KIND_CV, frozenset({"application/pdf"}), "a PDF"),
    "photo": (DOCUMENT_KIND_PHOTO, frozenset({"image/png", "image/jpeg"}), "a PNG or JPG"),
}

#: Where a moved document lands in the student's own uploads on approval.
_DOCUMENT_TO_UPLOAD_KIND: dict[str, tuple[UploadKind, str]] = {
    DOCUMENT_KIND_CV: (UploadKind.RESUME, "CV from application"),
    DOCUMENT_KIND_PHOTO: (UploadKind.PROFILE_PHOTO, "Photo from application"),
}


def _move_documents_to_uploads(db: Session, reg: Registration, student: Student) -> int:
    """On APPROVE: the application's files become the student's first uploads.

    A MOVE, not a copy - the Upload row takes the same stored_name, so the bytes
    are never duplicated and the RegistrationDocument row is simply deleted
    (rows only: the file now belongs to the Upload). `uploads.stored_name` is
    unique, and so is ours, so a name can never end up owned twice.
    """
    docs = db.scalars(
        select(RegistrationDocument).where(RegistrationDocument.registration_id == reg.id)
    ).all()
    for d in docs:
        kind, title = _DOCUMENT_TO_UPLOAD_KIND.get(d.kind, (UploadKind.DOCUMENT, "From application"))
        db.add(
            Upload(
                student_id=student.id,
                kind=kind,
                cert_code=None,
                title=title,
                original_name=d.original_name,
                stored_name=d.stored_name,
                mime_type=d.mime_type,
                size_bytes=d.size_bytes,
            )
        )
        db.delete(d)
    db.flush()
    return len(docs)


_CLAIM_KEYS = ("college_id", "department_id", "course_id", "specialization_id", "requested_cohort_id")
_CLAIM_NOUN = {
    "college_id": "college",
    "department_id": "department",
    "course_id": "course",
    "specialization_id": "specialization",
    "requested_cohort_id": "batch",
}


def _claim_names(db: Session, rows: Sequence[Registration]) -> dict[str, dict[str, str | None]]:
    """Resolved names for every application's claim - five IN queries for a
    whole page, never one per row."""
    def ids(attr: str) -> list[str]:
        return list({getattr(r, attr) for r in rows if getattr(r, attr)})

    colleges = {c.id: c.name for c in db.scalars(select(College).where(College.id.in_(ids("college_id")))).all()} if ids("college_id") else {}
    departments = {d.id: d.name for d in db.scalars(select(Department).where(Department.id.in_(ids("department_id")))).all()} if ids("department_id") else {}
    courses = {c.id: c.name for c in db.scalars(select(AcademicCourse).where(AcademicCourse.id.in_(ids("course_id")))).all()} if ids("course_id") else {}
    specs = {x.id: x.name for x in db.scalars(select(AcademicSpecialization).where(AcademicSpecialization.id.in_(ids("specialization_id")))).all()} if ids("specialization_id") else {}
    batches = {b.id: f"{b.name} \u00b7 {b.batch_label}" for b in db.scalars(select(Cohort).where(Cohort.id.in_(ids("requested_cohort_id")))).all()} if ids("requested_cohort_id") else {}
    return {
        r.id: {
            "college_name": colleges.get(r.college_id) if r.college_id else None,
            "department_name": departments.get(r.department_id) if r.department_id else None,
            "course_name": courses.get(r.course_id) if r.course_id else None,
            "specialization_name": specs.get(r.specialization_id) if r.specialization_id else None,
            "requested_batch": batches.get(r.requested_cohort_id) if r.requested_cohort_id else None,
        }
        for r in rows
    }


def _out_one(db: Session, r: Registration) -> RegistrationOut:
    """One row with everything the client needs: documents and claim names."""
    return _out(r, _doc_kinds(db, [r.id]).get(r.id, ()), _claim_names(db, [r]).get(r.id))


def _out(r: Registration, docs: Sequence[str] = (), names: dict[str, str | None] | None = None) -> RegistrationOut:
    names = names or {}
    return RegistrationOut(
        documents=sorted(docs),
        college_id=r.college_id,
        department_id=r.department_id,
        course_id=r.course_id,
        specialization_id=r.specialization_id,
        requested_cohort_id=r.requested_cohort_id,
        college_name=names.get("college_name"),
        department_name=names.get("department_name"),
        course_name=names.get("course_name"),
        specialization_name=names.get("specialization_name"),
        requested_batch=names.get("requested_batch"),
        id=r.id,
        name=r.name,
        email=r.email,
        usn=r.usn,
        degree_level=r.degree_level.value,
        status=r.status.value,
        cohort_id=r.cohort_id,
        matched_rule_id=r.matched_rule_id,
        decision_reason=r.decision_reason,
        reviewed_by_id=r.reviewed_by_id,
        reviewed_at=r.reviewed_at,
        review_note=r.review_note,
        approved_student_id=r.approved_student_id,
        created_at=r.created_at,
    )


class PublicSpecializationOut(BaseModel):
    id: str
    code: str
    name: str


class PublicCourseOut(BaseModel):
    id: str
    code: str
    name: str
    specializations: list[PublicSpecializationOut]


class PublicBatchOut(BaseModel):
    id: str
    code: str
    name: str
    batch_label: str
    department_id: str | None
    course_id: str | None
    specialization_id: str | None
    degree_level: str
    #: Still running (end date ahead). The form lists current batches first and
    #: greys the rest; it does not hide them - a late applicant to a batch that
    #: ended last month is a director's call, not the form's.
    current: bool


class PublicDepartmentOut(BaseModel):
    id: str
    code: str
    name: str
    courses: list[PublicCourseOut]
    batches: list[PublicBatchOut]


class PublicCollegeOut(BaseModel):
    id: str
    code: str
    name: str
    departments: list[PublicDepartmentOut]


class PublicLevelOut(BaseModel):
    key: str
    label: str
    required: bool


class PublicHierarchyOut(BaseModel):
    levels: list[PublicLevelOut]
    colleges: list[PublicCollegeOut]


@router.get("/hierarchy", response_model=PublicHierarchyOut)
def hierarchy(db: Session = Depends(get_db)) -> PublicHierarchyOut:
    """What the register form's pickers offer - the hierarchy the admin built.

    PUBLIC, like the form. It carries institutional STRUCTURE only: ids, codes
    and names of ACTIVE colleges, departments, courses and specializations, and
    every batch's label - never a student, a count of students, a head of
    department or a contact. Rule 1 is about student data; a college's own
    prospectus is not that. `levels` says which pickers the form must require:
    College and Department always (every batch sits under a department), then
    Course and Specialization per HIERARCHY_LEVELS - the same one-line switch
    the admin console reads - and Batch never, because an applicant may not
    know theirs and a director can seat them.
    """
    now = datetime.now(timezone.utc)
    colleges = db.scalars(
        select(College).where(College.status == STATUS_ACTIVE).order_by(College.name)
    ).all()
    departments = db.scalars(
        select(Department).where(Department.status == STATUS_ACTIVE).order_by(Department.name)
    ).all()
    courses = db.scalars(
        select(AcademicCourse).where(AcademicCourse.status == STATUS_ACTIVE).order_by(AcademicCourse.name)
    ).all()
    specs = db.scalars(
        select(AcademicSpecialization)
        .where(AcademicSpecialization.status == STATUS_ACTIVE)
        .order_by(AcademicSpecialization.name)
    ).all()
    batches = db.scalars(select(Cohort).order_by(Cohort.start_date.desc(), Cohort.name)).all()

    specs_by_course: dict[str, list[PublicSpecializationOut]] = {}
    for sp in specs:
        specs_by_course.setdefault(sp.course_id, []).append(
            PublicSpecializationOut(id=sp.id, code=sp.code, name=sp.name)
        )
    courses_by_dept: dict[str, list[PublicCourseOut]] = {}
    for co in courses:
        courses_by_dept.setdefault(co.department_id, []).append(
            PublicCourseOut(id=co.id, code=co.code, name=co.name, specializations=specs_by_course.get(co.id, []))
        )
    batches_by_dept: dict[str, list[PublicBatchOut]] = {}
    for b in batches:
        if b.department_id is None:
            continue  # unseated in the hierarchy; the admin console lists these to fix
        batches_by_dept.setdefault(b.department_id, []).append(
            PublicBatchOut(
                id=b.id, code=b.code, name=b.name, batch_label=b.batch_label,
                department_id=b.department_id, course_id=b.course_id,
                specialization_id=b.specialization_id,
                degree_level=b.degree_level.value, current=b.end_date >= now,
            )
        )
    depts_by_college: dict[str, list[PublicDepartmentOut]] = {}
    for d in departments:
        depts_by_college.setdefault(d.college_id, []).append(
            PublicDepartmentOut(
                id=d.id, code=d.code, name=d.name,
                courses=courses_by_dept.get(d.id, []), batches=batches_by_dept.get(d.id, []),
            )
        )
    levels = [
        PublicLevelOut(key="college", label="College", required=True),
        PublicLevelOut(key="department", label="Department", required=True),
        *[PublicLevelOut(key=lvl.key, label=lvl.label, required=lvl.required) for lvl in HIERARCHY_LEVELS],
        PublicLevelOut(key="batch", label="Batch", required=False),
    ]
    return PublicHierarchyOut(
        levels=levels,
        colleges=[
            PublicCollegeOut(id=c.id, code=c.code, name=c.name, departments=depts_by_college.get(c.id, []))
            for c in colleges
        ],
    )


def _resolve_claim(db: Session, body: RegisterIn) -> dict[str, str | None]:
    """The applicant's claim, walked UP from the deepest level they named.

    The same discipline as routers/admin.py::_resolve_ancestry, for the same
    reason: five columns that can be set independently are five chances to
    disagree, and the disagreement surfaces as a director seating a student in
    a department their batch is not in. So the batch pins its specialization,
    course and department; a specialization pins its course; a course its
    department; a department its college - and any level the applicant ALSO
    named that differs from what was derived is a 422 naming the deeper choice,
    never a silent pick. An id that does not exist is a 422 too: this is a
    public form, and "unknown college" is input validation, not a missing page.
    """
    chain: dict[str, str | None] = {k: None for k in _CLAIM_KEYS}

    def settle(key: str, value: str | None, because: str) -> None:
        if value is None:
            return
        if chain[key] is not None and chain[key] != value:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=(
                    f"The {_CLAIM_NOUN[key]} you chose contradicts the {because} you chose. "
                    f"Pick a {_CLAIM_NOUN[key]} under it, or clear the {because}."
                ),
            )
        chain[key] = value

    def load(model, ident: str | None, noun: str):
        if ident is None:
            return None
        row = db.get(model, ident)
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"That {noun} does not exist. Reload the form and choose again.",
            )
        return row

    batch = load(Cohort, body.requested_cohort_id, "batch")
    if batch is not None:
        chain["requested_cohort_id"] = batch.id
        settle("specialization_id", batch.specialization_id, "batch")
        settle("course_id", batch.course_id, "batch")
        settle("department_id", batch.department_id, "batch")

    settle("specialization_id", body.specialization_id, "batch")
    spec = load(AcademicSpecialization, chain["specialization_id"], "specialization")
    if spec is not None:
        settle("course_id", spec.course_id, "specialization")

    settle("course_id", body.course_id, "specialization or batch")
    course = load(AcademicCourse, chain["course_id"], "course")
    if course is not None:
        settle("department_id", course.department_id, "course")

    settle("department_id", body.department_id, "course or batch")
    department = load(Department, chain["department_id"], "department")
    if department is not None:
        settle("college_id", department.college_id, "department")

    settle("college_id", body.college_id, "department")
    load(College, chain["college_id"], "college")
    return chain


@router.post("", response_model=RegistrationOut, status_code=status.HTTP_201_CREATED)
def submit(
    body: RegisterIn, request: Request, db: Session = Depends(get_db)
) -> RegistrationOut:
    """Public: submit an application. No auth — the applicant is not a user yet."""
    # Limit BEFORE the database is touched: the point is that a flood never
    # reaches Postgres, not that Postgres survives it.
    client_ip = request.client.host if request.client else "unknown"
    retry_after = _rate_limit_retry_after(client_ip)
    if retry_after is not None:
        log.warning(
            "POST /api/register rate-limited (%s attempts in %ss) for %s",
            _RATE_MAX_PER_WINDOW,
            _RATE_WINDOW_SECONDS,
            client_ip,
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many registration attempts from this network. Please try again shortly.",
            headers={"Retry-After": str(retry_after)},
        )

    email = body.email.strip().lower()
    if "@" not in email or "." not in email.rsplit("@", 1)[-1]:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="A valid email is required."
        )
    existing = db.scalar(select(Registration).where(Registration.email == email))
    if existing is not None:
        # Deliberately does NOT confirm that an application exists for this
        # address. The old wording ("An application with this email already
        # exists.") turned the public form into a "has X applied to this college"
        # lookup for anyone with a list of names, and applying somewhere is not
        # something an applicant chose to publish.
        #
        # Be honest about what is left: the STATUS CODE still separates the two
        # cases — a fresh submission 201s, this 409s — and the only complete fix
        # is to answer every submission identically and send the real outcome out
        # of band by email, which this endpoint does not do. The rate limit above
        # is what makes walking a roster through the remaining tell slow rather
        # than free. The real application id goes to the log, not the response, so
        # support can still find it.
        log.info(
            "POST /api/register refused a duplicate application (registration id=%s)",
            existing.id,
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This application could not be accepted. If you have already applied, "
                "or you think this is a mistake, contact the placement office."
            ),
        )

    # THE RULE IS NOT APPLIED HERE ANY MORE. It is applied when the address is
    # CONFIRMED (`verify` below), because until then nobody has shown they can
    # read this mailbox — and approval now mints a users row, so an application
    # that auto-approves off an unconfirmed address would be a self-service door
    # onto the roster. `EmailVerification` existed for exactly this and had no
    # writer; this is the writer. An unconfirmed application sits in
    # PENDING_VERIFICATION, which the director's queue does not list.
    reg = Registration(
        name=body.name.strip(),
        email=email,
        usn=body.usn,
        phone=body.phone,
        degree_level=body.degree_level,
        status=RegistrationStatus.PENDING_VERIFICATION,
        cohort_id=None,
        **_resolve_claim(db, body),
        matched_rule_id=None,
        decision_reason="Awaiting email confirmation.",
    )
    db.add(reg)
    db.commit()
    db.refresh(reg)
    raw = account_links.issue_email_verification(db, reg)
    db.commit()
    account_links.send_email_verification(db, reg, raw)
    log.info("application %s from %s awaiting email confirmation", reg.id, email)
    return _out_one(db, reg)


@router.get("/pending", response_model=list[RegistrationOut])
def pending(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[RegistrationOut]:
    """Director review queue — applications a human still needs to decide."""
    require_capability(db, session, "admin.registrations")
    rows = db.scalars(
        select(Registration)
        .where(Registration.status == RegistrationStatus.PENDING_REVIEW)
        .order_by(Registration.created_at)
    ).all()
    kinds = _doc_kinds(db, [r.id for r in rows])
    names = _claim_names(db, rows)
    return [_out(r, kinds.get(r.id, ()), names.get(r.id)) for r in rows]


class DecisionIn(BaseModel):
    decision: str  # "APPROVE" | "REJECT"
    note: str | None = None


#: Unusable-password sentinel. Identical to grant_access.SSO_ONLY_PASSWORD_HASH
#: and seed_roster's: it is NOT a "scrypt:<salt>:<digest>" string, so
#: verify_password can never match it. A provisioned account therefore cannot be
#: signed into with a password until one is deliberately set — which is the
#: activation flow's job, not this endpoint's.
SSO_ONLY_PASSWORD_HASH = "google-only"


def _provision_student(db: Session, reg: Registration) -> Student:
    """Create the User + Student an approved application earns.

    THIS IS THE STEP THAT DID NOT EXIST. The endpoint below used to stamp a
    status and three audit columns and stop; its own docstring called
    provisioning "a separate follow-up step", and that step was nowhere in the
    codebase. `registrations.approved_student_id` was declared, returned by the
    API, and never written. The only ways a Student came into existence were
    `python -m app.seed_roster`, `python -m app.grant_access` and the dev-only
    `python -m app.seed` — all shell-only, none of which read this table.

    IDEMPOTENT BY LOOKUP, not by flag. A double-clicked Approve must not create
    two students. The email is unique on `users`, so an existing row is found
    and reused rather than inserted again; and if the registration already
    carries an approved_student_id, that student is returned untouched. Relying
    on the caller not to double-click is not a design.

    Reached twice, this function inserts nothing twice — and that is tested
    DIRECTLY (test_institutional_spine.py calls it twice in one session),
    because through the endpoint the already-decided 409 fires first and every
    lookup below could be deleted with the endpoint test still passing.

    TWO THINGS IT REFUSES, both because the application it is reading arrived
    from an unauthenticated public form: an address off the college domain, and
    an address that already belongs to a non-STUDENT account. See the guards
    inline — each one is a door into the roster that this function would
    otherwise open.

    NO PASSWORD IS SET. The account gets the unusable sentinel. Sign-in is
    Google-only in production, and where a password is wanted it arrives through
    activation — an invitation the student redeems — not from an admin reading
    one out.

    THE COHORT COMES FROM THE RULE. `registrations.cohort_id` was stamped by the
    matched registration rule at submit time. Copying it onto the student here
    is what finally connects the rule engine to a seat; before this it was
    written to the registrations row and read by nothing.
    """
    if reg.approved_student_id:
        existing = db.get(Student, reg.approved_student_id)
        if existing is not None:
            return existing

    email = (reg.email or "").strip().lower()

    # ------------------------------------------------------------------ #
    # GUARD 1: the domain. This endpoint MINTS A ROSTER ROW, and the roster
    # IS the access control (app/google_auth.py: an account with no matching
    # row is refused, nothing self-provisions). POST /api/register is public,
    # unauthenticated, and validates the address no further than "has an @";
    # registrations.email_verified_at has no writer, so nobody has proved the
    # applicant can even read that mailbox.
    #
    # Without this check, "Approve" on an application from any address on the
    # internet grants that address a real Google sign-in to REEP. The director
    # clicking it sees a form that looks like every other application. That
    # made approval a self-service door into the roster, which is the one
    # thing google_auth.py's whole design exists to prevent.
    #
    # settings.provisionable_email_domains explains why a fence HERE is
    # consistent with there deliberately being none on sign-in.
    # ------------------------------------------------------------------ #
    domain = email.rpartition("@")[2]
    allowed = settings.provisionable_email_domains
    if not domain or domain not in allowed:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                "This application cannot be approved: its email address is not on a "
                f"college domain ({', '.join(sorted(allowed))}). Approving it would "
                "create a sign-in account. Staff accounts are created with "
                "`python -m app.grant_access`, not from this queue."
            ),
        )

    user = db.scalar(select(User).where(func.lower(User.email) == email))
    if user is None:
        user = User(
            email=email,
            name=(reg.name or "").strip() or email,
            role=Role.STUDENT,
            password_hash=SSO_ONLY_PASSWORD_HASH,
        )
        db.add(user)
        db.flush()  # need user.id for the Student row, same transaction
    elif user.role is not Role.STUDENT:
        # ------------------------------------------------------------------ #
        # GUARD 2: the role. The lookup above is by EMAIL ALONE, and the
        # duplicate check on submit is against registrations.email, not
        # users.email — so an application naming a mentor's or director's
        # address is accepted by the public form and lands in this queue
        # looking ordinary.
        #
        # Attaching a Student row to that account is not cosmetic: _payload_for
        # mints `studentId` into the session for ANY user who has one, so the
        # next sign-in carries role=MENTOR *and* a studentId. Never widen an
        # existing account's reach from an unauthenticated form; rule 2 says
        # scope is decided by role, and this would let a form edit it.
        # ------------------------------------------------------------------ #
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"{email} already belongs to a {user.role.value} account. Approving "
                "this application would attach a student record to it. Reject the "
                "application, or change the address on it first."
            ),
        )

    student = db.scalar(select(Student).where(Student.user_id == user.id))
    if student is None:
        student = Student(
            user_id=user.id,
            usn=(reg.usn or "").strip() or None,
            # The rule's cohort wins - it is policy. When no rule seated them, the
            # batch the applicant picked on the form is what the director approved.
            cohort_id=reg.cohort_id or reg.requested_cohort_id,
        )
        db.add(student)
        db.flush()

    # A profile row so GET /api/student/profile answers 200 instead of 404 on
    # the student's first sign-in. The endpoint 404s on a missing profile, which
    # would make a freshly provisioned account look broken.
    # Queried by student_id, NOT db.get(): StudentProfile's primary key is its
    # own `id` and student_id is a separate unique column, so db.get() would
    # always miss and insert a duplicate that the unique index then rejects.
    existing_profile = db.scalar(
        select(StudentProfile).where(StudentProfile.student_id == student.id)
    )
    if existing_profile is None:
        db.add(StudentProfile(student_id=student.id, email=email))

    reg.approved_student_id = student.id
    return student


def _apply_rule(db: Session, reg: Registration) -> None:
    """Decide a CONFIRMED application: auto-approve and provision, or queue it.

    Runs at confirmation time, not submit time, so the rule engine only ever
    sees addresses somebody has proved they own. If the rule says approve but
    provisioning refuses — the domain fence, or an address that already belongs
    to a staff account — the application is NOT dropped and NOT force-approved:
    it lands in the director's queue with the refusal as its reason, which is
    where a human decision belongs. That also closes the old gap where
    AUTO_APPROVED rows were never provisioned by anything.
    """
    rule = _pick_rule(db, reg.email, reg.usn, reg.degree_level)
    if rule is None:
        reg.status = RegistrationStatus.PENDING_REVIEW
        reg.decision_reason = "No rule matched — needs manual review."
        return
    reg.matched_rule_id = rule.id
    reg.cohort_id = rule.cohort_id
    if not rule.auto_approve:
        reg.status = RegistrationStatus.PENDING_REVIEW
        reg.decision_reason = f"Routed by rule '{rule.name}' — awaiting review."
        return
    try:
        student = _provision_student(db, reg)
    except HTTPException as refused:
        reg.status = RegistrationStatus.PENDING_REVIEW
        reg.decision_reason = f"Rule '{rule.name}' would auto-approve, but: {refused.detail}"
        log.warning("auto-approve of %s refused: %s", reg.email, refused.detail)
        return
    reg.status = RegistrationStatus.AUTO_APPROVED
    reg.decision_reason = f"Auto-approved by rule '{rule.name}'."
    reg.reviewed_at = datetime.now(timezone.utc)
    db.flush()
    user = db.get(User, student.user_id)
    if user is not None:
        account_links.send_enrolment_notice(db, user)


@router.get("/verify")
def verify(token: str, db: Session = Depends(get_db)) -> RedirectResponse:
    """Public: the link in the confirmation email. Consumes it, marks the
    address confirmed, applies the rule, and sends the browser into the app.

    A GET, because it is opened from a mail client. It redirects rather than
    rendering, so the outcome is shown by the login screen in the app's own
    words: `?verified=1`, or `?verified=0` with why.
    """
    web = settings.web_origin.rstrip("/")
    reg = account_links.consume_email_verification(db, token.strip())
    if reg is None:
        return RedirectResponse(f"{web}/login?verified=0&why=expired_or_used", status_code=302)
    if reg.status is not RegistrationStatus.PENDING_VERIFICATION:
        return RedirectResponse(f"{web}/login?verified=1", status_code=302)
    reg.email_verified_at = datetime.now(timezone.utc)
    _apply_rule(db, reg)
    db.commit()
    return RedirectResponse(f"{web}/login?verified=1", status_code=302)


@router.post("/{registration_id}/decision", response_model=RegistrationOut)
def decide(
    registration_id: str,
    body: DecisionIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> RegistrationOut:
    """Director: approve or reject a pending application.

    APPROVE stamps the reviewer AND provisions the account — the User row, the
    Student row seated in the rule's cohort, a profile row, and
    approved_student_id — all in one transaction. REJECT stamps only."""
    require_capability(db, session, "admin.registrations")
    # SELECT ... FOR UPDATE, not db.get(). The already-decided check below is a
    # read followed by a write, and two directors clicking Approve at the same
    # moment both read PENDING, both pass the check, and both provision — the
    # second failing on the unique email with a 500 rather than the 409 this
    # endpoint promises. The row lock makes the second request wait for the
    # first to commit, so it reads APPROVED and gets the 409.
    reg = db.scalar(
        select(Registration).where(Registration.id == registration_id).with_for_update()
    )
    if reg is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Application not found.")
    if reg.status in (RegistrationStatus.APPROVED, RegistrationStatus.REJECTED):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Application already decided."
        )
    decision = body.decision.upper()
    if decision == "APPROVE":
        reg.status = RegistrationStatus.APPROVED
        # Approval now PROVISIONS. See _provision_student: same transaction as
        # the status stamp, so an application is never left approved with no
        # account behind it.
        student = _provision_student(db, reg)
        db.flush()
        # The CV and photo the applicant attached become the student's first
        # uploads - moved, not copied, so nothing is left behind on the
        # application and the bytes exist once.
        _move_documents_to_uploads(db, reg, student)
        user = db.get(User, student.user_id)
        if user is not None:
            # Option B: a student gets an enrolment notice (sign in with
            # Google), never a password link.
            account_links.send_enrolment_notice(db, user)
    elif decision == "REJECT":
        reg.status = RegistrationStatus.REJECTED
    else:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="decision must be APPROVE or REJECT.",
        )
    reg.reviewed_by_id = session["userId"]
    reg.reviewed_at = datetime.now(timezone.utc)
    reg.review_note = body.note
    db.commit()
    db.refresh(reg)
    return _out_one(db, reg)


@router.post(
    "/{registration_id}/documents/{kind}",
    response_model=RegistrationOut,
    status_code=status.HTTP_200_OK,
)
async def attach_document(
    registration_id: str,
    kind: str,
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> RegistrationOut:
    """Attach the CV or the photo to an application that nobody has decided yet.

    PUBLIC, like the form that created the application - there is no account to
    sign in with yet. The application id is the bearer: a uuid4 the client was
    handed on the 201, unguessable, and the same trust the emailed confirmation
    link carries. It is accepted only while the application is undecided
    (PENDING_VERIFICATION or PENDING_REVIEW), so a file can never be slipped
    onto a record a director has already ruled on.

    The bytes go through app/document_store exactly as a student's own uploads
    do - magic-sniffed, size-capped, no client path near the disk - and THEN
    the sniffed mime is checked against what this kind may be, so a PNG posted
    as a CV is a 415 and its bytes are removed, not a CV nobody can open. One
    of each kind: a second CV replaces the first, old bytes deleted first.

    Rate-limited per source address like POST /register: with no account on
    the request there is nothing else to key on, and the limiter's own note
    says why that is acceptable for this form and not for sign-in.
    """
    route = _DOCUMENT_ROUTES.get(kind)
    if route is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown document kind.")
    doc_kind, allowed_mimes, wanted = route

    client_ip = request.client.host if request.client else "unknown"
    retry_after = _rate_limit_retry_after(client_ip)
    if retry_after is not None:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many uploads from this connection. Wait a few minutes and try again.",
            headers={"Retry-After": str(retry_after)},
        )

    reg = db.scalar(
        select(Registration).where(Registration.id == registration_id).with_for_update()
    )
    if reg is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Application not found.")
    if reg.status not in (RegistrationStatus.PENDING_VERIFICATION, RegistrationStatus.PENDING_REVIEW):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This application has already been decided; documents can no longer be added.",
        )

    content = await file.read()
    if len(content) > MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="That file is larger than " + str(MAX_BYTES // (1024 * 1024)) + " MB.",
        )
    quota = VolumeQuota.single_slot(noun=kind)
    try:
        stored_name, mime, size = save_bytes(content, quota=quota)
    except QuotaRejected as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    except ValueError as exc:
        # The store could not recognise the bytes at all (not PDF/PNG/JPEG).
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail=str(exc))
    if mime not in allowed_mimes:
        delete_stored(stored_name)
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="The " + kind + " must be " + wanted + ".",
        )

    existing = db.scalar(
        select(RegistrationDocument).where(
            RegistrationDocument.registration_id == reg.id,
            RegistrationDocument.kind == doc_kind,
        )
    )
    if existing is not None:
        # Replace in place: old bytes go first, so a failure between the two
        # writes leaves the row pointing at the NEW file, never at nothing.
        try:
            delete_stored(existing.stored_name)
        except FileNotFoundError:
            pass
        existing.original_name = file.filename or stored_name
        existing.stored_name = stored_name
        existing.mime_type = mime
        existing.size_bytes = size
    else:
        db.add(
            RegistrationDocument(
                registration_id=reg.id,
                kind=doc_kind,
                original_name=file.filename or stored_name,
                stored_name=stored_name,
                mime_type=mime,
                size_bytes=size,
            )
        )
    db.commit()
    db.refresh(reg)
    return _out_one(db, reg)


@router.post("/{registration_id}/reopen", response_model=RegistrationOut)
def reopen(
    registration_id: str,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> RegistrationOut:
    """Put a REJECTED application back in the queue - the design's Undo.

    Rejection only stamped the row, so reopening is exact: status back to
    PENDING_REVIEW, the reviewer stamp and remarks cleared, the attached
    documents untouched (they were never deleted on rejection, precisely so
    this is lossless). An APPROVED application is refused with 409: approval
    PROVISIONED a User and a Student and sent them an enrolment notice, and
    quietly deleting an account someone was just told to sign in to is not an
    undo - it is a second, destructive decision that deserves its own tooling.

    Audited through record_change with the stamp it clears, so "who reopened
    this and what did the rejection say" stays answerable.
    """
    require_capability(db, session, "admin.registrations")
    reg = db.scalar(
        select(Registration).where(Registration.id == registration_id).with_for_update()
    )
    if reg is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Application not found.")
    if reg.status is not RegistrationStatus.REJECTED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Only a rejected application can be reopened. An approved one already has "
                "an account behind it."
            ),
        )
    before = {
        "status": reg.status.value,
        "reviewed_by_id": reg.reviewed_by_id,
        "reviewed_at": reg.reviewed_at.isoformat() if reg.reviewed_at else None,
        "review_note": reg.review_note,
    }
    reg.status = RegistrationStatus.PENDING_REVIEW
    reg.reviewed_by_id = None
    reg.reviewed_at = None
    reg.review_note = None
    record_change(
        db, session=session, request=request, tenant_id=None,
        entity_type="registration", entity_id=reg.id, action="REOPENED",
        before=before, after={"status": reg.status.value},
        event_type="registration.reopened", payload={"email": reg.email},
    )
    db.commit()
    db.refresh(reg)
    return _out_one(db, reg)


class RuleOut(BaseModel):
    id: str
    name: str
    enabled: bool
    email_domain: str | None
    usn_pattern: str | None
    degree_level: str | None
    cohort_id: str | None
    auto_approve: bool
    priority: int


@router.get("/rules", response_model=list[RuleOut])
def rules(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[RuleOut]:
    """Director: the active rule set, in the order the engine evaluates it."""
    require_capability(db, session, "admin.registrations")
    rows = db.scalars(
        select(RegistrationRule).order_by(RegistrationRule.priority, RegistrationRule.created_at)
    ).all()
    return [
        RuleOut(
            id=r.id,
            name=r.name,
            enabled=r.enabled,
            email_domain=r.email_domain,
            usn_pattern=r.usn_pattern,
            degree_level=r.degree_level.value if r.degree_level is not None else None,
            cohort_id=r.cohort_id,
            auto_approve=r.auto_approve,
            priority=r.priority,
        )
        for r in rows
    ]
