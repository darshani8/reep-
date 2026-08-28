"""Fail-closed capability and student-scope policy for the v1 API."""

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models.redesign import MembershipRole, TenantMembership
from .models.user import Student

STAFF_ROLES = frozenset({"MENTOR", "DIRECTOR", "ADMIN"})
PROGRAMME_ROLES = frozenset({"DIRECTOR", "ADMIN"})
NOTEBOOK_ROLES = frozenset({"MENTOR", "DIRECTOR"})


def require_role(session: dict, *roles: str) -> dict:
    """Require an explicit role; missing or malformed identity is denied."""
    role = session.get("role")
    if not isinstance(role, str) or role not in roles:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role.")
    if not session.get("userId"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sign in required.")
    return session


def require_staff(session: dict) -> dict:
    return require_role(session, *sorted(STAFF_ROLES))


def require_programme_admin(session: dict) -> dict:
    return require_role(session, *sorted(PROGRAMME_ROLES))


def require_notebook_staff(session: dict) -> dict:
    """Allow notebook work to mentors/directors, never platform admins."""
    return require_role(session, *sorted(NOTEBOOK_ROLES))


def tenant_id_for_session(session: dict, db: Session) -> str | None:
    """Resolve one active tenant without invalidating legacy sessions.

    Old sessions have no tenant claim and some existing users have not yet been
    provisioned into the additive membership table. In that compatibility case
    this returns None, preserving the pre-tenant path. If memberships exist, a
    claimed or unambiguous tenant is required and verified on every request; an
    ambiguous multi-tenant identity fails closed rather than guessing.
    """
    user_id = session.get("userId")
    role = session.get("role")
    if not user_id or not isinstance(role, str):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sign in required.")
    try:
        membership_role = MembershipRole(role)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid tenant role.") from exc
    query = select(TenantMembership).where(
        TenantMembership.user_id == user_id,
        TenantMembership.role == membership_role,
        TenantMembership.status == "ACTIVE",
        TenantMembership.ended_at.is_(None),
    )
    memberships = db.scalars(query).all()
    claimed = session.get("tenantId")
    if claimed:
        if not any(row.tenant_id == claimed for row in memberships):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Tenant membership is not active.")
        return str(claimed)
    tenant_ids = {row.tenant_id for row in memberships}
    if len(tenant_ids) > 1:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Tenant context is required.")
    return next(iter(tenant_ids), None)


def assert_student_scope(session: dict, student_id: str, db: Session) -> Student:
    """Return a student only when the current role is allowed to access it."""
    require_staff(session)
    tenant_id = tenant_id_for_session(session, db)
    student = db.get(Student, student_id)
    if student is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")
    if tenant_id:
        student_membership = db.scalar(
            select(TenantMembership.id).where(
                TenantMembership.tenant_id == tenant_id,
                TenantMembership.user_id == student.user_id,
                TenantMembership.role == MembershipRole.STUDENT,
                TenantMembership.status == "ACTIVE",
                TenantMembership.ended_at.is_(None),
            )
        )
        if student_membership is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not in this tenant.")
    if session["role"] == "MENTOR" and (
        not session.get("mentorId") or student.mentor_id != session["mentorId"]
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not in your mentor scope.")
    return student


def student_identity(session: dict) -> str:
    """Derive the student id from the verified session, never from request JSON."""
    require_role(session, "STUDENT")
    student_id = session.get("studentId")
    if not student_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Student profile is not provisioned.")
    return str(student_id)
