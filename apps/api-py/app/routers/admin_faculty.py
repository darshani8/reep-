"""Faculty accounts, created by the Main Admin on screen: POST /api/admin/faculty.

Until now a faculty login was minted only by `python -m app.grant_access` -
on a production host, the GitHub "Ops task" workflow - and its activation link
was read out of a run log. This is that same act on the Faculty & Students
screen: the Main Admin types a name and an address, the account is created,
and the ACTIVATION LINK is shown on screen to hand over (WhatsApp, in person),
because production cannot send mail yet and the on-screen link is permanent
by design (routers/admin.py::issue_activation_link).

ADMIN ONLY (`require_admin`): the owner's rule is that only the Main Admin
gives faculty their access, and an account is the first grant of all.

WHAT THE ACCOUNT IS. Role MENTOR; the unusable password sentinel, so nothing
signs in until the person redeems the link and sets their own password (or
Google, once configured); NO `Mentor` group - a faculty member becomes a
mentor when the Main Admin assigns them a student (routers/console.py). The
address is not fenced to the college domain, exactly like grant_access: the
roster row IS the access control, and the Main Admin minting it deliberately
is the check. An address already in `users` is refused - a MENTOR row must
never be attached to someone else's account.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import account_links
from ..architecture_events import record_change
from ..config import settings
from ..db import get_db
from ..identity import get_current_session
from ..models.user import Role, User
from ..staff_placement import UNFILED, StaffPlacement, placement_for, placements_for, resolve_department
from .mentor import require_admin
from .registration import SSO_ONLY_PASSWORD_HASH

router = APIRouter(prefix="/admin/faculty", tags=["admin-faculty"])


def _department_or_422(db: Session, department_id: str | None):
    """Resolve a named department, or refuse by name.

    A department id that does not exist must not fall through to "filed under
    nothing": that is a write which reports success and stores null, which is
    the exact class of bug this whole change exists to remove.
    """
    try:
        return resolve_department(db, department_id)
    except LookupError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"No department with id {department_id!r}.",
        ) from None


class AdminFacultyIn(BaseModel):
    name: str
    email: str
    designation: str | None = None
    #: Free text, kept because the official leave form prints this line and
    #: existing rows carry it. `department_id` below is the real pointer.
    department: str | None = None
    #: WHERE THIS PERSON WORKS, as a real department id. Optional so the Main
    #: Admin can mint a login now and file it later — the same reason
    #: `students.cohort_id` is nullable — but the screen asks for it, because an
    #: unfiled faculty member is invisible to every question that starts "who
    #: teaches in...".
    department_id: str | None = None

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, v: object) -> str:
        if not isinstance(v, str) or not v.strip():
            raise ValueError("name must not be blank")
        return " ".join(v.split())

    @field_validator("email", mode="before")
    @classmethod
    def _email(cls, v: object) -> str:
        e = str(v or "").strip().lower()
        if "@" not in e or e.startswith("@") or e.endswith("@"):
            raise ValueError("not an email address")
        return e

    @field_validator("designation", "department", mode="before")
    @classmethod
    def _blank_is_none(cls, v: object) -> str | None:
        if v is None:
            return None
        s = " ".join(str(v).split())
        return s[:120] or None


class StaffPlacementOut(BaseModel):
    """The resolved institutional position — read through the join, never stored.

    `filed` is what a client branches on. A falsy `department_name` cannot tell
    "nobody has filed this person" apart from "a department with a blank name",
    and those mean opposite things on a screen whose whole job is to show which
    faculty still need filing.
    """

    filed: bool = False
    department_id: str | None = None
    department_code: str | None = None
    department_name: str | None = None
    college_id: str | None = None
    college_code: str | None = None
    college_name: str | None = None

    @classmethod
    def of(cls, placement: StaffPlacement) -> "StaffPlacementOut":
        return cls(
            filed=placement.filed,
            department_id=placement.department_id,
            department_code=placement.department_code,
            department_name=placement.department_name,
            college_id=placement.college_id,
            college_code=placement.college_code,
            college_name=placement.college_name,
        )


class AdminFacultyOut(BaseModel):
    user_id: str
    name: str
    email: str
    designation: str | None
    department: str | None
    #: Resolved through `users.department_id`. See StaffPlacementOut.
    placement: StaffPlacementOut = StaffPlacementOut()
    #: Hand this over. It is the same link the Ops task prints; it expires.
    activation_link: str
    #: True only when a mail transport is configured and the link was sent.
    emailed: bool
    expires_in_hours: int


class AdminFacultyPatchIn(BaseModel):
    """Filing an EXISTING faculty member. Only what is sent is changed.

    This endpoint exists because the column arrived after the accounts did:
    without it, every faculty member created before this change is permanently
    unfiled and the only way to place them is a hand-written UPDATE.
    """

    designation: str | None = None
    department: str | None = None
    department_id: str | None = None

    @field_validator("designation", "department", mode="before")
    @classmethod
    def _blank_is_none(cls, v: object) -> str | None:
        if v is None:
            return None
        s = " ".join(str(v).split())
        return s[:120] or None


class AdminFacultyRowOut(BaseModel):
    """A faculty member as the console lists them. No activation link here —
    minting one is a deliberate act with its own endpoint, not a side effect of
    reading a list."""

    user_id: str
    name: str
    email: str
    designation: str | None
    department: str | None
    placement: StaffPlacementOut


@router.post("", response_model=AdminFacultyOut, status_code=status.HTTP_201_CREATED)
def create_faculty(
    body: AdminFacultyIn,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> AdminFacultyOut:
    require_admin(session)
    existing = db.scalar(select(User).where(func.lower(User.email) == body.email))
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{body.email} already belongs to a {existing.role.value} account.",
        )
    dep = _department_or_422(db, body.department_id)
    user = User(
        email=body.email,
        name=body.name,
        role=Role.MENTOR,
        password_hash=SSO_ONLY_PASSWORD_HASH,
        designation=body.designation,
        # The free-text line the leave form prints. When a real department was
        # chosen its NAME is what goes here, so the two can never disagree on
        # paper; a caller who names no department may still type the line.
        department=(dep.name if dep is not None else body.department),
        department_id=(dep.id if dep is not None else None),
    )
    db.add(user)
    db.flush()
    link, emailed = account_links.issue_activation(db, user, created_by_user_id=session.get("userId"))
    record_change(
        db, session=session, request=request, tenant_id=None,
        entity_type="faculty", entity_id=user.id, action="CREATE",
        before=None,
        after={"email": user.email, "name": user.name, "designation": user.designation, "department": user.department},
        event_type="faculty.create", payload={"email": user.email, "emailed": emailed},
    )
    db.commit()
    return AdminFacultyOut(
        user_id=user.id, name=user.name, email=user.email,
        designation=user.designation, department=user.department,
        placement=StaffPlacementOut.of(placement_for(db, user.id)),
        activation_link=link, emailed=emailed, expires_in_hours=settings.activation_link_hours,
    )


@router.get("", response_model=list[AdminFacultyRowOut])
def list_faculty(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[AdminFacultyRowOut]:
    """Every faculty account and where it is filed.

    UNFILED FIRST, then by name. The screen's job is to get everyone placed, and
    a list that buries the six unfiled accounts alphabetically among two hundred
    filed ones is a list nobody finishes.
    """
    require_admin(session)
    rows = db.execute(
        select(User.id, User.name, User.email, User.designation, User.department)
        .where(User.role == Role.MENTOR)
        .order_by(User.name)
    ).all()
    placements = placements_for(db, [r[0] for r in rows])
    out = [
        AdminFacultyRowOut(
            user_id=uid,
            name=name,
            email=email,
            designation=designation,
            department=department,
            placement=StaffPlacementOut.of(placements.get(uid, UNFILED)),
        )
        for uid, name, email, designation, department in rows
    ]
    out.sort(key=lambda r: (r.placement.filed, r.name.lower()))
    return out


@router.patch("/{user_id}", response_model=AdminFacultyRowOut)
def update_faculty(
    user_id: str,
    body: AdminFacultyPatchIn,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> AdminFacultyRowOut:
    """File an existing faculty member, or move them.

    ONLY FACULTY. A path id naming a student, an alumnus or the Main Admin is a
    404 rather than an edit: this endpoint writes `role`-adjacent institutional
    fields and must never become a way to reach another kind of account.
    """
    require_admin(session)
    user = db.get(User, user_id)
    if user is None or user.role is not Role.MENTOR:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Faculty member not found.")

    fields = body.model_dump(exclude_unset=True)
    before = {
        "designation": user.designation,
        "department": user.department,
        "department_id": user.department_id,
    }

    if "department_id" in fields:
        dep = _department_or_422(db, fields["department_id"])
        user.department_id = dep.id if dep is not None else None
        # Keep the printed line in step with the pointer, for the same reason
        # create does: the leave form prints `department`, and two sources of
        # truth for one line is how a paper form contradicts the console.
        if dep is not None:
            user.department = dep.name
    if "designation" in fields:
        user.designation = fields["designation"]
    # An explicit free-text department only wins when no real one was named in
    # the same request.
    if "department" in fields and not user.department_id:
        user.department = fields["department"]

    record_change(
        db, session=session, request=request, tenant_id=None,
        entity_type="faculty", entity_id=user.id, action="UPDATE",
        before=before,
        after={
            "designation": user.designation,
            "department": user.department,
            "department_id": user.department_id,
        },
        event_type="faculty.update", payload={"email": user.email},
    )
    db.commit()
    db.refresh(user)
    return AdminFacultyRowOut(
        user_id=user.id, name=user.name, email=user.email,
        designation=user.designation, department=user.department,
        placement=StaffPlacementOut.of(placement_for(db, user.id)),
    )
