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
mentor when the Main Admin assigns them a student (routers/director.py). The
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
from .mentor import require_admin
from .registration import SSO_ONLY_PASSWORD_HASH

router = APIRouter(prefix="/admin/faculty", tags=["admin-faculty"])


class AdminFacultyIn(BaseModel):
    name: str
    email: str
    designation: str | None = None
    department: str | None = None

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


class AdminFacultyOut(BaseModel):
    user_id: str
    name: str
    email: str
    designation: str | None
    department: str | None
    #: Hand this over. It is the same link the Ops task prints; it expires.
    activation_link: str
    #: True only when a mail transport is configured and the link was sent.
    emailed: bool
    expires_in_hours: int


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
    user = User(
        email=body.email,
        name=body.name,
        role=Role.MENTOR,
        password_hash=SSO_ONLY_PASSWORD_HASH,
        designation=body.designation,
        department=body.department,
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
        activation_link=link, emailed=emailed, expires_in_hours=settings.activation_link_hours,
    )
