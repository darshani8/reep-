"""Mentor mapping — who mentors whom, who may change it, and what that leaves
behind (B9.1–B9.4).

WHY THIS IS ITS OWN MODULE. Every endpoint here was in `routers/console.py`,
which is 3 282 lines of programme-wide aggregates — criteria, alert rules, the
catalogue, the jobs sheet, three analytics endpoints, exports. Mentor mapping is
not an aggregate: it is the WRITE that decides rule 2's scope key. Moving a
student between faculty members changes who may read that student's marks,
attendance, USN, mentor notes and interview transcripts, and B9 adds a history
table, a 90-day handover grant and a per-department capacity to that act. Five
hundred and fifty lines of that filed under "console" is five hundred and fifty
lines nobody finds when they ask "where is mentor assignment decided" — and this
is the file where the answer has to be findable, because the next editor of it
is editing access control.

Same `/admin` prefix, same capabilities, same paths: this is a move, not a
redesign. The four endpoints are exactly the ones that were there —
`GET /mentor-load`, `GET /unassigned-students`, `POST /students/{id}/mentor`,
`GET /students/{id}/mentor-history` — plus the two helpers
(`ensure_mentor_group`, `_assert_same_college`) that `admin_students.py` imports
so the roster editor and the batch bar apply the same rules as the assignment
screen rather than their own.

------------------------------------------------------------------------------
WHAT LIVES NEXT DOOR, AND WHY IT IS NOT IN HERE
------------------------------------------------------------------------------

`app/mentor_history.py` owns the history table and the handover grant: it is the
ONE writer of `mentor_assignments`, called by all five writers of
`students.mentor_id` (this module, two paths in `admin_students.py`, `app/seed.py`
and `app/grant_access.py`) and by `release_mentees_of`, which
`admin_faculty.disable_account` calls to unseat an offboarded faculty member's
mentees. `app/mentor_functions.py` names those five by count as a known hazard,
and the way a stored fact stays true is that there is one function that writes
it, not five call sites that each remember to.

CAPACITY IS ADVISORY AND NOTHING IN HERE READS IT. `departments.mentor_capacity`
makes the number settable per department instead of only in `.env`; it is
reported on the load board and no assignment endpoint consults it. See
`MentorLoadOut.capacity` for the argument, which is the owner's and predates
this phase.
"""

import io
from dataclasses import dataclass
from datetime import datetime

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, aliased

from .. import batch_labels, mentor_mapping
from ..config import settings
from ..db import get_db
from ..identity import get_current_session

from ..architecture_events import record_change
from ..governance import ancestry_of_student, ancestry_of_user, require_capability
# The office's spreadsheet, read by the same reader B8.1's imports use, so a
# file this screen refuses and a file the Imports screen refuses are refused
# for the same reasons in the same words.
from ..imports_sheet import MAX_UPLOAD_BYTES, SheetError, parse_sheet, read_text
# The one writer of `mentor_assignments`, and the one minter of the handover
# grant. Read its module docstring before changing anything in here that moves
# `students.mentor_id`.
from ..mentor_history import record_mentor_change
from ..models.attendance import AttendanceRecord
from ..models.cohort import Cohort
from ..models.governance import ScopeLevel
from ..models.institution import AcademicCourse, AcademicSpecialization, Department
from ..models.mentor_assignment import MentorAssignment
from ..models.skill import StudentSkill
from ..models.time_ledger import TimeLedgerCell, TimeLedgerDay
from ..models.user import Mentor, Role, Student, User
from ..policies import scope_filter
from ..scope_views import scope_header
from ..staff_placement import UNFILED, placements_for
# The response shape is defined once, next to the endpoints that own faculty.
# Redefining it here would be the "one name, two shapes" the guard in
# tests/test_codebase_guards.py exists to stop.
from .admin_faculty import StaffPlacementOut

router = APIRouter(prefix="/admin", tags=["admin"])


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
    # The number the assignment screen derives "N free" from: the faculty
    # member's DEPARTMENT capacity (B9.2), falling back to the programme's
    # `settings.mentor_capacity` where the department has not named one — which
    # is every department until somebody types one in, so this is unchanged for
    # every existing deployment.
    #
    # STILL NOTHING ENFORCES IT, and that is the decision rather than an
    # omission. What was wrong before was only that the number lived in an
    # environment variable, so tuning it for one department meant a deploy. An
    # admin who chooses to overload one faculty member in a thin year is still
    # allowed to: the rail says "At capacity" in the risk colour and lets them.
    # `set_student_mentor` below does not read this field.
    capacity: int
    #: Whether the figure above came from the department or from the programme
    #: default, so the screen can say "capacity 25 (Management)" rather than
    #: presenting a programme number as a departmental decision.
    capacity_source: str
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


#: B8.5 asks for `mentor-load?page=`. THE RESPONSE IS STILL A BARE ARRAY and the
#: page is stated in headers, for `app/scope_views.py`'s reason said again: four
#: Angular screens read this endpoint (Faculty, Mentors & students, Students and
#: Analytics) and every one of them is built against `list[MentorLoadOut]`.
#: Wrapping it in `{page, rows}` is a breaking change to all four, spent on the
#: least important half of the requirement.
#:
#: PAGING IS OPT-IN AND OFF BY DEFAULT. `page_size` unset returns every row the
#: reach covers, which is exactly what those four screens get today; a default
#: page size would silently truncate three screens that do their own filtering
#: over the whole set and have no paging control to reach row 51 with.
PAGE_HEADER = "X-Reep-Page"
PAGE_SIZE_HEADER = "X-Reep-Page-Size"
TOTAL_HEADER = "X-Reep-Total"

