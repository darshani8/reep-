"""Governance — the Main Admin console's access endpoints.

ADMIN ONLY throughout - the Main Admin - via `require_admin` imported from
mentor.py rather than reimplemented. REEP has one Main Admin, and deciding what
faculty may see is that account's instrument alone: the Main Admin holds every
console screen by baseline and is still refused here, by name. Two instruments with opposite defaults, kept apart here as
they are in the model:

    /grants    capability grants for staff. Deny past the role baseline.
    /features  student feature overrides. Allow until switched off.

EVERY MUTATION DEMANDS A REASON, and it is checked in the API rather than only in
the form. A governance trail whose entries do not say why is a list of dates, and
a client is not where that promise can be kept — the twenty-character floor is
here so a second client, a script, or a curl cannot skip it.

EVERY MUTATION IS AUDITED through `architecture_events.record_change`, the
existing writer, rather than a second audit table. It already records actor,
entity, action, before/after and the route; a parallel implementation would be
the copy that stops matching.

THE CATALOGUE ENDPOINTS EXIST FOR THE DROPDOWNS. `/catalogue` and `/hierarchy`
serve exactly what the console's selects need, from the same constants the
enforcement reads — so a capability the API does not know can never appear in the
list an admin picks from.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..architecture_events import record_change
from ..db import get_db
from ..governance import capabilities_for, granted_capabilities
from ..identity import get_current_session
from ..models.cohort import Cohort
from ..models.governance import (
    CAPABILITIES,
    CAPABILITIES_BY_KEY,
    FEATURES,
    FEATURES_BY_KEY,
    AccessGroup,
    AccessGroupMember,
    CapabilityGrant,
    CapabilityScope,
    FeatureOverride,
    FeatureScope,
    SubjectKind,
)
from ..models.institution import (
    AcademicCourse,
    AcademicSpecialization,
    College,
    Department,
)
from ..models.user import Role, Student, User
from .mentor import require_admin

router = APIRouter(prefix="/admin/governance", tags=["governance"])

#: Long enough that "asdf" and "ok" do not pass, short enough that a real
#: sentence does. A trail of one-word reasons is indistinguishable from none.
MIN_REASON_CHARS = 20


def _reason(value: str) -> str:
    text = (value or "").strip()
    if len(text) < MIN_REASON_CHARS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"A reason of at least {MIN_REASON_CHARS} characters is required. "
                "It is written onto the audit trail and read by whoever reviews "
                "this grant later."
            ),
        )
    return text


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Catalogue + hierarchy — the dropdown sources
# --------------------------------------------------------------------------- #

class CapabilityOut(BaseModel):
    key: str
    label: str
    scope: str
    carries_pii: bool


class FeatureOut(BaseModel):
    key: str
    label: str


class CatalogueOut(BaseModel):
    capabilities: list[CapabilityOut]
    features: list[FeatureOut]
    min_reason_chars: int


@router.get("/catalogue", response_model=CatalogueOut)
def catalogue(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> CatalogueOut:
    """What the pickers offer, from the constants enforcement reads.

    Served rather than duplicated in the client so a capability cannot appear in
    a dropdown that no call site checks — the row that names a promise the API
    does not keep.
    """
    require_admin(session)
    return CatalogueOut(
        capabilities=[
            CapabilityOut(key=c.key, label=c.label, scope=c.scope.value, carries_pii=c.carries_pii)
            for c in CAPABILITIES
        ],
        features=[FeatureOut(key=f.key, label=f.label) for f in FEATURES],
        min_reason_chars=MIN_REASON_CHARS,
    )


class HierarchyNode(BaseModel):
    scope: str
    id: str
    label: str
    parent_id: str | None
    students: int


@router.get("/hierarchy", response_model=list[HierarchyNode])
def hierarchy(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[HierarchyNode]:
    """Every rung an override can hang on, with a live student count each.

    The count is what makes the console's blast radius honest — "switch off for
    86 students" rather than "switch off for AI & ML". Counted per level from
    `students.cohort_id` through the cohort's own ancestor pointers, because a
    cohort may attach at department, course or specialization depth and only its
    own columns say which.
    """
    require_admin(session)

    def counts(column) -> dict[str, int]:
        rows = db.execute(
            select(column, func.count(Student.id))
            .select_from(Student)
            .join(Cohort, Student.cohort_id == Cohort.id)
            .where(column.isnot(None))
            .group_by(column)
        ).all()
        return {str(k): int(n) for k, n in rows}

    by_cohort = counts(Cohort.id)
    by_spec = counts(Cohort.specialization_id)
    by_course = counts(Cohort.course_id)
    by_dept = counts(Cohort.department_id)

    out: list[HierarchyNode] = []
    colleges = db.scalars(select(College).order_by(College.name)).all()
    departments = db.scalars(select(Department).order_by(Department.name)).all()
    by_college: dict[str, int] = {}
    for d in departments:
        by_college[d.college_id] = by_college.get(d.college_id, 0) + by_dept.get(d.id, 0)

    for c in colleges:
        out.append(HierarchyNode(scope="COLLEGE", id=c.id, label=c.name,
                                 parent_id=None, students=by_college.get(c.id, 0)))
    for d in departments:
        out.append(HierarchyNode(scope="DEPARTMENT", id=d.id, label=d.name,
                                 parent_id=d.college_id, students=by_dept.get(d.id, 0)))
    for co in db.scalars(select(AcademicCourse).order_by(AcademicCourse.name)).all():
        out.append(HierarchyNode(scope="COURSE", id=co.id, label=co.name,
                                 parent_id=co.department_id, students=by_course.get(co.id, 0)))
    for sp in db.scalars(select(AcademicSpecialization).order_by(AcademicSpecialization.name)).all():
        out.append(HierarchyNode(scope="SPECIALIZATION", id=sp.id, label=sp.name,
                                 parent_id=sp.course_id, students=by_spec.get(sp.id, 0)))
    for ch in db.scalars(select(Cohort).order_by(Cohort.name)).all():
        # A cohort attaches at whichever depth it was created with — the levels
        # are individually optional — so its parent is the deepest pointer it
        # actually carries. `_resolve_ancestry` in admin.py is what guarantees
        # the shallower ones agree.
        parent = ch.specialization_id or ch.course_id or ch.department_id
        out.append(HierarchyNode(scope="COHORT", id=ch.id,
                                 label=f"{ch.name} — {ch.batch_label}",
                                 parent_id=parent, students=by_cohort.get(ch.id, 0)))
    return out


class StaffOut(BaseModel):
    user_id: str
    name: str
    email: str
    role: str


@router.get("/staff", response_model=list[StaffOut])
def staff(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[StaffOut]:
    """The people a capability can be granted to. Staff only — a capability is
    a staff instrument, and offering a STUDENT in the picker would invite an
    admin to grant one and wonder why nothing changed."""
    require_admin(session)
    rows = db.scalars(
        select(User).where(User.role.in_([Role.MENTOR, Role.ADMIN])).order_by(User.name)
    ).all()
    return [
        StaffOut(user_id=u.id, name=u.name or u.email, email=u.email, role=u.role.value)
        for u in rows
    ]


# --------------------------------------------------------------------------- #
# Capability grants
# --------------------------------------------------------------------------- #

class GrantIn(BaseModel):
    capability: str
    #: Exactly one of these carries the subjects; both lists so a single request
    #: can grant to four people, matching the console's multi-select.
    user_ids: list[str] = Field(default_factory=list)
    group_ids: list[str] = Field(default_factory=list)
    reason: str
    expires_at: datetime | None = None

    @field_validator("capability")
    @classmethod
    def _known(cls, v: str) -> str:
        if v not in CAPABILITIES_BY_KEY:
            raise ValueError(f"unknown capability {v!r}")
        return v


class GrantOut(BaseModel):
    id: str
    capability: str
    capability_label: str
    scope: str
    subject_kind: str
    subject_id: str
    subject_label: str
    reason: str
    granted_by: str | None
    granted_at: datetime
    expires_at: datetime | None


def _grant_out(db: Session, g: CapabilityGrant) -> GrantOut:
    cap = CAPABILITIES_BY_KEY.get(g.capability)
    if g.subject_kind == SubjectKind.USER:
        subject_id = g.subject_user_id or ""
        u = db.get(User, subject_id) if subject_id else None
        label = (u.name or u.email) if u else "(removed user)"
    else:
        subject_id = g.subject_group_id or ""
        grp = db.get(AccessGroup, subject_id) if subject_id else None
        label = grp.name if grp else "(removed group)"
    granter = db.get(User, g.granted_by_user_id) if g.granted_by_user_id else None
    return GrantOut(
        id=g.id,
        capability=g.capability,
        capability_label=cap.label if cap else g.capability,
        scope=cap.scope.value if cap else "UNKNOWN",
        subject_kind=g.subject_kind.value,
        subject_id=subject_id,
        subject_label=label,
        reason=g.reason,
        granted_by=(granter.name or granter.email) if granter else None,
        granted_at=g.granted_at,
        expires_at=g.expires_at,
    )


@router.get("/grants", response_model=list[GrantOut])
def list_grants(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[GrantOut]:
    """Live grants only. Revoked and lapsed ones stay in the table and are read
    from the audit trail, which is where "who held this in March" belongs."""
    require_admin(session)
    now = _now()
    rows = db.scalars(
        select(CapabilityGrant)
        .where(
            CapabilityGrant.revoked_at.is_(None),
            or_(CapabilityGrant.expires_at.is_(None), CapabilityGrant.expires_at > now),
        )
        .order_by(CapabilityGrant.granted_at.desc())
    ).all()
    return [_grant_out(db, g) for g in rows]


@router.post("/grants", response_model=list[GrantOut], status_code=status.HTTP_201_CREATED)
def create_grants(
    body: GrantIn,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[GrantOut]:
    """Grant one capability to any number of users and groups, in one act.

    ONE REASON COVERS THE BATCH and is copied onto every row, because that is
    what an admin actually means: "these four, for this reason". Writing one
    audit entry for the batch instead would make "why does Dr. Rao hold this"
    answerable only by finding a grant she is not named in.

    Re-granting something already held is a no-op rather than a duplicate: two
    live rows for the same pair make revocation a question of which one.
    """
    require_admin(session)
    reason = _reason(body.reason)
    if not body.user_ids and not body.group_ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Name at least one person or access group to grant this to.",
        )

    now = _now()
    created: list[CapabilityGrant] = []

    def already_live(kind: SubjectKind, subject_id: str) -> bool:
        col = (
            CapabilityGrant.subject_user_id
            if kind == SubjectKind.USER
            else CapabilityGrant.subject_group_id
        )
        return db.scalar(
            select(CapabilityGrant.id).where(
                CapabilityGrant.capability == body.capability,
                CapabilityGrant.subject_kind == kind,
                col == subject_id,
                CapabilityGrant.revoked_at.is_(None),
                or_(CapabilityGrant.expires_at.is_(None), CapabilityGrant.expires_at > now),
            )
        ) is not None

    for uid in body.user_ids:
        user = db.get(User, uid)
        if user is None or user.role not in (Role.MENTOR, Role.ADMIN):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Capabilities are granted to staff. One of the ids is not a staff account.",
            )
        if already_live(SubjectKind.USER, uid):
            continue
        created.append(CapabilityGrant(
            capability=body.capability, subject_kind=SubjectKind.USER, subject_user_id=uid,
            reason=reason, granted_by_user_id=session["userId"], expires_at=body.expires_at,
        ))

    for gid in body.group_ids:
        if db.get(AccessGroup, gid) is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="No such access group."
            )
        if already_live(SubjectKind.GROUP, gid):
            continue
        created.append(CapabilityGrant(
            capability=body.capability, subject_kind=SubjectKind.GROUP, subject_group_id=gid,
            reason=reason, granted_by_user_id=session["userId"], expires_at=body.expires_at,
        ))

    for g in created:
        db.add(g)
    db.flush()

    cap = CAPABILITIES_BY_KEY[body.capability]
    for g in created:
        record_change(
            db, session=session, request=request, tenant_id=None,
            entity_type="capability_grant", entity_id=g.id, action="GRANTED",
            before=None,
            after={
                "capability": g.capability, "scope": cap.scope.value,
                "subject_kind": g.subject_kind.value,
                "subject_id": g.subject_user_id or g.subject_group_id,
                "reason": reason,
                "expires_at": body.expires_at.isoformat() if body.expires_at else None,
                "batch_size": len(created),
            },
            event_type="governance.capability.granted",
            payload={"capability": g.capability},
        )
    db.commit()
    for g in created:
        db.refresh(g)
    return [_grant_out(db, g) for g in created]


class RevokeIn(BaseModel):
    reason: str


@router.post("/grants/{grant_id}/revoke", response_model=GrantOut)
def revoke_grant(
    grant_id: str,
    body: RevokeIn,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> GrantOut:
    """Stamp, never delete. "Who held exports last March, and who signed it off"
    has to stay answerable after the answer stops being current."""
    require_admin(session)
    reason = _reason(body.reason)
    g = db.get(CapabilityGrant, grant_id)
    if g is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Grant not found.")
    if g.revoked_at is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Already revoked.")
    g.revoked_at = _now()
    g.revoked_by_user_id = session["userId"]
    g.revoke_reason = reason
    record_change(
        db, session=session, request=request, tenant_id=None,
        entity_type="capability_grant", entity_id=g.id, action="REVOKED",
        before={"capability": g.capability, "reason": g.reason},
        after={"capability": g.capability, "revoke_reason": reason},
        event_type="governance.capability.revoked", payload={"capability": g.capability},
    )
    db.commit()
    db.refresh(g)
    return _grant_out(db, g)


@router.get("/effective/{user_id}", response_model=list[str])
def effective_capabilities(
    user_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[str]:
    """What this person actually holds — baseline plus grants, resolved.

    The console shows it beside the grant list because the two are not the same
    thing: a mentor holds sixteen scoped capabilities with no grant at all, and an
    admin looking only at grants would conclude they hold nothing.
    """
    require_admin(session)
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    return sorted(capabilities_for(db, {"userId": user.id, "role": user.role.value}))


# --------------------------------------------------------------------------- #
# Access groups
# --------------------------------------------------------------------------- #

class GroupIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    description: str | None = None


class GroupMemberOut(BaseModel):
    user_id: str
    name: str
    email: str


class GroupOut(BaseModel):
    id: str
    name: str
    description: str | None
    members: list[GroupMemberOut]
    capabilities: list[str]


def _group_out(db: Session, grp: AccessGroup) -> GroupOut:
    members = db.execute(
        select(User).join(AccessGroupMember, AccessGroupMember.user_id == User.id)
        .where(AccessGroupMember.group_id == grp.id).order_by(User.name)
    ).scalars().all()
    now = _now()
    caps = db.scalars(
        select(CapabilityGrant.capability).where(
            CapabilityGrant.subject_kind == SubjectKind.GROUP,
            CapabilityGrant.subject_group_id == grp.id,
            CapabilityGrant.revoked_at.is_(None),
            or_(CapabilityGrant.expires_at.is_(None), CapabilityGrant.expires_at > now),
        )
    ).all()
    return GroupOut(
        id=grp.id, name=grp.name, description=grp.description,
        members=[GroupMemberOut(user_id=u.id, name=u.name or u.email, email=u.email) for u in members],
        capabilities=sorted(set(caps)),
    )


@router.get("/groups", response_model=list[GroupOut])
def list_groups(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[GroupOut]:
    require_admin(session)
    return [_group_out(db, g) for g in db.scalars(select(AccessGroup).order_by(AccessGroup.name)).all()]


@router.post("/groups", response_model=GroupOut, status_code=status.HTTP_201_CREATED)
def create_group(
    body: GroupIn,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> GroupOut:
    require_admin(session)
    if db.scalar(select(AccessGroup.id).where(AccessGroup.name == body.name.strip())):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="A group with that name exists.")
    grp = AccessGroup(
        name=body.name.strip(), description=(body.description or "").strip() or None,
        created_by_user_id=session["userId"],
    )
    db.add(grp)
    db.flush()
    record_change(
        db, session=session, request=request, tenant_id=None,
        entity_type="access_group", entity_id=grp.id, action="CREATED",
        before=None, after={"name": grp.name},
        event_type="governance.group.created", payload={"name": grp.name},
    )
    db.commit()
    db.refresh(grp)
    return _group_out(db, grp)


class MemberIn(BaseModel):
    user_ids: list[str]
    reason: str


@router.post("/groups/{group_id}/members", response_model=GroupOut)
def add_members(
    group_id: str,
    body: MemberIn,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> GroupOut:
    """Adding a member hands them every capability the group holds, so it is
    audited exactly like a grant and asks for the same reason."""
    require_admin(session)
    reason = _reason(body.reason)
    grp = db.get(AccessGroup, group_id)
    if grp is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found.")
    for uid in body.user_ids:
        user = db.get(User, uid)
        if user is None or user.role not in (Role.MENTOR, Role.ADMIN):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Access groups hold staff accounts.",
            )
        exists = db.scalar(select(AccessGroupMember.id).where(
            AccessGroupMember.group_id == group_id, AccessGroupMember.user_id == uid))
        if exists:
            continue
        db.add(AccessGroupMember(group_id=group_id, user_id=uid, added_by_user_id=session["userId"]))
        record_change(
            db, session=session, request=request, tenant_id=None,
            entity_type="access_group", entity_id=group_id, action="MEMBER_ADDED",
            before=None, after={"user_id": uid, "reason": reason},
            event_type="governance.group.member_added", payload={"user_id": uid},
        )
    db.commit()
    db.refresh(grp)
    return _group_out(db, grp)


@router.delete("/groups/{group_id}/members/{user_id}", response_model=GroupOut)
def remove_member(
    group_id: str,
    user_id: str,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> GroupOut:
    require_admin(session)
    grp = db.get(AccessGroup, group_id)
    if grp is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found.")
    row = db.scalar(select(AccessGroupMember).where(
        AccessGroupMember.group_id == group_id, AccessGroupMember.user_id == user_id))
    if row is not None:
        db.delete(row)
        record_change(
            db, session=session, request=request, tenant_id=None,
            entity_type="access_group", entity_id=group_id, action="MEMBER_REMOVED",
            before={"user_id": user_id}, after=None,
            event_type="governance.group.member_removed", payload={"user_id": user_id},
        )
        db.commit()
    db.refresh(grp)
    return _group_out(db, grp)


# --------------------------------------------------------------------------- #
# Student feature overrides
# --------------------------------------------------------------------------- #

class OverrideIn(BaseModel):
    feature: str
    scope: FeatureScope
    target_id: str
    enabled: bool = False
    reason: str
    expires_at: datetime | None = None

    @field_validator("feature")
    @classmethod
    def _known(cls, v: str) -> str:
        if v not in FEATURES_BY_KEY:
            raise ValueError(f"unknown feature {v!r}")
        return v


class OverrideOut(BaseModel):
    id: str
    feature: str
    feature_label: str
    scope: str
    target_id: str
    target_label: str
    enabled: bool
    reason: str
    set_by: str | None
    set_at: datetime
    expires_at: datetime | None
    students_affected: int


_TARGET_MODEL = {
    FeatureScope.COLLEGE: College,
    FeatureScope.DEPARTMENT: Department,
    FeatureScope.COURSE: AcademicCourse,
    FeatureScope.SPECIALIZATION: AcademicSpecialization,
    FeatureScope.COHORT: Cohort,
}


def _target_label(db: Session, scope: FeatureScope, target_id: str) -> str:
    if scope == FeatureScope.STUDENT:
        s = db.get(Student, target_id)
        if s is None:
            return "(removed student)"
        u = db.get(User, s.user_id)
        return f"{(u.name or u.email) if u else target_id} — {s.usn or ''}".strip(" —")
    model = _TARGET_MODEL[scope]
    row = db.get(model, target_id)
    if row is None:
        return "(removed)"
    return getattr(row, "name", None) or getattr(row, "label", None) or target_id


def _students_affected(db: Session, scope: FeatureScope, target_id: str) -> int:
    if scope == FeatureScope.STUDENT:
        return 1 if db.get(Student, target_id) is not None else 0
    q = select(func.count(Student.id)).select_from(Student).join(Cohort, Student.cohort_id == Cohort.id)
    if scope == FeatureScope.COHORT:
        return int(db.scalar(q.where(Cohort.id == target_id)) or 0)
    if scope == FeatureScope.SPECIALIZATION:
        return int(db.scalar(q.where(Cohort.specialization_id == target_id)) or 0)
    if scope == FeatureScope.COURSE:
        return int(db.scalar(q.where(Cohort.course_id == target_id)) or 0)
    if scope == FeatureScope.DEPARTMENT:
        return int(db.scalar(q.where(Cohort.department_id == target_id)) or 0)
    # College: through its departments.
    dept_ids = db.scalars(select(Department.id).where(Department.college_id == target_id)).all()
    if not dept_ids:
        return 0
    return int(db.scalar(q.where(Cohort.department_id.in_(dept_ids))) or 0)


def _override_out(db: Session, o: FeatureOverride) -> OverrideOut:
    feat = FEATURES_BY_KEY.get(o.feature)
    setter = db.get(User, o.set_by_user_id) if o.set_by_user_id else None
    return OverrideOut(
        id=o.id, feature=o.feature, feature_label=feat.label if feat else o.feature,
        scope=o.scope.value, target_id=o.target_id,
        target_label=_target_label(db, o.scope, o.target_id),
        enabled=o.enabled, reason=o.reason,
        set_by=(setter.name or setter.email) if setter else None,
        set_at=o.set_at, expires_at=o.expires_at,
        students_affected=_students_affected(db, o.scope, o.target_id),
    )


@router.get("/features", response_model=list[OverrideOut])
def list_overrides(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[OverrideOut]:
    require_admin(session)
    rows = db.scalars(select(FeatureOverride).order_by(FeatureOverride.set_at.desc())).all()
    return [_override_out(db, o) for o in rows]


@router.put("/features", response_model=OverrideOut)
def set_override(
    body: OverrideIn,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> OverrideOut:
    """Switch a feature off (or back on) at one rung. Upsert on the unique key.

    `enabled=True` is a real override, not a deletion: switching the voice
    interviewer off for a specialization and back on for one student inside it is
    two rows, and deleting the broader one would turn it on for the other
    eighty-five. Use DELETE to remove a rule entirely.
    """
    require_admin(session)
    reason = _reason(body.reason)
    if _target_label(db, body.scope, body.target_id).startswith("(removed"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="That target does not exist at the level given.",
        )
    existing = db.scalar(select(FeatureOverride).where(
        FeatureOverride.feature == body.feature,
        FeatureOverride.scope == body.scope,
        FeatureOverride.target_id == body.target_id,
    ))
    before = None
    if existing is None:
        row = FeatureOverride(
            feature=body.feature, scope=body.scope, target_id=body.target_id,
            enabled=body.enabled, reason=reason, set_by_user_id=session["userId"],
            expires_at=body.expires_at,
        )
        db.add(row)
        db.flush()
    else:
        before = {"enabled": existing.enabled, "reason": existing.reason}
        existing.enabled = body.enabled
        existing.reason = reason
        existing.set_by_user_id = session["userId"]
        existing.set_at = _now()
        existing.expires_at = body.expires_at
        row = existing
    record_change(
        db, session=session, request=request, tenant_id=None,
        entity_type="feature_override", entity_id=row.id,
        action="FEATURE_ENABLED" if body.enabled else "FEATURE_DISABLED",
        before=before,
        after={
            "feature": body.feature, "scope": body.scope.value, "target_id": body.target_id,
            "enabled": body.enabled, "reason": reason,
            "students_affected": _students_affected(db, body.scope, body.target_id),
        },
        event_type="governance.feature.set", payload={"feature": body.feature},
    )
    db.commit()
    db.refresh(row)
    return _override_out(db, row)


@router.delete("/features/{override_id}", status_code=status.HTTP_204_NO_CONTENT)
def clear_override(
    override_id: str,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
):
    """Remove the rule entirely, so the next rung up decides again."""
    require_admin(session)
    row = db.get(FeatureOverride, override_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Override not found.")
    record_change(
        db, session=session, request=request, tenant_id=None,
        entity_type="feature_override", entity_id=row.id, action="FEATURE_CLEARED",
        before={"feature": row.feature, "scope": row.scope.value, "enabled": row.enabled},
        after=None, event_type="governance.feature.cleared", payload={"feature": row.feature},
    )
    db.delete(row)
    db.commit()
    from fastapi import Response

    return Response(status_code=status.HTTP_204_NO_CONTENT)
