"""Main Admin — the institutional write layer.

WHY THIS MODULE EXISTS. Before it, nothing in the running application could
create a College, a Department or a Cohort, seat a student in one, or write
`users.department` / `users.designation`. All of it was CLI-and-seed only, and
`app/seed.py` refuses to run when ENV=prod — so on a production host no cohort
could exist at all, and four of the five fields on the student's locked profile
card could not be filled by any means short of direct SQL.

THE HIERARCHY IT MAINTAINS:

    College -> Department -> Cohort -> Student.cohort_id

"Batch" on screen is `Cohort` here. The mapping is deliberate and is explained
once in docs/institutional-spine-build-log.md.

ARCHIVE, NEVER DELETE. There is no DELETE endpoint in this file. Status moves
ACTIVE <-> ARCHIVED, which is what the design's console does and what the
foreign keys enforce anyway: the database refuses to delete a college that still
has departments, or a cohort that still has students. A graduated student's
record must still name the college they attended.

SCHEMA NAMING. Cohort responses here are `AdminCohortOut`, not `CohortOut`.
Two different `CohortOut` classes already exist with different shapes
(`director.py:116` and `badge_verification.py:429`) — the same collision this
codebase already has for `LeaderboardOut`, where the payload depends on which
URL you happened to hit. A third would make it worse, so this one is named for
its surface.

ROLE. `require_director` (DIRECTOR + ADMIN), matching every other admin surface
including `voice_platform/api/admin.py`. A narrower Main-Admin-only gate belongs
with the capability work, not here — inventing a second gate now would mean two
answers to "who may administer", which is exactly the shape of bug rule 2 exists
to prevent.
"""

from datetime import date, datetime, time, timezone
from typing import ClassVar, NamedTuple

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .. import account_links
from ..config import settings
from ..db import get_db
from ..identity import get_current_session
from ..models.cohort import Cohort
from ..models import institution as institution_model
from ..models.institution import (
    STATUS_ACTIVE,
    STATUS_ARCHIVED,
    AcademicCourse,
    AcademicSpecialization,
    College,
    Department,
    HierarchyLevel,
)
from ..models.job import DegreeLevel
from ..models.user import Student, User
from .mentor import require_director

router = APIRouter(prefix="/admin", tags=["admin"])

#: The statuses this surface will accept. A plain allowlist rather than an enum,
#: for the reason app/models/voice_platform.py sets out: a new status should be
#: a data change, not a CREATE TYPE migration.
_SETTABLE_STATUSES = {STATUS_ACTIVE, STATUS_ARCHIVED}


class PatchModel(BaseModel):
    """Base for every PATCH body on this surface. Rejects an explicit `null`
    for a column the database will not accept one for.

    THE BUG THIS FIXES. Every field on a PATCH body is `X | None = None` so
    that omitting it means "leave it alone", and the handler reads
    `model_dump(exclude_unset=True)` to tell omitted from sent. But
    `exclude_unset` is not `exclude_none`: `{"name": null}` is SENT, so it
    survives into the dict, and `setattr(college, "name", None)` then reaches
    a NOT NULL column and comes back as an unhandled IntegrityError — a 500,
    with a Postgres constraint name in the response.

    `{"name": null}` is exactly what a form sends when someone clears a field
    and saves, so this was one cleared input away from a 500 on all three
    PATCH endpoints. The distinction the wire needs is three-way — omitted /
    a value / explicitly null — and only the third is an error, because these
    columns are NOT NULL. Subclasses list those columns in NON_NULLABLE; a
    genuinely nullable field (campus, contact) is left out and may be nulled
    to clear it, which is how those fields are cleared.
    """

    #: Field names that must not be set to null. Named on each subclass so the
    #: list sits next to the fields it describes.
    NON_NULLABLE: ClassVar[frozenset[str]] = frozenset()

    @model_validator(mode="before")
    @classmethod
    def _refuse_explicit_null(cls, data: object) -> object:
        if not isinstance(data, dict):
            return data
        offenders = sorted(
            name for name in cls.NON_NULLABLE if name in data and data[name] is None
        )
        if offenders:
            raise ValueError(
                "These fields cannot be cleared: "
                + ", ".join(offenders)
                + ". Omit a field to leave it unchanged, or send a new value."
            )
        return data


def _as_utc_midnight(value: date) -> datetime:
    """A calendar date as a timezone-aware datetime.

    `cohorts.start_date` / `end_date` are DateTime(timezone=True) — they predate
    this surface and are not worth a migration to change. The API speaks `date`
    because entry and completion are calendar facts, not instants, and the
    conversion happens here at the edge rather than in four call sites.
    """
    return datetime.combine(value, time.min, tzinfo=timezone.utc)


# ----------------------------------------------------------------- colleges --