#: The largest page this endpoint will hand out in one response. A page size is
#: a query parameter, and an unbounded one is "give me everything" with extra
#: steps.
MAX_PAGE_SIZE = 500
#: The highest page any list here will serve. Unbounded, a crafted `?page=` made
#: `(page - 1) * page_size` overflow Postgres' bigint OFFSET and the request a 500
#: (DEF-006, testing/docs/05-incident-reports.md). A value past it is a 422.
MAX_PAGE = 100_000


def _page_headers(response: Response, *, total: int, page: int, page_size: int | None) -> None:
    """State the page on the response. `total` is ALWAYS set, paged or not — it
    is what lets a client that asked for no page tell a short list from a
    truncated one, and what a paging control counts its pages from."""
    response.headers[TOTAL_HEADER] = str(total)
    if page_size is not None:
        response.headers[PAGE_HEADER] = str(page)
        response.headers[PAGE_SIZE_HEADER] = str(page_size)


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


#: Where a faculty member's "N free" number came from. Two words rather than a
#: boolean, because the screen prints one of them.
CAPACITY_DEPARTMENT = "department"
CAPACITY_PROGRAMME = "programme"


def _capacities_of(db: Session, department_ids: list[str]) -> dict[str, int | None]:
    """`departments.mentor_capacity` for the departments on this page, in one
    query. A NULL stays NULL and the caller falls back to the programme number —
    it is not coalesced here, because "this department said 20" and "nobody said
    anything and the programme default is 20" are different sentences on screen
    even when the figure matches."""
    if not department_ids:
        return {}
    return {
        did: cap
        for did, cap in db.execute(
            select(Department.id, Department.mentor_capacity).where(
                Department.id.in_(set(department_ids))
            )
        ).all()
    }


