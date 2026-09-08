"""Resolving governance: what a staff member may use, and what a student has.

Two questions, two functions, and they are deliberately not the same shape:

    has_capability(db, session, key)      -> bool   staff, deny past the baseline
    feature_enabled(db, student_id, key)  -> bool   students, allow until switched off

RULE 2 IS NOT IN THIS FILE, ON PURPOSE. `_assert_can_access_student` decides
WHICH STUDENTS a staff member may reach and lives in routers/mentor.py; this
decides WHICH SCREENS. Both must pass and they are checked separately, so a
capability can never relax the student filter — that is the safety argument, and
importing the two into one function would be the first step in losing it.

Nothing here caches. A grant revoked at 11:04 must stop working at 11:04, and a
per-process cache is how a revoked capability keeps working on three of five
workers until the next deploy.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Final

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from .models.cohort import Cohort
from .models.governance import (
    CAPABILITIES,
    CAPABILITIES_BY_KEY,
    FEATURES_BY_KEY,
    SPECIFICITY,
    AccessGroupMember,
    CapabilityGrant,
    CapabilityScope,
    FeatureOverride,
    FeatureScope,
    SubjectKind,
)
from .models.institution import Department
from .models.user import Student

_ALL: Final[frozenset[str]] = frozenset(c.key for c in CAPABILITIES)
_SCOPED: Final[frozenset[str]] = frozenset(
    c.key for c in CAPABILITIES if c.scope is CapabilityScope.SCOPED
)

#: What each role holds with no grant at all — exactly the screens it reaches
#: today. Introducing capability grants must not take anything away from anyone:
#: a deny-by-default rollout would have removed every mentor's own mentee log on
#: the deploy that shipped it. A grant is how someone gets what their role does
#: not already carry, which for a MENTOR is the programme-wide set.
ROLE_BASELINE: Final[dict[str, frozenset[str]]] = {
    "ADMIN": _ALL,
    "DIRECTOR": _ALL,
    "MENTOR": _SCOPED,
    "STUDENT": frozenset(),
    "ALUMNI": frozenset(),
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def granted_capabilities(db: Session, user_id: str) -> frozenset[str]:
    """Capabilities this user holds by grant — directly, or through a group.

    Live means: not revoked, and either no expiry or an expiry still ahead. Both
    are filtered in SQL rather than in Python so a long-expired grant never
    reaches the process at all.
    """
    if not user_id:
        return frozenset()
    now = _now()
    live = (
        CapabilityGrant.revoked_at.is_(None),
        or_(CapabilityGrant.expires_at.is_(None), CapabilityGrant.expires_at > now),
    )
    direct = select(CapabilityGrant.capability).where(
        CapabilityGrant.subject_kind == SubjectKind.USER,
        CapabilityGrant.subject_user_id == user_id,
        *live,
    )
    # Through a group: the grant names the group, the membership names the user.
    # A person who joins the group tomorrow inherits it with no second grant,
    # which is the reason groups exist.
    via_group = (
        select(CapabilityGrant.capability)
        .join(AccessGroupMember, AccessGroupMember.group_id == CapabilityGrant.subject_group_id)
        .where(
            CapabilityGrant.subject_kind == SubjectKind.GROUP,
            AccessGroupMember.user_id == user_id,
            *live,
        )
    )
    keys = set(db.scalars(direct).all()) | set(db.scalars(via_group).all())
    # A grant naming a capability the catalogue no longer defines is ignored
    # rather than trusted: the catalogue is code, so the key was removed in a
    # deploy and nothing enforces it any more.
    return frozenset(k for k in keys if k in CAPABILITIES_BY_KEY)


def capabilities_for(db: Session, session: dict) -> frozenset[str]:
    """Everything this session may use: its role's baseline plus its grants."""
    role = str(session.get("role") or "")
    baseline = ROLE_BASELINE.get(role, frozenset())
    return baseline | granted_capabilities(db, str(session.get("userId") or ""))


def has_capability(db: Session, session: dict, key: str) -> bool:
    if key not in CAPABILITIES_BY_KEY:
        raise ValueError(f"unknown capability {key!r}")
    return key in capabilities_for(db, session)