class CollegeOut(BaseModel):
    id: str
    code: str
    name: str
    campus: str | None
    contact: str | None
    status: str
    department_count: int


class CollegeIn(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=200)
    campus: str | None = None
    contact: str | None = None


class CollegePatchIn(PatchModel):
    """Every field optional: only what is sent is changed.

    `status` is here rather than on a separate /archive endpoint because archive
    and restore are the same operation in opposite directions, and a dedicated
    verb for each invites them to drift apart.
    """

    # campus and contact are nullable columns — clearing them is legitimate and
    # is how they are cleared. code, name and status are NOT NULL. See PatchModel.
    NON_NULLABLE: ClassVar[frozenset[str]] = frozenset({"code", "name", "status"})

    code: str | None = Field(default=None, min_length=1, max_length=32)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    campus: str | None = None
    contact: str | None = None
    status: str | None = None


def _college_out(db: Session, college: College) -> CollegeOut:
    count = db.scalar(
        select(func.count()).select_from(Department).where(Department.college_id == college.id)
    )
    return CollegeOut(
        id=college.id,
        code=college.code,
        name=college.name,
        campus=college.campus,
        contact=college.contact,
        status=college.status,
        department_count=int(count or 0),
    )


@router.get("/colleges", response_model=list[CollegeOut])
def list_colleges(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[CollegeOut]:
    """Every college, archived ones included — the console shows and un-archives them."""
    require_director(session)
    rows = db.scalars(select(College).order_by(College.name)).all()
    return [_college_out(db, c) for c in rows]


@router.post("/colleges", response_model=CollegeOut, status_code=status.HTTP_201_CREATED)
def create_college(
    body: CollegeIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> CollegeOut:
    require_director(session)
    code = body.code.strip().upper()
    if db.scalar(select(College).where(College.code == code)) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A college with code {code} already exists.",
        )
    college = College(
        code=code,
        name=body.name.strip(),
        campus=body.campus,
        contact=body.contact,
        created_by_user_id=session["userId"],
    )
    db.add(college)
    db.commit()
    db.refresh(college)
    return _college_out(db, college)


@router.patch("/colleges/{college_id}", response_model=CollegeOut)
def update_college(
    college_id: str,
    body: CollegePatchIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> CollegeOut:
    require_director(session)
    college = db.get(College, college_id)
    if college is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="College not found.")
    fields = body.model_dump(exclude_unset=True)
    if "status" in fields and fields["status"] not in _SETTABLE_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"status must be one of {sorted(_SETTABLE_STATUSES)}.",
        )
    if "code" in fields and fields["code"]:
        fields["code"] = fields["code"].strip().upper()
        clash = db.scalar(
            select(College).where(College.code == fields["code"], College.id != college_id)
        )
        if clash is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A college with code {fields['code']} already exists.",
            )
    for field, value in fields.items():
        setattr(college, field, value)
    db.commit()
    db.refresh(college)
    return _college_out(db, college)


# -------------------------------------------------------------- departments --


class DepartmentOut(BaseModel):
    id: str
    college_id: str
    code: str
    name: str
    head: str | None
    status: str
    cohort_count: int


class DepartmentIn(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=200)
    head: str | None = None


class DepartmentPatchIn(PatchModel):
    # `head` is a nullable column: clearing it is how a department records that
    # it currently has no head. See PatchModel.
    NON_NULLABLE: ClassVar[frozenset[str]] = frozenset({"code", "name", "status"})

    code: str | None = Field(default=None, min_length=1, max_length=32)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    head: str | None = None
    status: str | None = None


def _department_out(db: Session, department: Department) -> DepartmentOut:
    count = db.scalar(
        select(func.count()).select_from(Cohort).where(Cohort.department_id == department.id)
    )
    return DepartmentOut(
        id=department.id,
        college_id=department.college_id,
        code=department.code,
        name=department.name,
        head=department.head,
        status=department.status,
        cohort_count=int(count or 0),
    )