@router.get("/mentor-load", response_model=list[MentorLoadOut])
def mentor_load(
    response: Response,
    college_id: str | None = None,
    department_id: str | None = None,
    cohort_id: str | None = None,
    q: str | None = None,
    page: int = Query(default=1, ge=1, le=MAX_PAGE),
    page_size: int | None = None,
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
    the office hands it a student.

    PAGED ONLY WHEN ASKED (B8.5). `?page_size=` opts in; without it every row
    the reach covers comes back, which is what the four screens reading this
    endpoint expect. The page is stated in `X-Reep-Total` / `X-Reep-Page` /
    `X-Reep-Page-Size` rather than in an envelope — see `PAGE_HEADER` above.
    The page is taken over the FACULTY rows, and the mentee queries are then
    narrowed to that page's groups: paging the response while still summing
    every attendance row on the deployment would be a paging control that makes
    the screen no faster, which is the only reason anyone asked for one."""
    require_capability(db, session, MENTOR_LOAD_CAPABILITY)
    reach = scope_filter(db, session, MENTOR_LOAD_CAPABILITY)
    scope_header(response, reach)
    if reach.nothing:
        # The total is stated even here, so a client cannot read "no header" as
        # "the server does not paginate" and quietly conclude the list is
        # complete. `X-Reep-Scope: none` beside it is what says WHY it is zero.
        _page_headers(response, total=0, page=page, page_size=page_size)
        return []

    # A REMOVED account (users.deleted_at, 2026-09-16) is off this screen on
    # both sides: a removed faculty member is not offered for assignment and a
    # removed student is not counted as anybody's mentee. Every query below
    # that reads `student_where` joins `users`, which is what lets the same
    # predicate serve both.
    faculty_where = [
        User.role == Role.MENTOR, User.id.in_(reach.user_ids()), User.deleted_at.is_(None),
    ]
    student_where = [Student.id.in_(reach.student_ids()), User.deleted_at.is_(None)]
    if department_id:
        faculty_where.append(User.department_id == department_id)
        student_where.append(_student_department_expr() == department_id)
    if college_id:
        in_college = _departments_of(db, college_id)
        faculty_where.append(User.department_id.in_(in_college))
        student_where.append(_student_department_expr().in_(in_college))
    # B9.4. A BATCH IS A FACT ABOUT STUDENTS AND NOT ABOUT FACULTY, so it
    # narrows the MENTEE rows only and deliberately leaves the faculty list
    # whole. Dropping faculty who happen to have nobody in the batch would turn
    # "show me who is mentoring 2026 MBA" into "hide every faculty member I
    # could seat them with", on the screen whose whole job is seating them.
    if cohort_id:
        student_where.append(Student.cohort_id == cohort_id)
    # `?q=` is the faculty search: name or email, case-insensitive, a substring.
    # It narrows the FACULTY side only, for the mirror of the same reason — the
    # reader is looking for a person.
    if q and q.strip():
        needle = f"%{q.strip().lower()}%"
        faculty_where.append(
            or_(func.lower(User.name).like(needle), func.lower(User.email).like(needle))
        )

    mentor_query = (
        select(
            Mentor.id, User.id, User.name, User.department, User.designation,
            User.department_id,
        )
        .select_from(User)
        .outerjoin(Mentor, Mentor.user_id == User.id)
        .where(*faculty_where)
        .order_by(User.name, User.id)
    )
    total = (
        db.scalar(
            select(func.count()).select_from(
                select(User.id).where(*faculty_where).subquery()
            )
        )
        or 0
    )
    if page_size is not None:
        page_size = max(1, min(int(page_size), MAX_PAGE_SIZE))
        page = max(1, int(page))
        mentor_query = mentor_query.offset((page - 1) * page_size).limit(page_size)
    _page_headers(response, total=total, page=page, page_size=page_size)

    mentors = db.execute(mentor_query).all()
    # ORDERED BY NAME **AND ID**. A page is a window over a sort, and `users.name`
    # is not unique — two faculty members called "S Kumar" make the sort
    # unstable, which drops one of them off page 2 and repeats the other, with
    # nothing on screen saying so. `mentor.alerts` carries the same note for the
    # same reason.

    # Only the mentees of the faculty ON THIS PAGE: when nothing is paged this
    # is every group in the reach, exactly as before, and when a page was asked
    # for it is the whole point of having asked.
    page_mentor_ids = [mid for mid, *_ in mentors if mid]
    if page_size is not None:
        student_where = [*student_where, Student.mentor_id.in_(page_mentor_ids or [""])]

    students = db.execute(
        select(
            Student.id, User.name, Student.usn, Student.current_stage, Student.mentor_id,
            _student_department_expr().label("department_id"),
        )
        .join(User, Student.user_id == User.id)
        .where(*student_where)
        .order_by(User.name)
    ).all()

    # The three metric queries are narrowed to the students actually being
    # returned. They used to group over the WHOLE of `attendance_records`,
    # `student_skills` and the ledger on every request and then look up the
    # handful of ids they needed — correct, and three full scans per page view.
    listed_ids = [sid for sid, *_ in students] or [""]

    # Attendance: present and total per student, in one pass.
    att = {
        sid: (present or 0, total or 0)
        for sid, present, total in db.execute(
            select(
                AttendanceRecord.student_id,
                func.count().filter(AttendanceRecord.present.is_(True)),
                func.count(),
            )
            .where(AttendanceRecord.student_id.in_(listed_ids))
            .group_by(AttendanceRecord.student_id)
        ).all()
    }
    skills = {
        sid: n
        for sid, n in db.execute(
            select(StudentSkill.student_id, func.count())
            .where(
                StudentSkill.verified.is_(True),
                StudentSkill.student_id.in_(listed_ids),
            )
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
            .where(TimeLedgerDay.student_id.in_(listed_ids))
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
    # And one query for the departments on this page, for the same reason.
    capacities = _capacities_of(db, [dept for *_r, dept in mentors if dept])

    return [
        MentorLoadOut(
            mentor_id=mid,
            user_id=uid,
            name=name,
            department=department,
            designation=designation,
            placement=StaffPlacementOut.of(placements.get(uid, UNFILED)),
            # H2. The department's number where it named one, the programme's
            # where it did not — and the two are reported apart, because
            # "Management said 25" and "nobody has said anything and the
            # default is 25" print differently on the rail.
            #
            # `row_department_id` is NOT the `department_id` QUERY PARAMETER a
            # few lines up. It was spelled the same, and a comprehension has its
            # own scope, so the right value was read by accident rather than on
            # purpose — the first person to move this expression out of the
            # comprehension would have silently given every faculty member on
            # the page the capacity of whatever department the reader happened
            # to be filtering by.
            # `is not None`, NEVER `or`. `_capacities_of` returns
            # `dict[str, int | None]` and that signature is the whole point:
            # None means the department has named no number, and ZERO IS A
            # NUMBER A DEPARTMENT CAN NAME — "we are taking no new mentees this
            # year", which on an advisory rail reads as everyone over capacity.
            # `x or default` collapses those two into one, and the second
            # expression is the worse half: it would report a department that
            # deliberately said 0 as CAPACITY_PROGRAMME, which is precisely the
            # thing this field exists to prevent ("so a programme default is not
            # presented as a departmental decision").
            capacity=(
                capacities[row_department_id]
                if capacities.get(row_department_id) is not None
                else settings.mentor_capacity
            ),
            capacity_source=(
                CAPACITY_DEPARTMENT
                if capacities.get(row_department_id) is not None
                else CAPACITY_PROGRAMME
            ),
            mentee_count=len(by_mentor.get(mid, [])),
            mentees=by_mentor.get(mid, []),
        )
        for mid, uid, name, department, designation, row_department_id in mentors
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
    cohort_id: str | None = None,
    q: str | None = None,
    page: int = Query(default=1, ge=1, le=MAX_PAGE),
    page_size: int | None = None,
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

    PAGED ONLY WHEN ASKED (B9.4), exactly as `mentor-load` is: `?page_size=`
    opts in, the response stays a BARE ARRAY and the page is stated in
    `X-Reep-Total` / `X-Reep-Page` / `X-Reep-Page-Size`. `X-Reep-Total` is set
    even when nothing was paged, which is what lets the picker say "18 students
    with no mentor" without counting the array it happens to have — and what
    stops a client reading a short list as a complete one.
    """
    require_capability(db, session, "admin.mentors")
    reach = scope_filter(db, session, "admin.mentors")
    scope_header(response, reach)
    if reach.nothing:
        # The total is stated even here, so "you may see nothing" cannot be read
        # as "there is nothing" — `X-Reep-Scope: none` beside it says which.
        _page_headers(response, total=0, page=page, page_size=page_size)
        return []
    where = [Student.mentor_id.is_(None), Student.id.in_(reach.student_ids()), User.deleted_at.is_(None)]
    if department_id:
        where.append(_student_department_expr() == department_id)
    if college_id:
        where.append(_student_department_expr().in_(_departments_of(db, college_id)))
    # B9.4. Both narrow within the reach and neither can widen it: every one of
    # these is ANDed onto `reach.student_ids()`, so an id outside the caller's
    # grant matches nothing rather than somebody else's roster.
    if cohort_id:
        where.append(Student.cohort_id == cohort_id)
    if q and q.strip():
        needle = f"%{q.strip().lower()}%"
        where.append(
            or_(func.lower(User.name).like(needle), func.lower(Student.usn).like(needle))
        )
    total = (
        db.scalar(
            select(func.count()).select_from(
                select(Student.id)
                .join(User, Student.user_id == User.id)
                .where(*where)
                .subquery()
            )
        )
        or 0
    )
    pool = (
        select(Student.id, User.name, Student.usn, Student.current_stage)
        .join(User, Student.user_id == User.id)
        .where(*where)
        # NAME **AND ID**. A page is a window over a sort and `users.name` is not
        # unique: two students called "S Kumar" make the sort unstable, which
        # drops one off page 2 and repeats the other with nothing on screen
        # saying so. `mentor-load` and `mentor.alerts` carry the same note.
        .order_by(User.name, Student.id)
    )
    if page_size is not None:
        page_size = max(1, min(int(page_size), MAX_PAGE_SIZE))
        page = max(1, int(page))
        pool = pool.offset((page - 1) * page_size).limit(page_size)
    _page_headers(response, total=total, page=page, page_size=page_size)
    rows = db.execute(pool).all()
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
    #: WHY. B9.2, and it is REQUIRED — a 422 without it.
    #:
    #: THIS IS A BREAKING CHANGE AND IT LANDED WITH ITS CLIENT. The Angular
    #: screen posted `{mentor_id}` and nothing else until this commit, and the
    #: reason input beside the assign button was disabled behind
    #: `[reepPending]="4"`. Both halves are in the same change, along with the
    #: two test modules that asserted a 204 on a bodiless assignment; shipping
    #: the server half alone is an assign button that 422s on a live console.
    #:
    #: Required rather than nullable because `mentor_id` is rule 2's scope key.
    #: Moving a student changes who may read their marks, attendance, USN,
    #: mentor notes and interview transcripts, and the one question asked
    #: afterwards is "why is this student in my group / no longer in my group".
    #: The row itself holds the answer to neither, which is the same argument
    #: `admin_faculty.disable_account` makes for demanding a reason there.
    #: A RELEASE needs one just as much as an assignment does — arguably more,
    #: since nothing on any screen shows the student moved at all.
    reason: str = Field(min_length=1, max_length=400)

    @field_validator("reason", mode="before")
    @classmethod
    def _reason(cls, v: object) -> str:
        collapsed = " ".join(str(v or "").split())
        if not collapsed:
            raise ValueError("say why this student is being moved")
        return collapsed


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
    # B9.1. The history row and the 90-day handover grant, through the ONE
    # writer — see app/mentor_history.py for why five call sites share it and
    # why the window is a scoped grant rather than a branch in rule 2. It
    # flushes and does not commit, so the pointer and its history land in the
    # same transaction: a committed history row over a rolled-back pointer is a
    # record of something that did not happen.
    record_mentor_change(
        db,
        student_id=student.id,
        previous_mentor_id=before,
        new_mentor_id=mentor_id,
        by_user_id=session.get("userId"),
        reason=body.reason,
        session=session,
        request=request,
    )
    record_change(
        db, session=session, request=request, tenant_id=None,
        entity_type="student", entity_id=student.id, action="MENTOR_ASSIGNED",
        before={"mentor_id": before}, after={"mentor_id": mentor_id},
        event_type="student.mentor.assigned",
        payload={
            "student_id": student.id, "mentor_id": mentor_id,
            "released": mentor_id is None, "reason": body.reason,
        },
    )
    db.commit()


class MentorAssignmentOut(BaseModel):
    """One spell, as the history card draws it."""

    id: str
    mentor_id: str
    #: The faculty member's name, or null if that account is gone.
    mentor_name: str | None
    #: NULL means "mentoring since before this was recorded" — see
    #: `app/models/mentor_assignment.py`. The card prints those words; it must
    #: never render a NULL as the migration's run date or as a blank.
    from_at: datetime | None
    #: NULL means this is the CURRENT pair.
    to_at: datetime | None
    kind: str
    by_name: str | None
    reason: str | None
    end_kind: str | None
    ended_by_name: str | None
    end_reason: str | None


@router.get("/students/{student_id}/mentor-history", response_model=list[MentorAssignmentOut])
def mentor_history(
    student_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[MentorAssignmentOut]:
    """Every mentor this student has had, newest first — B9.1's read.

    GATED AND SCOPED THE SAME WAY THE ASSIGNMENT IS. `admin.mentors` bare for
    "may you look at all", then again with the student's ancestry as `target`
    for "may you look at THIS one". Reading who has mentored somebody is reading
    about that student, so it takes the same fence the write takes.

    AN EMPTY LIST IS "NO ASSIGNMENT RECORDED", NOT "NEVER HAD A MENTOR", and the
    two really are different: a student seated before this table existed has one
    seeded open row with a NULL `from_at`, while a student who has never been
    assigned has no row at all. The client says so in words rather than drawing
    a gap.

    Newest first because the question is almost always "who has them now, and
    who had them before that". The open row sorts first on `to_at NULLS FIRST`.
    """
    require_capability(db, session, "admin.mentors")
    if db.get(Student, student_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")
    require_capability(db, session, "admin.mentors", target=ancestry_of_student(db, student_id))
    return compose_mentor_history(db, student_id)


def compose_mentor_history(db: Session, student_id: str) -> list[MentorAssignmentOut]:
    """The rows, with no gate of its own — the caller has already decided who
    may read them.

    SPLIT OUT SO THERE IS ONE OF IT. The Student 360 read (B4.5) draws the same
    history in its mentor panel, and it reaches it through its own two fences:
    `admin.students` with the student's ancestry, then rule 2. A second query
    over the same table would be a second answer to "who mentored this student"
    the first time one of them learned to hide a row.
    """
    opened = aliased(User)
    ended = aliased(User)
    rows = db.execute(
        select(MentorAssignment, User.name, opened.name, ended.name)
        .outerjoin(Mentor, Mentor.id == MentorAssignment.mentor_id)
        .outerjoin(User, User.id == Mentor.user_id)
        .outerjoin(opened, opened.id == MentorAssignment.by_user_id)
        .outerjoin(ended, ended.id == MentorAssignment.ended_by_user_id)
        .where(MentorAssignment.student_id == student_id)
        .order_by(
            MentorAssignment.to_at.desc().nullsfirst(),
            MentorAssignment.from_at.desc().nullslast(),
        )
    ).all()
    return [
        MentorAssignmentOut(
            id=row.id, mentor_id=row.mentor_id, mentor_name=mentor_name,
            from_at=row.from_at, to_at=row.to_at, kind=row.kind,
            by_name=by_name, reason=row.reason,
            end_kind=row.end_kind, ended_by_name=ended_by_name, end_reason=row.end_reason,
        )
        for row, mentor_name, by_name, ended_by_name in rows
    ]


# --- assign from a spreadsheet (2026-10-10) ---------------------------------
# The office's mentor list is a spreadsheet — a student per line, a faculty
# member beside them — and until now the only way onto the roster was that
# list retyped: one assignment per student on this screen, or the batch bar
# once per faculty member per batch. The three endpoints below take the file.
#
# THE WRITE IS THE SAME WRITE. `apply` sets `students.mentor_id` through
# `ensure_mentor_group`, refuses a cross-college pair through
# `_assert_same_college`, asks `require_capability` about BOTH people, writes
# the spell through `record_mentor_change` and an audit row per student,
# exactly as `set_student_mentor` does: a file of eighty assignments is eighty
# assignments, not a sixth writer of rule 2's scope key with rules of its own.
# What the file adds is MATCHING (`app/mentor_mapping.py`), and matching is
# where this can go wrong — which is why `preview` exists and writes nothing.
# The office reads the judged lines, fixes the file (a USN on the line settles
# any ambiguity; an email address settles a faculty name), and presses Assign
# on rows it has seen.
#
# PREVIEW WRITES NOTHING, AND APPLY JUDGES AGAIN. Unlike B8.1's imports no run
# row is kept: the file is small, the judge is deterministic, and the answer
# to `apply` names every line and what was done with it, which is the receipt
# — beside the per-student audit row and the spell on each student's own
# history card. A line whose verdict changed between the two presses (the
# student seated by hand in between) is reported with the verdict it has NOW.
#
# `admin.mentors`, like the single assignment. A faculty member by role holds
# nothing here: a mentor who could upload a sheet could seat themselves with
# any student in the programme and then read everything about them.

MAPPING_CAPABILITY = "admin.mentors"

#: The columns the template writes and `preview` reads back, with whether the
#: column must be filled — ONE constant for both, `imports_sheet.DATASET_COLUMNS`'
#: reason. `student` or `usn` must be given on every line; the sheet needs the
#: USN column only where a name is not enough.
MAPPING_COLUMNS: tuple[tuple[str, bool], ...] = (
    ("student", True),
    ("usn", False),
    ("faculty", True),
    ("specialization", False),
)
MAPPING_EXAMPLE: tuple[str, ...] = ("Priya Sharma", "1MP25MDM01", "Prof. Ramesh Kumar", "Finance")
MAPPING_SHAPE = (
    "One row per student: student (the name as the roster has it), usn (only where two "
    "students share a name), faculty (a name or an email address), specialization (optional)."
)

V_ASSIGN = "assign"
V_UNCHANGED = "unchanged"
V_DUPLICATE = "duplicate"
V_LISTED_TWICE = "listed_twice"
V_BLANK = "blank"
V_STUDENT_NOT_FOUND = "student_not_found"
V_STUDENT_AMBIGUOUS = "student_ambiguous"
V_FACULTY_NOT_FOUND = "faculty_not_found"
V_FACULTY_AMBIGUOUS = "faculty_ambiguous"
V_FACULTY_DISABLED = "faculty_disabled"
V_DIFFERENT_COLLEGE = "different_college"
V_OUT_OF_REACH = "out_of_reach"

_XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class MappingCandidateOut(BaseModel):
    """One of the people an ambiguous line could mean — enough to tell them
    apart on screen (USN and batch, or email) and nothing else."""

    id: str
    name: str
    detail: str | None


class MappingRowOut(BaseModel):
    #: The operator's line number: the header is line 1, as Excel's gutter has it.
    line_no: int
    #: The cells as typed, so the screen can show what was read beside what it meant.
    student: str | None
    usn: str | None
    faculty: str | None
    specialization: str | None
    verdict: str
    detail: str
    #: Who the line resolved to, when it did.
    student_id: str | None = None
    student_name: str | None = None
    student_usn: str | None = None
    batch: str | None = None
    current_faculty: str | None = None
    faculty_user_id: str | None = None
    faculty_name: str | None = None
    candidates: list[MappingCandidateOut] = []
    #: True only on `apply`, for the lines it wrote.
    applied: bool = False


class MappingPreviewOut(BaseModel):
    filename: str
    rows: list[MappingRowOut]
    #: Lines per verdict, for the sentence over the table.
    counts: dict[str, int]
    #: How many lines Assign would write right now.
    to_assign: int


class MappingApplyOut(MappingPreviewOut):
    applied: int
    reason: str


@dataclass
class _RosterRow:
    student_id: str
    name: str
    usn: str | None
    mentor_id: str | None
    batch: str | None
    current_faculty: str | None


@dataclass
class _FacultyRow:
    user_id: str
    name: str
    email: str
    disabled: bool
    mentor_id: str | None


def _roster_for_mapping(db: Session, reach) -> dict[str, _RosterRow]:
    """Every student this caller may seat, with the batch label the tiebreak
    reads and the faculty member they sit with today. A REMOVED account
    (`users.deleted_at`) is matched by nobody, `mentor-load`'s rule."""
    faculty_user = aliased(User)
    stmt = (
        select(
            Student.id, User.name, Student.usn, Student.mentor_id,
            Cohort.name, Cohort.batch_label, AcademicCourse.name, AcademicSpecialization.name,
            faculty_user.name,
        )
        .join(User, User.id == Student.user_id)
        .outerjoin(Cohort, Cohort.id == Student.cohort_id)
        .outerjoin(AcademicCourse, AcademicCourse.id == Cohort.course_id)
        .outerjoin(AcademicSpecialization, AcademicSpecialization.id == Cohort.specialization_id)
        .outerjoin(Mentor, Mentor.id == Student.mentor_id)
        .outerjoin(faculty_user, faculty_user.id == Mentor.user_id)
        .where(User.deleted_at.is_(None), Student.id.in_(reach.student_ids()))
    )
    roster: dict[str, _RosterRow] = {}
    for (sid, name, usn, mentor_id, cohort_name, batch_label,
         course_name, spec_name, faculty_name) in db.execute(stmt):
        batch = (
            batch_labels.compose(course_name, spec_name, cohort_name, batch_label)
            if cohort_name else None
        )
        roster[sid] = _RosterRow(sid, name, usn, mentor_id, batch, faculty_name)
    return roster


def _faculty_for_mapping(db: Session, reach) -> dict[str, _FacultyRow]:
    """Every faculty account this caller may seat students with. A removed
    account is not offered; a DISABLED one is listed so the line can say so
    rather than "not found", and is refused below."""
    stmt = (
        select(User.id, User.name, User.email, User.disabled_at, Mentor.id)
        .outerjoin(Mentor, Mentor.user_id == User.id)
        .where(User.role == Role.MENTOR, User.deleted_at.is_(None), User.id.in_(reach.user_ids()))
    )
    return {
        uid: _FacultyRow(uid, name, email, disabled_at is not None, mentor_id)
        for uid, name, email, disabled_at, mentor_id in db.execute(stmt)
    }


def _read_upload(file: UploadFile) -> tuple[bytes, str]:
    """The bytes, bounded the way every upload in the product is bounded: a
    `read(MAX + 1)` so the comparison runs before the memory is spent. Read
    SYNCHRONOUSLY, because these handlers are plain `def` on the threadpool —
    the registration lesson of 2026-09-29, where an `async def` doing blocking
    database work froze the whole process."""
    payload = file.file.read(MAX_UPLOAD_BYTES + 1)
    filename = (file.filename or "upload")[:255]
    if len(payload) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"The file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
        )
    return payload, filename


def _student_candidates(hits, roster: dict[str, _RosterRow]) -> list[MappingCandidateOut]:
    out = []
    for person in hits:
        row = roster[person.id]
        where = " · ".join(part for part in (row.usn, row.batch) if part)
        out.append(MappingCandidateOut(id=row.student_id, name=row.name, detail=where or None))
    return out


def _judge_mapping(
    db: Session, session: dict, payload: bytes, filename: str,
) -> list[MappingRowOut]:
    """Read the file and say, line by line, what Assign would do with it.

    Every verdict here is reached against THIS caller's reach, and the two
    fences the single assignment applies (`_assert_same_college`, the
    per-target `require_capability`) are asked per line so the preview and the
    apply cannot disagree about a pair.
    """
    reach = scope_filter(db, session, MAPPING_CAPABILITY)
    if reach.nothing:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your 'Mentors & students' capability reaches no student.",
        )
    try:
        lines = parse_sheet(payload, filename)
    except SheetError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc))

    roster = _roster_for_mapping(db, reach)
    faculty = _faculty_for_mapping(db, reach)
    students = [
        mentor_mapping.Person(id=row.student_id, name=row.name, key=row.usn, hint=row.batch or "")
        for row in roster.values()
    ]
    staff = [
        mentor_mapping.Person(id=row.user_id, name=row.name, key=row.email)
        for row in faculty.values()
    ]

    # Pass 1: the cells, and each name on its own.
    cells: list[tuple[str | None, str | None, str | None, str | None]] = []
    student_matches: list[mentor_mapping.Match] = []
    for line in lines:
        given = read_text(line.values, "student_name")
        usn = read_text(line.values, "usn")
        who = read_text(line.values, "faculty")
        spec = read_text(line.values, "specialization")
        cells.append((given, usn, who, spec))
        if usn:
            hit = mentor_mapping.by_key(usn, students)
            student_matches.append(
                mentor_mapping.Match(mentor_mapping.MATCH_EXACT, (hit,))
                if hit else mentor_mapping.Match(mentor_mapping.MATCH_NONE)
            )
        else:
            student_matches.append(mentor_mapping.match_name(given, students, hint=spec))
    # Pass 2: a name ambiguous here and plainly matched on another line.
    student_matches = mentor_mapping.resolve_claims(student_matches)

    rows: list[MappingRowOut] = []
    for line, (given, usn, who, spec), match in zip(lines, cells, student_matches):
        row = MappingRowOut(
            line_no=line.line_no, student=given, usn=usn, faculty=who, specialization=spec,
            verdict=V_BLANK, detail="",
        )
        rows.append(row)
        if not given and not usn:
            row.detail = "No student on this line."
            continue
        if not who:
            row.detail = "No faculty member on this line."
            continue

        # The student.
        person = match.person
        if person is None:
            if match.kind == mentor_mapping.MATCH_AMBIGUOUS:
                row.verdict = V_STUDENT_AMBIGUOUS
                row.candidates = _student_candidates(match.hits, roster)
                row.detail = (
                    f"{len(match.hits)} students match '{given}' — put the USN on this line."
                )
            else:
                row.verdict = V_STUDENT_NOT_FOUND
                row.detail = (
                    f"No student holds USN {usn}." if usn
                    else f"No student named '{given}' is on the roster."
                )
            continue
        seat = roster[person.id]
        row.student_id = seat.student_id
        row.student_name = seat.name
        row.student_usn = seat.usn
        row.batch = seat.batch
        row.current_faculty = seat.current_faculty

        # The faculty member: an address is exact, a name goes through the matcher.
        if "@" in who:
            hit = mentor_mapping.by_key(who, staff)
            staff_match = (
                mentor_mapping.Match(mentor_mapping.MATCH_EXACT, (hit,))
                if hit else mentor_mapping.Match(mentor_mapping.MATCH_NONE)
            )
        else:
            staff_match = mentor_mapping.match_name(who, staff)
        chosen = staff_match.person
        if chosen is None:
            if staff_match.kind == mentor_mapping.MATCH_AMBIGUOUS:
                row.verdict = V_FACULTY_AMBIGUOUS
                row.candidates = [
                    MappingCandidateOut(id=p.id, name=p.name, detail=faculty[p.id].email)
                    for p in staff_match.hits
                ]
                row.detail = (
                    f"{len(staff_match.hits)} faculty accounts match '{who}' — "
                    "write the email address instead."
                )
            else:
                row.verdict = V_FACULTY_NOT_FOUND
                row.detail = f"No faculty account matches '{who}'."
            continue
        member = faculty[chosen.id]
        row.faculty_user_id = member.user_id
        row.faculty_name = member.name
        if member.disabled:
            row.verdict = V_FACULTY_DISABLED
            row.detail = f"{member.name}'s account is disabled; enable it first."
            continue
        if member.mentor_id is not None and seat.mentor_id == member.mentor_id:
            row.verdict = V_UNCHANGED
            row.detail = f"Already assigned to {member.name}."
            continue
        row.verdict = V_ASSIGN
        row.detail = (
            f"Moves from {seat.current_faculty} to {member.name}."
            if seat.current_faculty else f"Will be assigned to {member.name}."
        )

    # Pass 3: one student on two lines. The same faculty member twice is a
    # harmless repeat; two different ones is a contradiction the file settles.
    # Only lines that RESOLVED both people can contradict each other; a line
    # whose faculty member was not found has already said so.
    seated = [row for row in rows if row.verdict in (V_ASSIGN, V_UNCHANGED)]
    twice = mentor_mapping.listed_twice([row.student_id for row in seated])
    for sid in twice:
        group = [row for row in seated if row.student_id == sid]
        named = {row.faculty_user_id for row in group}
        if len(named) == 1:
            for row in group[1:]:
                row.verdict = V_DUPLICATE
                row.detail = f"Also on line {group[0].line_no}; nothing more to do."
        else:
            others = ", ".join(str(row.line_no) for row in group)
            for row in group:
                row.verdict = V_LISTED_TWICE
                row.detail = (
                    f"{row.student_name} is on lines {others} with different faculty "
                    "members — keep one line."
                )

    # Pass 4: the two fences, on exactly the lines that would be written. The
    # single assignment raises; here the sentence goes on the line, so one
    # cross-college pair does not hide the other seventy-nine verdicts.
    for row in rows:
        if row.verdict != V_ASSIGN:
            continue
        try:
            require_capability(
                db, session, MAPPING_CAPABILITY, target=ancestry_of_student(db, row.student_id)
            )
            require_capability(
                db, session, MAPPING_CAPABILITY, target=ancestry_of_user(db, row.faculty_user_id)
            )
        except HTTPException as exc:
            row.verdict = V_OUT_OF_REACH
            row.detail = str(exc.detail)
            continue
        try:
            _assert_same_college(db, db.get(Student, row.student_id), row.faculty_user_id)
        except HTTPException as exc:
            row.verdict = V_DIFFERENT_COLLEGE
            row.detail = str(exc.detail)
    return rows