def require_capability(db: Session, session: dict, key: str) -> None:
    """403 when the session lacks the capability.

    403 and not 404, unlike rule 2's refusals: the caller is a known staff member
    and the resource is not a student they might be probing for. "You do not hold
    this" is a true and safe thing to tell them, and a 404 here would send an
    admin hunting for a broken route instead of granting a capability.
    """
    if not has_capability(db, session, key):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"You do not hold the '{CAPABILITIES_BY_KEY[key].label}' capability. "
                "An administrator can grant it in Governance."
            ),
        )


# --------------------------------------------------------------------------- #
# Student features
# --------------------------------------------------------------------------- #

def _ancestry(db: Session, student_id: str) -> list[tuple[FeatureScope, str]]:
    """Every (rung, id) pair an override could hang on for this student.

    One flat LEFT-JOIN read, and nothing is stored: the same shape as
    `routers/student.py::_institution_for`, and for the same reason — copying a
    student's ancestry onto their row is the backfill the spine exists to avoid.

    A cohort carries all three ancestor pointers rather than only the deepest,
    because the levels are individually optional; missing rungs simply produce no
    pair, and an override at a level this student has no ancestor for cannot
    match them.
    """
    row = db.execute(
        select(
            Student.id,
            Student.cohort_id,
            Cohort.department_id,
            Cohort.course_id,
            Cohort.specialization_id,
            Department.college_id,
        )
        .select_from(Student)
        .outerjoin(Cohort, Student.cohort_id == Cohort.id)
        .outerjoin(Department, Cohort.department_id == Department.id)
        .where(Student.id == student_id)
    ).first()
    if row is None:
        return []
    pairs = [
        (FeatureScope.STUDENT, row.id),
        (FeatureScope.COHORT, row.cohort_id),
        (FeatureScope.SPECIALIZATION, row.specialization_id),
        (FeatureScope.COURSE, row.course_id),
        (FeatureScope.DEPARTMENT, row.department_id),
        (FeatureScope.COLLEGE, row.college_id),
    ]
    return [(scope, tid) for scope, tid in pairs if tid]


def feature_enabled(db: Session, student_id: str, feature: str) -> bool:
    """Is `feature` on for this student? Allow by default; most specific wins.

    An admin switches the voice interviewer off for a specialization and back on
    for one student inside it: two rows, and the student-level one wins because
    it is more specific. That is why `FeatureOverride.enabled` is a boolean
    rather than the row's mere existence meaning "off" — deleting the broader
    rule to make an exception would turn the feature on for everyone else too.
    """
    if feature not in FEATURES_BY_KEY:
        raise ValueError(f"unknown feature {feature!r}")
    pairs = _ancestry(db, student_id)
    if not pairs:
        return True
    now = _now()
    rows = db.scalars(
        select(FeatureOverride).where(
            FeatureOverride.feature == feature,
            or_(FeatureOverride.expires_at.is_(None), FeatureOverride.expires_at > now),
            or_(
                *[
                    (FeatureOverride.scope == scope) & (FeatureOverride.target_id == tid)
                    for scope, tid in pairs
                ]
            ),
        )
    ).all()
    if not rows:
        return True
    winner = max(rows, key=lambda r: SPECIFICITY[r.scope])
    return bool(winner.enabled)


def features_for(db: Session, student_id: str) -> dict[str, bool]:
    """Every feature's state for one student, for the client to render from.

    One call rather than ten, because the student's shell asks for all of them at
    once and ten round trips through `_ancestry` would read the same six ids ten
    times.
    """
    pairs = _ancestry(db, student_id)
    if not pairs:
        return {key: True for key in FEATURES_BY_KEY}
    now = _now()
    rows = db.scalars(
        select(FeatureOverride).where(
            or_(FeatureOverride.expires_at.is_(None), FeatureOverride.expires_at > now),
            or_(
                *[
                    (FeatureOverride.scope == scope) & (FeatureOverride.target_id == tid)
                    for scope, tid in pairs
                ]
            ),
        )
    ).all()
    best: dict[str, FeatureOverride] = {}
    for r in rows:
        current = best.get(r.feature)
        if current is None or SPECIFICITY[r.scope] > SPECIFICITY[current.scope]:
            best[r.feature] = r
    return {
        key: bool(best[key].enabled) if key in best else True
        for key in FEATURES_BY_KEY
    }