@router.get("/colleges/{college_id}/departments", response_model=list[DepartmentOut])
def list_departments(
    college_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[DepartmentOut]:
    require_director(session)
    if db.get(College, college_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="College not found.")
    rows = db.scalars(
        select(Department).where(Department.college_id == college_id).order_by(Department.name)
    ).all()
    return [_department_out(db, d) for d in rows]


@router.post(
    "/colleges/{college_id}/departments",
    response_model=DepartmentOut,
    status_code=status.HTTP_201_CREATED,
)
def create_department(
    college_id: str,
    body: DepartmentIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> DepartmentOut:
    require_director(session)
    if db.get(College, college_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="College not found.")
    code = body.code.strip().upper()
    # Unique per college, not globally — two colleges may each run a "CSE".
    clash = db.scalar(
        select(Department).where(Department.college_id == college_id, Department.code == code)
    )
    if clash is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"This college already has a department with code {code}.",
        )
    department = Department(
        college_id=college_id,
        code=code,
        name=body.name.strip(),
        head=body.head,
        created_by_user_id=session["userId"],
    )
    db.add(department)
    db.commit()
    db.refresh(department)
    return _department_out(db, department)


@router.patch("/departments/{department_id}", response_model=DepartmentOut)
def update_department(
    department_id: str,
    body: DepartmentPatchIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> DepartmentOut:
    require_director(session)
    department = db.get(Department, department_id)
    if department is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Department not found.")
    fields = body.model_dump(exclude_unset=True)
    if "status" in fields and fields["status"] not in _SETTABLE_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"status must be one of {sorted(_SETTABLE_STATUSES)}.",
        )
    if "code" in fields and fields["code"]:
        fields["code"] = fields["code"].strip().upper()
        clash = db.scalar(
            select(Department).where(
                Department.college_id == department.college_id,
                Department.code == fields["code"],
                Department.id != department_id,
            )
        )
        if clash is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"This college already has a department with code {fields['code']}.",
            )
    for field, value in fields.items():
        setattr(department, field, value)
    db.commit()
    db.refresh(department)
    return _department_out(db, department)


# ---------------------------------------------- the switch, and its readers --


def _required_levels() -> list[HierarchyLevel]:
    """The levels a NEW batch must name today.

    Read through the module attribute at call time, not from an import-time
    binding: `from ..models.institution import HIERARCHY_LEVELS` would freeze a
    copy here, and a test that flips `required` on the model module would then
    be flipping a constant this router never looks at. The flip must be
    observable from exactly one place.
    """
    return [lv for lv in institution_model.HIERARCHY_LEVELS if lv.required]


def _compliance_gap(cohort: Cohort) -> list[HierarchyLevel]:
    """Which required levels this batch does not name. Empty means compliant."""
    return [lv for lv in _required_levels() if getattr(cohort, lv.field) is None]


class HierarchyLevelOut(BaseModel):
    key: str
    label: str
    field: str
    required: bool


@router.get("/hierarchy/levels", response_model=list[HierarchyLevelOut])
def hierarchy_levels(session: dict = Depends(get_current_session)) -> list[HierarchyLevelOut]:
    """What the batch form must ask for, and which of it is mandatory.

    The console does NOT hardcode `Validators.required`; it builds the
    controls from this response. One constant, two readers — the pydantic
    validator on AdminCohortIn and this — so "both sides agree" is a property
    of the call graph rather than a promise in a comment. Flip `required` in
    HIERARCHY_LEVELS and the form grows a required validator on its own.
    """
    require_director(session)
    return [HierarchyLevelOut(**lv._asdict()) for lv in institution_model.HIERARCHY_LEVELS]


# ----------------------------------------------------- academic courses --
# UI: "Course". Prefixed in code because app/models/course.py's `Course` is a
# taught subject (22MBA11) and `CourseOut` is already student.py's. See the
# model docstring.


class AcademicCourseOut(BaseModel):
    id: str
    department_id: str
    code: str
    name: str
    duration_months: int | None
    status: str
    specialization_count: int


class AcademicCourseIn(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=200)
    duration_months: int | None = Field(default=None, ge=1, le=120)


class AcademicCoursePatchIn(PatchModel):
    NON_NULLABLE: ClassVar[frozenset[str]] = frozenset({"code", "name", "status"})

    code: str | None = Field(default=None, min_length=1, max_length=32)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    duration_months: int | None = Field(default=None, ge=1, le=120)
    status: str | None = None


def _academic_course_out(db: Session, course: AcademicCourse) -> AcademicCourseOut:
    count = db.scalar(
        select(func.count())
        .select_from(AcademicSpecialization)
        .where(AcademicSpecialization.course_id == course.id)
    )
    return AcademicCourseOut(
        id=course.id,
        department_id=course.department_id,
        code=course.code,
        name=course.name,
        duration_months=course.duration_months,
        status=course.status,
        specialization_count=int(count or 0),
    )


