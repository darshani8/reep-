"""The Main Admin's edits to students - one at a time, and a batch at a time.

    GET    /admin/students?cohort_id=&q=&unseated=   the roster, filtered
    PATCH  /admin/students/{id}                       name / email / USN / batch / faculty / stage / semester
    POST   /admin/cohorts/{id}/students/bulk          move / assign faculty / set stage / set semester - every student in the batch
    DELETE /admin/cohorts/{id}                        remove an EMPTY batch

NO CREATE AND NO DELETE (2026-09-10), and both absences are the design rather
than an omission. A student account is minted by exactly one path - the public
registration form, reviewed and APPROVED by the Main Admin, which provisions
the row and emails the applicant the setup link they need to prove their
mailbox and choose a password. An admin-side create was a second way onto the
roster with none of that; an admin-side delete erased a person's marks,
attendance, uploads, interviews and mentor notes behind a browser confirm
dialog, sitting among buttons that only move somebody between batches. What
remains here is EDITING a student who already exists, which is the day-to-day
work the screen is actually for. Emptying a deployment of people is
`python -m app.purge_people`, which is built for it.

GATED BY A CAPABILITY - `admin.students` - the Main Admin's by baseline and a
faculty member's only by grant. Everything here writes ROSTER rows, and the
roster IS the access control (an account with a `users` row signs in; nothing
else does), so the guards registration's provisioning applies are applied to
edits too, in admin wording: an address off the college domain is refused, and
an address that already belongs to a staff account is refused. NO PASSWORD is
ever set here: a student sets their own at the end of the onboarding walk
(routers/onboarding.py), or signs in with Google.

A BATCH ACTION IS THE SINGLE ACTION, REPEATED. `bulk` walks the batch's
students and applies exactly what the single endpoint applies, through the
same helpers, so "move a batch" and "move a student" cannot drift.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, aliased

from ..architecture_events import record_change
from ..config import settings
from ..db import get_db
from ..governance import require_capability
from ..identity import get_current_session
from ..models.cohort import Cohort
from ..models.institution import Department
from ..models.student_profile import StudentProfile
from ..models.user import Mentor, Role, Stage, Student, User
from ..student_placement import (
    DepartmentContradiction,
    department_of_cohort,
    resolve_student_department,
)
from .console import ensure_mentor_group
from .registration import SSO_ONLY_PASSWORD_HASH

router = APIRouter(prefix="/admin", tags=["admin-students"])

CAPABILITY = "admin.students"

STAGES: tuple[str, ...] = tuple(s.value for s in Stage)
MAX_SEMESTER = 8


# ------------------------------------------------------------- schemas --


class AdminStudentOut(BaseModel):
    student_id: str
    user_id: str
    name: str
    email: str
    usn: str | None
    cohort_id: str | None
    #: "MBA Batch 2024-26 - Section B · 2024-26", or null when unseated.
    batch: str | None
    #: The department NAME, resolved through the batch when the student is
    #: seated and through `students.department_id` when they are not — so an
    #: unseated student still reads as filed, which is the whole point of
    #: 31f7a4c60b12. Never stored on the student row; only the id below is.
    department: str | None
    department_id: str | None
    mentor_id: str | None
    #: The faculty member's USER id - what the console assigns by.
    mentor_user_id: str | None
    mentor_name: str | None
    current_stage: str
    current_semester: int
    enrolled_at: datetime
    last_login_at: datetime | None


def _clean_name(v: object) -> str:
    if not isinstance(v, str) or not v.strip():
        raise ValueError("name must not be blank")
    return " ".join(v.split())


def _clean_usn(v: object) -> str | None:
    if v is None:
        return None
    if not isinstance(v, str):
        raise ValueError("usn must be text")
    v = v.strip().upper()
    return v or None


def _clean_stage(v: object) -> str:
    key = str(v or "").strip().upper()
    if key not in STAGES:
        raise ValueError("current_stage must be one of " + ", ".join(STAGES))
    return key


class AdminStudentIn(BaseModel):
    name: str
    email: str
    usn: str | None = None
    cohort_id: str | None = None
    #: Where the student sits when no batch says so. Ignored in favour of the
    #: batch's own department whenever the batch has one, and a contradiction
    #: is a 422 — `student_placement.resolve_student_department` is the single
    #: writer, exactly as `_resolve_ancestry` is for a cohort's parents.
    department_id: str | None = None
    current_stage: str = Stage.REBOOT.value
    current_semester: int = Field(default=1, ge=1, le=MAX_SEMESTER)

    validate_name = field_validator("name", mode="before")(classmethod(lambda cls, v: _clean_name(v)))
    validate_usn = field_validator("usn", mode="before")(classmethod(lambda cls, v: _clean_usn(v)))
    validate_stage = field_validator("current_stage", mode="before")(classmethod(lambda cls, v: _clean_stage(v)))

    @field_validator("email", mode="before")
    @classmethod
    def _email(cls, v: object) -> str:
        e = str(v or "").strip().lower()
        if "@" not in e:
            raise ValueError("not an email address")
        return e


class AdminStudentPatch(BaseModel):
    """Every field optional; an explicit null on cohort_id / mentor_user_id
    is the un-seat / release action (model_fields_set tells the two apart)."""

    name: str | None = None
    email: str | None = None
    usn: str | None = None
    cohort_id: str | None = None
    #: An explicit null un-files the student from their department, the same way
    #: a null `cohort_id` un-seats them. Omitted entirely, it is left alone —
    #: except when the batch changes, which re-derives it.
    department_id: str | None = None
    mentor_user_id: str | None = None
    current_stage: str | None = None
    current_semester: int | None = Field(default=None, ge=1, le=MAX_SEMESTER)

    validate_name = field_validator("name", mode="before")(classmethod(lambda cls, v: None if v is None else _clean_name(v)))
    validate_usn = field_validator("usn", mode="before")(classmethod(lambda cls, v: _clean_usn(v)))
    validate_stage = field_validator("current_stage", mode="before")(classmethod(lambda cls, v: None if v is None else _clean_stage(v)))

    @field_validator("email", mode="before")
    @classmethod
    def _email(cls, v: object) -> str | None:
        if v is None:
            return None
        e = str(v).strip().lower()
        if "@" not in e:
            raise ValueError("not an email address")
        return e


BatchAction = Literal["move", "mentor", "stage", "semester"]


class BatchActionIn(BaseModel):
    action: BatchAction
    cohort_id: str | None = None  # move: the destination batch
    mentor_user_id: str | None = None  # mentor: the faculty account; null releases
    current_stage: str | None = None  # stage
    current_semester: int | None = Field(default=None, ge=1, le=MAX_SEMESTER)  # semester

    validate_stage = field_validator("current_stage", mode="before")(classmethod(lambda cls, v: None if v is None else _clean_stage(v)))


class BatchActionOut(BaseModel):
    action: BatchAction
    affected: int


# ------------------------------------------------------------- helpers --


def _domain_fence(email: str) -> None:
    """Registration's GUARD 1, in admin wording. The roster is the access
    control; a row minted here is a Google sign-in for that address."""
    domain = email.rpartition("@")[2]
    allowed = settings.provisionable_email_domains
    if not domain or domain not in allowed:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"{email} is not on a college domain ({', '.join(sorted(allowed))}). "
                "A student account is a sign-in, and only a college address gets one."
            ),
        )


def _snapshot(student: Student, user: User) -> dict:
    return {
        "name": user.name, "email": user.email, "usn": student.usn, "cohort_id": student.cohort_id,
        "mentor_id": student.mentor_id, "current_stage": student.current_stage.value,
        "current_semester": student.current_semester,
    }


def _audit(db: Session, session: dict, request: Request, entity_type: str, entity_id: str,
           action: str, before: dict | None, after: dict | None, payload: dict) -> None:
    record_change(
        db, session=session, request=request, tenant_id=None,
        entity_type=entity_type, entity_id=entity_id, action=action,
        before=before, after=after, event_type=f"{entity_type}.{action.lower()}", payload=payload,
    )


def _rows(db: Session, *where) -> list[AdminStudentOut]:
    faculty = aliased(User)
    # TWO ROUTES TO A DEPARTMENT, and the roster has to try both (31f7a4c60b12).
    # Joining only through `Cohort` printed a blank Department for every
    # unseated student — which, before batches exist, is every student — even
    # though registration had required them to name one. `own_dept` is the
    # student's own pointer; the batch's still wins where both resolve, which
    # is the same precedence `resolve_student_department` writes with.
    own_dept = aliased(Department)
    stmt = (
        select(
            Student, User, Cohort.name, Cohort.batch_label,
            Department.name, Department.id, own_dept.name, own_dept.id,
            Mentor.id, faculty.id, faculty.name,
        )
        .join(User, Student.user_id == User.id)
        .outerjoin(Cohort, Cohort.id == Student.cohort_id)
        .outerjoin(Department, Department.id == Cohort.department_id)
        .outerjoin(own_dept, own_dept.id == Student.department_id)
        .outerjoin(Mentor, Mentor.id == Student.mentor_id)
        .outerjoin(faculty, faculty.id == Mentor.user_id)
        .where(*where)
        .order_by(User.name, Student.usn)
    )
    out: list[AdminStudentOut] = []
    for (student, user, cohort_name, batch_label, dept_name, dept_id,
         own_name, own_id, mentor_id, f_id, f_name) in db.execute(stmt):
        out.append(AdminStudentOut(
            student_id=student.id, user_id=user.id, name=user.name, email=user.email, usn=student.usn,
            cohort_id=student.cohort_id,
            batch=f"{cohort_name} · {batch_label}" if cohort_name else None,
            department=dept_name or own_name,
            department_id=dept_id or own_id,
            mentor_id=mentor_id, mentor_user_id=f_id, mentor_name=f_name,
            current_stage=student.current_stage.value, current_semester=student.current_semester,
            enrolled_at=student.enrolled_at, last_login_at=user.last_login_at,
        ))
    return out


def _one(db: Session, student_id: str) -> AdminStudentOut:
    rows = _rows(db, Student.id == student_id)
    if not rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")
    return rows[0]


def _student_or_404(db: Session, student_id: str) -> tuple[Student, User]:
    student = db.get(Student, student_id)
    if student is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")
    return student, db.get(User, student.user_id)


def _cohort_or_404(db: Session, cohort_id: str) -> Cohort:
    cohort = db.get(Cohort, cohort_id)
    if cohort is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Batch not found.")
    return cohort


def _department_or_422(
    db: Session, *, cohort_id: str | None, department_id: str | None, sent: bool
) -> str | None:
    """The department to store, or a 422 that names what was wrong.

    The refusals are separate on purpose: "no such department" is a typo in one
    field, "contradicts the batch" is two fields disagreeing, and an admin fixes
    those two mistakes differently. A single "invalid department" would make
    them guess which.
    """
    try:
        return resolve_student_department(
            db, cohort_id=cohort_id, department_id=department_id, department_sent=sent
        )
    except LookupError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"No department with id {exc.args[0]!r}.",
        ) from exc
    except DepartmentContradiction as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"department_id {exc.sent!r} contradicts the batch you chose, which sits "
                f"under department {exc.derived!r}. Clear the batch first, or pick a batch "
                "in the department you want."
            ),
        ) from exc


# ----------------------------------------------------------------- list --


@router.get("/students", response_model=list[AdminStudentOut])
def list_students(
    cohort_id: str | None = None,
    q: str | None = None,
    unseated: bool = False,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[AdminStudentOut]:
    require_capability(db, session, CAPABILITY)
    where = []
    if unseated:
        where.append(Student.cohort_id.is_(None))
    elif cohort_id:
        where.append(Student.cohort_id == cohort_id)
    if q and q.strip():
        needle = f"%{q.strip().lower()}%"
        where.append(
            func.lower(User.name).like(needle)
            | func.lower(User.email).like(needle)
            | func.lower(func.coalesce(Student.usn, "")).like(needle)
        )
    return _rows(db, *where)


# ---------------------------------------------------------- NO create --
#
# There is no POST /admin/students, deliberately (2026-09-10). A student
# account comes into existence exactly one way: the public registration form,
# reviewed and APPROVED by the Main Admin, which provisions the row and emails
# the applicant their setup link. An admin-side create was a SECOND way in with
# none of that — no application to read, no reason recorded, no mailbox proof,
# and an account whose owner has never been told it exists. Two ways to mint a
# roster seat is one way too many when the roster IS the access control.
#
# The migration path for a student who genuinely cannot use the form is the
# form: someone submits it on their behalf and the admin approves it, which
# leaves the same audit trail as every other student.


# ----------------------------------------------------------------- edit --


@router.patch("/students/{student_id}", response_model=AdminStudentOut)
def update_student(
    student_id: str,
    body: AdminStudentPatch,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> AdminStudentOut:
    require_capability(db, session, CAPABILITY)
    student, user = _student_or_404(db, student_id)
    before = _snapshot(student, user)
    sent = body.model_fields_set

    if body.name is not None:
        user.name = body.name
    if body.email is not None and body.email != user.email:
        _domain_fence(body.email)
        taken = db.scalar(select(User.id).where(func.lower(User.email) == body.email, User.id != user.id))
        if taken is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{body.email} already belongs to another account.")
        user.email = body.email
        profile = db.scalar(select(StudentProfile).where(StudentProfile.student_id == student.id))
        if profile is not None:
            profile.email = body.email
    if "usn" in sent and body.usn != student.usn:
        if body.usn is not None:
            taken = db.scalar(select(Student.id).where(Student.usn == body.usn, Student.id != student.id))
            if taken is not None:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"USN {body.usn} already belongs to a student.")
        student.usn = body.usn
    # CAPTURED BEFORE THE BATCH MOVES. A row seated before 31f7a4c60b12 — or by
    # any writer that set only `cohort_id` — carries a NULL `department_id` and
    # shows its department THROUGH the batch. Reading the fallback after
    # `student.cohort_id` had been cleared found nothing on either pointer and
    # un-filed the student, so "leave this batch" silently became "leave this
    # department too". The effective department is whichever pointer answers now.
    previous_department = student.department_id or department_of_cohort(db, student.cohort_id)
    if "cohort_id" in sent:
        if body.cohort_id is not None:
            _cohort_or_404(db, body.cohort_id)
        student.cohort_id = body.cohort_id
    # Re-derived whenever EITHER pointer moves, not just when the client names a
    # department: moving a student into another batch must not leave them filed
    # under the old batch's department, and that is a write whose body never
    # mentions departments at all. Un-seating (cohort_id -> null) deliberately
    # KEEPS the department — losing the batch is not losing the faculty.
    if "cohort_id" in sent or "department_id" in sent:
        student.department_id = _department_or_422(
            db,
            cohort_id=student.cohort_id,
            department_id=body.department_id if "department_id" in sent else previous_department,
            sent="department_id" in sent,
        )
    if "mentor_user_id" in sent:
        student.mentor_id = ensure_mentor_group(db, body.mentor_user_id) if body.mentor_user_id else None
    if body.current_stage is not None:
        student.current_stage = Stage(body.current_stage)
    if body.current_semester is not None:
        student.current_semester = body.current_semester

    db.flush()
    _audit(db, session, request, "student", student.id, "UPDATE", before, _snapshot(student, user),
           {"user_id": user.id, "fields": sorted(sent)})
    db.commit()
    return _one(db, student.id)


# ---------------------------------------------------------- NO delete --
#
# There is no DELETE /admin/students/{id} and no bulk "delete" action
# (2026-09-10). Deleting a student erased their marks, attendance, uploads,
# interview record and mentor notes in one irreversible cascade, from a screen
# whose other buttons are all routine roster edits — and the only confirmation
# was a browser dialog. `_delete_student` went with them rather than being left
# callerless: a delete helper with no caller is the thing the next person wires
# a button to.
#
# Emptying a deployment of people is still possible and still has a tool:
# `python -m app.purge_people`, which dry-runs by default, demands
# --i-understand-this-is-permanent, and classifies all 93 tables. That is what
# a destructive act of this size should look like.


# ------------------------------------------------------- the batch level --


@router.post("/cohorts/{cohort_id}/students/bulk", response_model=BatchActionOut)
def batch_action(
    cohort_id: str,
    body: BatchActionIn,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> BatchActionOut:
    require_capability(db, session, CAPABILITY)
    cohort = _cohort_or_404(db, cohort_id)
    students = db.scalars(select(Student).where(Student.cohort_id == cohort.id)).all()

    if body.action == "move":
        if body.cohort_id is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="move needs cohort_id, the destination batch.")
        if body.cohort_id == cohort.id:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="That is the same batch.")
        _cohort_or_404(db, body.cohort_id)
        for s in students:
            s.cohort_id = body.cohort_id
            # The destination batch's department travels WITH the move. Setting
            # only `cohort_id` here would leave every moved student filed under
            # the department the old batch sat in — a row saying something its
            # own batch denies, which is the split brain the single-student
            # path refuses with a 422. `sent=False`: nobody typed a department,
            # so this derives rather than contradicts.
            s.department_id = _department_or_422(
                db, cohort_id=body.cohort_id, department_id=s.department_id, sent=False
            )
    elif body.action == "mentor":
        mentor_id = ensure_mentor_group(db, body.mentor_user_id) if body.mentor_user_id else None
        for s in students:
            s.mentor_id = mentor_id
    elif body.action == "stage":
        if body.current_stage is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="stage needs current_stage.")
        for s in students:
            s.current_stage = Stage(body.current_stage)
    elif body.action == "semester":
        if body.current_semester is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="semester needs current_semester.")
        for s in students:
            s.current_semester = body.current_semester
    db.flush()
    _audit(db, session, request, "cohort", cohort.id, f"STUDENTS_{body.action.upper()}", None, None,
           {"affected": len(students), "cohort_id": body.cohort_id, "mentor_user_id": body.mentor_user_id,
            "current_stage": body.current_stage, "current_semester": body.current_semester})
    db.commit()
    return BatchActionOut(action=body.action, affected=len(students))


class RosterBulkIn(BaseModel):
    """Named students, not a batch.

    Every other bulk action here is scoped to a cohort, which is the right shape
    for "do this to a batch" — and exactly the wrong shape for the students this
    endpoint exists for, who have NO batch. A college that has just started has
    a roster full of them, and filing thirty-five students one PATCH at a time
    is how a correct feature goes unused.

    IDS ARE EXPLICIT. There is no "everyone unseated" mode: the screen sends the
    rows the admin ticked, so a mis-click costs one student and never the
    roster. The cap is the same reason.
    """

    student_ids: list[str] = Field(min_length=1, max_length=500)
    action: Literal["department"]
    department_id: str | None = None


class RosterBulkOut(BaseModel):
    """Its own model rather than a widened `BatchAction`: that Literal is the
    vocabulary of the COHORT-scoped endpoint, and a member it cannot perform
    would be a lie in the schema every client reads."""

    action: Literal["department"]
    affected: int


@router.post("/students/bulk", response_model=RosterBulkOut)
def roster_bulk(
    body: RosterBulkIn,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> RosterBulkOut:
    """File named students under a department, whether or not they are seated."""
    require_capability(db, session, CAPABILITY)
    if body.department_id is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="department needs department_id, the department to file them under.",
        )
    students = db.scalars(select(Student).where(Student.id.in_(body.student_ids))).all()
    missing = set(body.student_ids) - {s.id for s in students}
    if missing:
        # Refuse the whole call rather than filing some and reporting a count
        # that silently does not match what the admin selected.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"{len(missing)} of those students no longer exist.",
        )
    for s in students:
        # Per student, because a seated one's batch still outranks the choice —
        # and says so with a 422 rather than being quietly skipped.
        s.department_id = _department_or_422(
            db, cohort_id=s.cohort_id, department_id=body.department_id, sent=True
        )
    db.flush()
    _audit(db, session, request, "roster", "students", "STUDENTS_DEPARTMENT", None, None,
           {"affected": len(students), "department_id": body.department_id})
    db.commit()
    return RosterBulkOut(action="department", affected=len(students))


@router.delete("/cohorts/{cohort_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_cohort(
    cohort_id: str,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> Response:
    """An EMPTY batch only. `students.cohort_id` has no cascade, on purpose: a
    batch with people in it is deleted by first saying what happens to the
    people - move them or delete them, above - never by implication."""
    require_capability(db, session, CAPABILITY)
    cohort = _cohort_or_404(db, cohort_id)
    seated = db.scalar(select(func.count()).select_from(Student).where(Student.cohort_id == cohort.id)) or 0
    if seated:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{seated} student{'s are' if seated != 1 else ' is'} seated in this batch. Move or delete them first.",
        )
    _audit(db, session, request, "cohort", cohort.id, "DELETE",
           {"code": cohort.code, "name": cohort.name, "batch_label": cohort.batch_label}, None, {})
    db.delete(cohort)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