def _counts(rows: list[MappingRowOut]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        counts[row.verdict] = counts.get(row.verdict, 0) + 1
    return counts


@router.get("/mentor-mapping/template.xlsx")
def mentor_mapping_template(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> Response:
    """The blank workbook for a mentor list, built from `MAPPING_COLUMNS` —
    the same constant `preview` reads, so the file REEP hands out and the file
    it accepts cannot drift apart. No student data; behind the capability all
    the same, `admin_imports.template`'s reasoning."""
    require_capability(db, session, MAPPING_CAPABILITY)
    import openpyxl

    header = [name for name, _required in MAPPING_COLUMNS]
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.title = "Mentor mapping"
    sheet.append(header)
    sheet.append(list(MAPPING_EXAMPLE))
    sheet.append([])
    sheet.append([MAPPING_SHAPE])
    for name, required in MAPPING_COLUMNS:
        sheet.append([name, "required" if required else "optional — leave blank if you do not have it"])
    buffer = io.BytesIO()
    book.save(buffer)
    book.close()
    return Response(
        content=buffer.getvalue(),
        media_type=_XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": 'attachment; filename="reep-mentor-mapping-template.xlsx"'},
    )


@router.post("/mentor-mapping/preview", response_model=MappingPreviewOut)
def preview_mentor_mapping(
    file: UploadFile = File(...),
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> MappingPreviewOut:
    """Read a mentor list and say what Assign would do with every line.
    Writes nothing — not a run row, not a student record."""
    require_capability(db, session, MAPPING_CAPABILITY)
    payload, filename = _read_upload(file)
    rows = _judge_mapping(db, session, payload, filename)
    return MappingPreviewOut(
        filename=filename, rows=rows, counts=_counts(rows),
        to_assign=sum(1 for row in rows if row.verdict == V_ASSIGN),
    )


@router.post("/mentor-mapping/apply", response_model=MappingApplyOut)
def apply_mentor_mapping(
    request: Request,
    file: UploadFile = File(...),
    reason: str = Form(...),
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> MappingApplyOut:
    """Judge the file again and seat every line that reads `assign`.

    ONE TRANSACTION for the whole file, and the same write per line as
    `set_student_mentor`: the group through `ensure_mentor_group`, the spell
    through `record_mentor_change` (which flushes and never commits, so the
    pointer and its history land together), and an audit row per student with
    the previous mentor in `before`. The reason is REQUIRED, B9.2's rule for
    the single assignment — one sentence for the whole file, since that is the
    act the office performed, stamped on every student's own spell.
    """
    require_capability(db, session, MAPPING_CAPABILITY)
    reason = " ".join(reason.split())
    if not reason:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Say why these students are being assigned.",
        )
    if len(reason) > 400:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="The reason is longer than 400 characters.",
        )
    payload, filename = _read_upload(file)
    rows = _judge_mapping(db, session, payload, filename)
    groups: dict[str, str] = {}
    applied = 0
    for row in rows:
        if row.verdict != V_ASSIGN:
            continue
        student = db.get(Student, row.student_id)
        if student is None:
            row.verdict = V_STUDENT_NOT_FOUND
            row.detail = "This student left the roster while the file was being read."
            continue
        group_id = groups.get(row.faculty_user_id)
        if group_id is None:
            group_id = groups[row.faculty_user_id] = ensure_mentor_group(db, row.faculty_user_id)
        before = student.mentor_id
        student.mentor_id = group_id
        record_mentor_change(
            db,
            student_id=student.id,
            previous_mentor_id=before,
            new_mentor_id=group_id,
            by_user_id=session.get("userId"),
            reason=reason,
            session=session,
            request=request,
        )
        record_change(
            db, session=session, request=request, tenant_id=None,
            entity_type="student", entity_id=student.id, action="MENTOR_ASSIGNED",
            before={"mentor_id": before}, after={"mentor_id": group_id},
            event_type="student.mentor.assigned",
            payload={
                "student_id": student.id, "mentor_id": group_id, "released": False,
                "reason": reason, "source": "spreadsheet", "file": filename,
                "line": row.line_no,
            },
        )
        row.applied = True
        applied += 1
    db.commit()
    return MappingApplyOut(
        filename=filename, rows=rows, counts=_counts(rows),
        to_assign=sum(1 for row in rows if row.verdict == V_ASSIGN),
        applied=applied, reason=reason,
    )
