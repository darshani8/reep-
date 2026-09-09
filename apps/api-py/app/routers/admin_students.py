"""The Main Admin's CRUD over students - one at a time, and a batch at a time.

    GET    /admin/students?cohort_id=&q=&unseated=   the roster, filtered
    POST   /admin/students                            create one (User + Student + profile)
    PATCH  /admin/students/{id}                       name / email / USN / batch / faculty / stage / semester
    DELETE /admin/students/{id}                       remove one, and everything that hangs off them
    POST   /admin/cohorts/{id}/students/bulk          move / assign faculty / set stage / set semester / delete - every student in the batch
    DELETE /admin/cohorts/{id}                        remove an EMPTY batch

GATED BY A CAPABILITY - `admin.students` - the Main Admin's by baseline and a
faculty member's only by grant. Everything here writes ROSTER rows, and the
roster IS the access control (an account with a `users` row signs in;
nothing else does), so the three guards registration's provisioning applies
are applied here too, in admin wording: an address off the college domain is
refused, an address that already belongs to a staff account is refused, and
a second Student for one account is refused. NO PASSWORD is ever set: a
student signs in with Google, exactly as an approved applicant does.

DELETE IS REAL AND IT IS WIDE. Every student table hangs off `students.id`
with ON DELETE CASCADE, and every user table off `users.id` the same way or
with SET NULL - except `login_days`, which is cleared here by hand. The
before-snapshot goes on the audit trail first, so the row that no longer
exists can still be read in the trail. Core deletes, not ORM ones: the ORM's
`User.student` relationship has no cascade configured and would try to
orphan the Student row rather than let the database drop it.

A BATCH ACTION IS THE SINGLE ACTION, REPEATED. `bulk` walks the batch's
students and applies exactly what the single endpoints apply, through the
same helpers, so "move a batch" and "move a student" cannot drift; and each
deleted student still gets their own audit event, because a batch delete is
not one fact but N.
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
from ..models.user import LoginDay, Mentor, Role, Stage, Student, User
from .director import ensure_mentor_group
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
    department: str | None
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


BatchAction = Literal["move", "mentor", "stage", "semester", "delete"]


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
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
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
    stmt = (
        select(Student, User, Cohort.name, Cohort.batch_label, Department.name, Mentor.id, faculty.id, faculty.name)
        .join(User, Student.user_id == User.id)
        .outerjoin(Cohort, Cohort.id == Student.cohort_id)
        .outerjoin(Department, Department.id == Cohort.department_id)
        .outerjoin(Mentor, Mentor.id == Student.mentor_id)
        .outerjoin(faculty, faculty.id == Mentor.user_id)
        .where(*where)
        .order_by(User.name, Student.usn)
    )
    out: list[AdminStudentOut] = []
    for student, user, cohort_name, batch_label, dept_name, mentor_id, f_id, f_name in db.execute(stmt):
        out.append(AdminStudentOut(
            student_id=student.id, user_id=user.id, name=user.name, email=user.email, usn=student.usn,
            cohort_id=student.cohort_id,
            batch=f"{cohort_name} · {batch_label}" if cohort_name else None,
            department=dept_name,
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


def _delete_student(db: Session, session: dict, request: Request, student: Student, user: User) -> None:
    """The one delete. Audit first, then the rows: login_days by hand (its FK
    has no cascade), then the Student (every student table cascades), then
    the User (every user table cascades or nulls)."""
    _audit(db, session, request, "student", student.id, "DELETE", _snapshot(student, user), None,
           {"user_id": user.id, "email": user.email})
    db.execute(delete(LoginDay).where(LoginDay.user_id == user.id))
    db.execute(delete(Student).where(Student.id == student.id))
    db.execute(delete(User).where(User.id == user.id))


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


# --------------------------------------------------------------- create --


@router.post("/students", response_model=AdminStudentOut, status_code=status.HTTP_201_CREATED)
def create_student(
    body: AdminStudentIn,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> AdminStudentOut:
    require_capability(db, session, CAPABILITY)
    _domain_fence(body.email)
    if body.cohort_id is not None:
        _cohort_or_404(db, body.cohort_id)
    existing = db.scalar(select(User).where(func.lower(User.email) == body.email))
    if existing is not None:
        if existing.role is not Role.STUDENT:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"{body.email} already belongs to a {existing.role.value} account.",
            )
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{body.email} is already a student.")
    if body.usn and db.scalar(select(Student.id).where(Student.usn == body.usn)) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"USN {body.usn} already belongs to a student.")

    user = User(email=body.email, name=body.name, role=Role.STUDENT, password_hash=SSO_ONLY_PASSWORD_HASH)
    db.add(user)
    db.flush()
    student = Student(
        user_id=user.id, usn=body.usn, cohort_id=body.cohort_id,
        current_stage=Stage(body.current_stage), current_semester=body.current_semester,
    )
    db.add(student)
    db.flush()
    # The profile row, so the student's first sign-in answers 200 rather than
    # 404 - the same reason registration's provisioning adds one.
    db.add(StudentProfile(student_id=student.id, email=body.email))
    db.flush()
    _audit(db, session, request, "student", student.id, "CREATE", None, _snapshot(student, user),
           {"user_id": user.id, "email": user.email})
    db.commit()
    return _one(db, student.id)


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
    if "cohort_id" in sent:
        if body.cohort_id is not None:
            _cohort_or_404(db, body.cohort_id)
        student.cohort_id = body.cohort_id
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


# --------------------------------------------------------------- delete --


@router.delete("/students/{student_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_student(
    student_id: str,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> Response:
    require_capability(db, session, CAPABILITY)
    student, user = _student_or_404(db, student_id)
    _delete_student(db, session, request, student, user)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="move needs cohort_id, the destination batch.")
        if body.cohort_id == cohort.id:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="That is the same batch.")
        _cohort_or_404(db, body.cohort_id)
        for s in students:
            s.cohort_id = body.cohort_id
    elif body.action == "mentor":
        mentor_id = ensure_mentor_group(db, body.mentor_user_id) if body.mentor_user_id else None
        for s in students:
            s.mentor_id = mentor_id
    elif body.action == "stage":
        if body.current_stage is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="stage needs current_stage.")
        for s in students:
            s.current_stage = Stage(body.current_stage)
    elif body.action == "semester":
        if body.current_semester is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="semester needs current_semester.")
        for s in students:
            s.current_semester = body.current_semester
    elif body.action == "delete":
        for s in students:
            _delete_student(db, session, request, s, db.get(User, s.user_id))

    db.flush()
    _audit(db, session, request, "cohort", cohort.id, f"STUDENTS_{body.action.upper()}", None, None,
           {"affected": len(students), "cohort_id": body.cohort_id, "mentor_user_id": body.mentor_user_id,
            "current_stage": body.current_stage, "current_semester": body.current_semester})
    db.commit()
    return BatchActionOut(action=body.action, affected=len(students))


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