@router.get("/departments/{department_id}/academic-courses", response_model=list[AcademicCourseOut])
def list_academic_courses(
    department_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[AcademicCourseOut]:
    require_director(session)
    if db.get(Department, department_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Department not found.")
    rows = db.scalars(
        select(AcademicCourse)
        .where(AcademicCourse.department_id == department_id)
        .order_by(AcademicCourse.code)
    ).all()
    return [_academic_course_out(db, c) for c in rows]


@router.post(
    "/departments/{department_id}/academic-courses",
    response_model=AcademicCourseOut,
    status_code=status.HTTP_201_CREATED,
)
def create_academic_course(
    department_id: str,
    body: AcademicCourseIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> AcademicCourseOut:
    require_director(session)
    if db.get(Department, department_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Department not found.")
    code = body.code.strip().upper()
    # Unique per department — two departments may each run an "MBA".
    clash = db.scalar(
        select(AcademicCourse).where(
            AcademicCourse.department_id == department_id, AcademicCourse.code == code
        )
    )
    if clash is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"This department already has a course with code {code}.",
        )
    course = AcademicCourse(
        department_id=department_id,
        code=code,
        name=body.name.strip(),
        duration_months=body.duration_months,
        created_by_user_id=session["userId"],
    )
    db.add(course)
    db.commit()
    db.refresh(course)
    return _academic_course_out(db, course)


@router.patch("/academic-courses/{course_id}", response_model=AcademicCourseOut)
def update_academic_course(
    course_id: str,
    body: AcademicCoursePatchIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> AcademicCourseOut:
    require_director(session)
    course = db.get(AcademicCourse, course_id)
    if course is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Course not found.")
    fields = body.model_dump(exclude_unset=True)
    if "status" in fields and fields["status"] not in _SETTABLE_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"status must be one of {sorted(_SETTABLE_STATUSES)}.",
        )
    if "code" in fields and fields["code"]:
        code = fields["code"].strip().upper()
        clash = db.scalar(
            select(AcademicCourse).where(
                AcademicCourse.department_id == course.department_id,
                AcademicCourse.code == code,
                AcademicCourse.id != course.id,
            )
        )
        if clash is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"This department already has a course with code {code}.",
            )
        fields["code"] = code
    if "name" in fields and fields["name"]:
        fields["name"] = fields["name"].strip()
    for field, value in fields.items():
        setattr(course, field, value)
    db.commit()
    db.refresh(course)
    return _academic_course_out(db, course)


# ---------------------------------------------- academic specializations --
# UI: "Specialization". Prefixed because the bare word is already booked three
# times — the interview matrix's tracks, PlatformSpecialization, and the
# interview_sessions column — and `SpecializationOut` is the voice platform's.


class AcademicSpecializationOut(BaseModel):
    id: str
    course_id: str
    code: str
    name: str
    status: str
    cohort_count: int


class AcademicSpecializationIn(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=200)


class AcademicSpecializationPatchIn(PatchModel):
    NON_NULLABLE: ClassVar[frozenset[str]] = frozenset({"code", "name", "status"})

    code: str | None = Field(default=None, min_length=1, max_length=32)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    status: str | None = None


def _academic_specialization_out(
    db: Session, spec: AcademicSpecialization
) -> AcademicSpecializationOut:
    count = db.scalar(
        select(func.count()).select_from(Cohort).where(Cohort.specialization_id == spec.id)
    )
    return AcademicSpecializationOut(
        id=spec.id,
        course_id=spec.course_id,
        code=spec.code,
        name=spec.name,
        status=spec.status,
        cohort_count=int(count or 0),
    )


@router.get(
    "/academic-courses/{course_id}/academic-specializations",
    response_model=list[AcademicSpecializationOut],
)
def list_academic_specializations(
    course_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[AcademicSpecializationOut]:
    require_director(session)
    if db.get(AcademicCourse, course_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Course not found.")
    rows = db.scalars(
        select(AcademicSpecialization)
        .where(AcademicSpecialization.course_id == course_id)
        .order_by(AcademicSpecialization.code)
    ).all()
    return [_academic_specialization_out(db, r) for r in rows]


@router.post(
    "/academic-courses/{course_id}/academic-specializations",
    response_model=AcademicSpecializationOut,
    status_code=status.HTTP_201_CREATED,
)
def create_academic_specialization(
    course_id: str,
    body: AcademicSpecializationIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> AcademicSpecializationOut:
    require_director(session)
    if db.get(AcademicCourse, course_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Course not found.")
    code = body.code.strip().upper()
    clash = db.scalar(
        select(AcademicSpecialization).where(
            AcademicSpecialization.course_id == course_id, AcademicSpecialization.code == code
        )
    )
    if clash is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"This course already has a specialization with code {code}.",
        )
    spec = AcademicSpecialization(
        course_id=course_id,
        code=code,
        name=body.name.strip(),
        created_by_user_id=session["userId"],
    )
    db.add(spec)
    db.commit()
    db.refresh(spec)
    return _academic_specialization_out(db, spec)


@router.patch(
    "/academic-specializations/{specialization_id}", response_model=AcademicSpecializationOut
)
def update_academic_specialization(
    specialization_id: str,
    body: AcademicSpecializationPatchIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> AcademicSpecializationOut:
    require_director(session)
    spec = db.get(AcademicSpecialization, specialization_id)
    if spec is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Specialization not found.")
    fields = body.model_dump(exclude_unset=True)
    if "status" in fields and fields["status"] not in _SETTABLE_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"status must be one of {sorted(_SETTABLE_STATUSES)}.",
        )
    if "code" in fields and fields["code"]:
        code = fields["code"].strip().upper()
        clash = db.scalar(
            select(AcademicSpecialization).where(
                AcademicSpecialization.course_id == spec.course_id,
                AcademicSpecialization.code == code,
                AcademicSpecialization.id != spec.id,
            )
        )
        if clash is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"This course already has a specialization with code {code}.",
            )
        fields["code"] = code
    if "name" in fields and fields["name"]:
        fields["name"] = fields["name"].strip()
    for field, value in fields.items():
        setattr(spec, field, value)
    db.commit()
    db.refresh(spec)
    return _academic_specialization_out(db, spec)


# ------------------------------------------------ the single ancestry writer --


class _Ancestry(NamedTuple):
    department_id: str | None
    course_id: str | None
    specialization_id: str | None


_ANCESTRY_FIELDS = ("department_id", "course_id", "specialization_id")


def _resolve_ancestry(db: Session, intended: dict, sent: set[str]) -> _Ancestry:
    """Walk UP from the deepest level supplied and derive every ancestor.

    THE SPLIT-BRAIN THIS PREVENTS. `cohorts` carries three parent pointers
    (department, course, specialization), which is three chances to disagree,
    and the disagreement is silent — it surfaces as a profile card printing the
    wrong department under the words "verified by Main Admin". So the client
    never sets them independently: it names the deepest level it knows, this
    function follows the real foreign keys upward to fill the rest, and a
    SHALLOWER value the client ALSO sent is CHECKED against the derived one
    rather than stored beside it. A contradiction is a 422 naming both, never
    a silent pick.

    `intended` is the full three-field picture after the request is applied
    (for a PATCH: the row's current values overlaid with what was sent).
    `sent` is which of those keys the client actually supplied — the ones that
    can contradict a derivation. An explicit null on a shallower level while a
    deeper one is set is a contradiction too: "no course" cannot coexist with
    a specialization that belongs to one.
    """
    spec = None
    if intended.get("specialization_id") is not None:
        spec = db.get(AcademicSpecialization, intended["specialization_id"])
        if spec is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Specialization not found."
            )
    course_id = spec.course_id if spec is not None else intended.get("course_id")
    course = None
    if course_id is not None:
        course = db.get(AcademicCourse, course_id)
        if course is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Course not found.")
    department_id = course.department_id if course is not None else intended.get("department_id")
    if department_id is not None and db.get(Department, department_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Department not found.")

    derived = _Ancestry(department_id, course_id, spec.id if spec is not None else None)
    for field in ("department_id", "course_id"):
        if field in sent and intended.get(field) != getattr(derived, field):
            deeper = "specialization" if field == "course_id" else "course"
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    f"{field} contradicts the {deeper} you chose, which sits under "
                    f"{field} {getattr(derived, field)}. Clear the {deeper} first, or pick "
                    f"one under the {field.removesuffix('_id')} you want."
                ),
            )
    return derived


# ------------------------------------------------- cohorts (UI: "batches") --


class AdminCohortOut(BaseModel):
    """Named for its surface, NOT `CohortOut`.

    `CohortOut` already exists twice with different shapes — `director.py:116`
    and `badge_verification.py:429`. A third would deepen a collision this
    codebase already suffers from.
    """

    id: str
    department_id: str | None
    course_id: str | None
    specialization_id: str | None
    code: str
    name: str
    batch_label: str
    degree_level: str
    entry_date: date
    expected_completion: date
    student_count: int
    #: Labels of the levels that are required NOW and blank on this row. Empty
    #: means compliant. The console renders each as a `.chip warn` reading
    #: "Needs Course" — text and colour, never colour alone — and the row stays
    #: editable and seatable. Flagged, not quarantined.
    missing_levels: list[str]


class AdminCohortIn(BaseModel):
    code: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=200)
    batch_label: str = Field(min_length=1, max_length=64)  # e.g. 2024-26
    degree_level: DegreeLevel
    entry_date: date
    expected_completion: date
    # The optional levels. Send the DEEPEST one you know; the ancestors are
    # derived (_resolve_ancestry). Both nullable at the wire; whether either is
    # REQUIRED is decided by the validator below, from HIERARCHY_LEVELS.
    course_id: str | None = None
    specialization_id: str | None = None

    @model_validator(mode="after")
    def _honour_required_levels(self) -> "AdminCohortIn":
        # Reader 1 of the switch. Reader 2 is GET /admin/hierarchy/levels,
        # which the form builds its validators from — so a level flipped to
        # required is refused here AND marked on the form, from one constant.
        missing = [lv.label for lv in _required_levels() if getattr(self, lv.field) is None]
        if missing:
            raise ValueError(
                "These are required when creating a batch: "
                + ", ".join(missing)
                + ". (Set by HIERARCHY_LEVELS in app/models/institution.py.)"
            )
        return self


class AdminCohortPatchIn(PatchModel):
    # campus/contact are nullable columns and stay off this list; these four
    # are NOT NULL, so clearing them is a 422 and not a 500. See PatchModel.
    NON_NULLABLE: ClassVar[frozenset[str]] = frozenset(
        {"name", "batch_label", "entry_date", "expected_completion"}
    )

    name: str | None = Field(default=None, min_length=1, max_length=200)
    batch_label: str | None = Field(default=None, min_length=1, max_length=64)
    entry_date: date | None = None
    expected_completion: date | None = None
    # THE MOVE. Without this field, `department_id` had exactly one writer —
    # cohort creation — so every cohort that existed before this feature (the
    # seeded one included) was stranded with department_id NULL and no way to
    # set it. And because list_cohorts is keyed on a department path segment, a
    # NULL-department cohort is invisible to the console entirely: unreachable
    # and unfixable. The migration's own comment said "an admin sets it
    # afterwards" while no code path let them.
    #
    # Nullable on purpose, and it IS in NON_NULLABLE's complement: sending null
    # un-seats the batch from its department, which is the only way to correct
    # a batch filed under the wrong one.
    department_id: str | None = None
    # The optional levels, omit-means-keep. Explicit null clears — but only
    # where that does not WIDEN the compliance gap (update_cohort): a required
    # level may be filled in, never emptied, and a legacy batch missing one may
    # still have everything else corrected.
    course_id: str | None = None
    specialization_id: str | None = None


def _admin_cohort_out(db: Session, cohort: Cohort) -> AdminCohortOut:
    count = db.scalar(
        select(func.count()).select_from(Student).where(Student.cohort_id == cohort.id)
    )
    return AdminCohortOut(
        id=cohort.id,
        department_id=cohort.department_id,
        course_id=cohort.course_id,
        specialization_id=cohort.specialization_id,
        missing_levels=[lv.label for lv in _compliance_gap(cohort)],
        code=cohort.code,
        name=cohort.name,
        batch_label=cohort.batch_label,
        degree_level=cohort.degree_level.value,
        entry_date=cohort.start_date.date(),
        expected_completion=cohort.end_date.date(),
        student_count=int(count or 0),
    )


@router.get("/departments/{department_id}/cohorts", response_model=list[AdminCohortOut])
def list_cohorts(
    department_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[AdminCohortOut]:
    require_director(session)
    if db.get(Department, department_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Department not found.")
    rows = db.scalars(
        select(Cohort).where(Cohort.department_id == department_id).order_by(Cohort.batch_label)
    ).all()
    return [_admin_cohort_out(db, c) for c in rows]


@router.get("/cohorts/unassigned", response_model=list[AdminCohortOut])
def list_unassigned_cohorts(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[AdminCohortOut]:
    """Batches that belong to no department yet.

    WITHOUT THIS ENDPOINT THE CONSOLE CANNOT SEE THEM. Every other cohort read
    is `GET /departments/{id}/cohorts`, keyed on a department, so a cohort with
    department_id NULL matches no path — invisible, and therefore impossible to
    move into a department even now that PATCH accepts one. Every cohort
    predating this feature is in exactly that state, the seeded one included.

    This is the console's inbox for them: list here, then PATCH a department_id
    onto each. Once seated a cohort leaves this list, so an empty response is
    the healthy steady state rather than an error.
    """
    require_director(session)
    rows = db.scalars(
        select(Cohort).where(Cohort.department_id.is_(None)).order_by(Cohort.batch_label)
    ).all()
    return [_admin_cohort_out(db, c) for c in rows]


@router.get("/cohorts/incomplete", response_model=list[AdminCohortOut])
def list_incomplete_cohorts(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[AdminCohortOut]:
    """Batches that do not name every currently-required level.

    Flipping a level to required in HIERARCHY_LEVELS does not touch a single
    row — so the morning after that deploy, every batch created before it is
    non-compliant. This is where they are listed, for the same reason
    /cohorts/unassigned exists: a row the console cannot reach is one it cannot
    fix. An empty response is the healthy steady state, and — because the
    predicate is built from the same tuple — it is honestly empty before the
    flip too, rather than pretending everything is compliant.
    """
    require_director(session)
    required = _required_levels()
    if not required:
        return []
    rows = db.scalars(
        select(Cohort)
        .where(or_(*(getattr(Cohort, lv.field).is_(None) for lv in required)))
        .order_by(Cohort.batch_label)
    ).all()
    return [_admin_cohort_out(db, c) for c in rows]


@router.post(
    "/departments/{department_id}/cohorts",
    response_model=AdminCohortOut,
    status_code=status.HTTP_201_CREATED,
)
def create_cohort(
    department_id: str,
    body: AdminCohortIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> AdminCohortOut:
    """Create a batch under a department.

    Entry date and expected completion live HERE, on the batch — not on the
    student. That is what the design shows, and it is why adding an academic
    year level later costs one table rather than a backfill of every student.
    """
    require_director(session)
    if db.get(Department, department_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Department not found.")
    if body.expected_completion <= body.entry_date:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Expected completion must be after the entry date.",
        )
    code = body.code.strip().upper()
    if db.scalar(select(Cohort).where(Cohort.code == code)) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A batch with code {code} already exists.",
        )
    # The path names the department; the body may name a course and/or a
    # specialization. All three go through the one ancestry writer, so a course
    # under some OTHER department is a 422 here rather than a card that lies.
    sent = {"department_id"} | {f for f in ("course_id", "specialization_id") if getattr(body, f)}
    ancestry = _resolve_ancestry(
        db,
        {
            "department_id": department_id,
            "course_id": body.course_id,
            "specialization_id": body.specialization_id,
        },
        sent,
    )
    cohort = Cohort(
        code=code,
        name=body.name.strip(),
        batch_label=body.batch_label.strip(),
        degree_level=body.degree_level,
        department_id=ancestry.department_id,
        course_id=ancestry.course_id,
        specialization_id=ancestry.specialization_id,
        start_date=_as_utc_midnight(body.entry_date),
        end_date=_as_utc_midnight(body.expected_completion),
    )
    db.add(cohort)
    db.commit()
    db.refresh(cohort)
    return _admin_cohort_out(db, cohort)


@router.patch("/cohorts/{cohort_id}", response_model=AdminCohortOut)
def update_cohort(
    cohort_id: str,
    body: AdminCohortPatchIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> AdminCohortOut:
    """Edit a batch. Every seated student's locked profile card moves with it —
    which is the point of reading those facts through the join rather than
    copying them onto the student."""
    require_director(session)
    cohort = db.get(Cohort, cohort_id)
    if cohort is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Batch not found.")
    fields = body.model_dump(exclude_unset=True)
    entry = fields.pop("entry_date", None)
    completion = fields.pop("expected_completion", None)
    new_entry = entry or cohort.start_date.date()
    new_completion = completion or cohort.end_date.date()
    if new_completion <= new_entry:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Expected completion must be after the entry date.",
        )
    sent_ancestry = {f for f in _ANCESTRY_FIELDS if f in fields}
    if sent_ancestry:
        # Every parent pointer goes through the ONE writer, current values
        # overlaid with what was sent. An explicit null un-seats — allowed, but
        # only where nothing deeper still points there (a contradiction is a
        # 422 from _resolve_ancestry) and only where it does not widen the
        # compliance gap (checked below).
        intended = {f: fields.pop(f, getattr(cohort, f)) for f in _ANCESTRY_FIELDS}
        ancestry = _resolve_ancestry(db, intended, sent_ancestry)
        gap_before = {lv.key for lv in _compliance_gap(cohort)}
        for f in _ANCESTRY_FIELDS:
            setattr(cohort, f, getattr(ancestry, f))
        gap_after = {lv.key for lv in _compliance_gap(cohort)}
        widened = gap_after - gap_before
        if widened:
            # THE NO-REGRESSION RULE. A required level may be filled in, and a
            # legacy batch that is missing one may still have its name, dates
            # or department corrected — the gap is unchanged, the PATCH
            # passes. What may NOT happen is an edit that makes a compliant
            # batch non-compliant. That is the difference between a
            # data-quality rule and a lockout.
            labels = [
                lv.label for lv in institution_model.HIERARCHY_LEVELS if lv.key in widened
            ]
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    "This edit would remove " + ", ".join(labels)
                    + ", which is required. Choose a value or leave the field unchanged."
                ),
            )
    if entry is not None:
        cohort.start_date = _as_utc_midnight(entry)
    if completion is not None:
        cohort.end_date = _as_utc_midnight(completion)
    for field, value in fields.items():
        setattr(cohort, field, value)
    db.commit()
    db.refresh(cohort)
    return _admin_cohort_out(db, cohort)


# ------------------------------------------------------ seating a student --


class SetStudentCohortIn(BaseModel):
    """Null releases the student from their batch.

    Explicitly Optional rather than absent-means-keep, mirroring
    `AssignMentorIn` in director.py: an explicit null is the un-seat action, and
    a field that cannot express it forces a second endpoint.
    """

    cohort_id: str | None = None


class AdminStudentRowOut(BaseModel):
    """One student as the seating panel lists them. Name and email come from
    the User row, USN and stage from the Student row; nothing else — this is
    a roster line, not a record, and the console does not need marks to seat
    someone."""

    student_id: str
    name: str
    email: str
    usn: str | None
    current_stage: str | None
    cohort_id: str | None


def _student_rows(db: Session, *where) -> list[AdminStudentRowOut]:
    rows = db.execute(
        select(
            Student.id,
            User.name,
            User.email,
            Student.usn,
            Student.current_stage,
            Student.cohort_id,
        )
        .join(User, Student.user_id == User.id)
        .where(*where)
        .order_by(User.name)
    ).all()
    return [
        AdminStudentRowOut(
            student_id=sid,
            name=name,
            email=email,
            usn=usn,
            current_stage=stage.value if hasattr(stage, "value") else stage,
            cohort_id=cohort_id,
        )
        for sid, name, email, usn, stage, cohort_id in rows
    ]


@router.get("/cohorts/{cohort_id}/students", response_model=list[AdminStudentRowOut])
def list_cohort_students(
    cohort_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[AdminStudentRowOut]:
    """Who is seated in this batch. The read half of the seating panel."""
    require_director(session)
    if db.get(Cohort, cohort_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Batch not found.")
    return _student_rows(db, Student.cohort_id == cohort_id)


@router.get("/students/unseated", response_model=list[AdminStudentRowOut])
def list_unseated_students(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[AdminStudentRowOut]:
    """Students in no batch at all — the pool the seating panel picks from.

    NOT the same as director.py's /unassigned-students, which is students with
    no MENTOR. Two different facts, two different lists; a student can have a
    mentor and no batch, or a batch and no mentor. An empty response is the
    healthy steady state, exactly like /cohorts/unassigned.
    """
    require_director(session)
    return _student_rows(db, Student.cohort_id.is_(None))


@router.put("/students/{student_id}/cohort", status_code=status.HTTP_204_NO_CONTENT)
def set_student_cohort(
    student_id: str,
    body: SetStudentCohortIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> None:
    """Seat a student in a batch, or release them.

    This is the write that makes the locked profile card work at all. Before it,
    `students.cohort_id` was set only by `app/seed.py` and
    `python -m app.seed_roster` — neither of which runs on a production host.
    """
    require_director(session)
    student = db.get(Student, student_id)
    if student is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")
    if body.cohort_id is not None and db.get(Cohort, body.cohort_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Batch not found.")
    student.cohort_id = body.cohort_id
    db.commit()


# -------------------------------------------------- staff activation link --


class ActivationLinkOut(BaseModel):
    link: str
    emailed: bool
    expires_in_hours: int


@router.post("/users/{user_id}/activation-link", response_model=ActivationLinkOut)
def issue_activation_link(
    user_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> ActivationLinkOut:
    """Mint (or re-mint) a staff member's activation link, and show it.

    THE ON-SCREEN LINK IS PERMANENT, not a stopgap while SES is in its
    sandbox. When someone says "the email never arrived" — and someone will —
    the admin reads them this link instead of waiting on a mail queue. Each
    call supersedes the previous link, so "resend" hands over exactly one that
    works. Refuses a STUDENT: they sign in with Google and hold no password.
    """
    require_director(session)
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    try:
        link, emailed = account_links.issue_activation(
            db, user, created_by_user_id=session["userId"]
        )
    except ValueError as why:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(why))
    return ActivationLinkOut(
        link=link, emailed=emailed, expires_in_hours=settings.activation_link_hours
    )


# ------------------------------------- the two columns that had no writer --


class InstitutionalIdentityIn(BaseModel):
    """`users.designation` and `users.department`.

    Both columns have existed since c4e91b5d2e70 and are READ in two places —
    the BGSCET leave form, which labels them "(synced)", and the director's
    mentor-load screen. Neither had a writer anywhere in the codebase: not an
    endpoint, not a CLI, not even a seed. They rendered null forever, and the
    leave form's "(synced)" was a promise nothing kept. This is the writer.
    """

    designation: str | None = Field(default=None, max_length=120)
    department: str | None = Field(default=None, max_length=120)


class InstitutionalIdentityOut(BaseModel):
    user_id: str
    name: str
    email: str
    designation: str | None
    department: str | None


@router.patch("/users/{user_id}/institutional-identity", response_model=InstitutionalIdentityOut)
def set_institutional_identity(
    user_id: str,
    body: InstitutionalIdentityIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> InstitutionalIdentityOut:
    require_director(session)
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    fields = body.model_dump(exclude_unset=True)
    for field, value in fields.items():
        # An empty string is a clearing, not a value — the leave form should say
        # "not on record" rather than print a blank line.
        setattr(user, field, (value or "").strip() or None)
    db.commit()
    db.refresh(user)
    return InstitutionalIdentityOut(
        user_id=user.id,
        name=user.name,
        email=user.email,
        designation=user.designation,
        department=user.department,
    )
