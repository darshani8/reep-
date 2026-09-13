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
    ScopeLevel,
    SubjectKind,
)
from .models.institution import Department
from .mentor_functions import mentor_functions_for
from .models.user import Student, User

_ALL: Final[frozenset[str]] = frozenset(c.key for c in CAPABILITIES)
_SCOPED: Final[frozenset[str]] = frozenset(
    c.key for c in CAPABILITIES if c.scope is CapabilityScope.SCOPED
)

#: What each role holds with no grant at all — exactly the screens it reaches
#: today. Introducing capability grants must not take anything away from anyone:
#: a deny-by-default rollout would have removed every mentor's own mentee log on
#: the deploy that shipped it. A grant is how someone gets what their role does
#: not already carry, which for a MENTOR is the programme-wide set.
#: DIRECTOR HOLDS NOTHING (2026-09-10), and this line is the one that decides it.
#:
#: The role removal touched the role gates first — `require_mentor`,
#: `require_admin`, `policies.STAFF_ROLES` — and for a few hours THIS map still
#: read `"DIRECTOR": _ALL - {"admin.interview_audio"}`. The result was worse than
#: leaving it alone: a DIRECTOR session was refused by every `require_*` gate and
#: still passed every `require_capability` one, which is roughly fifty endpoints
#: and the whole console — `admin.py`, `console.py`, the roster's
#: DELETE /api/admin/students/{id}, the exports CSV. Half a removal is a role
#: that cannot read its own mentee log but can delete the programme.
#:
#: An empty baseline is what makes "DIRECTOR grants nothing" true rather than
#: intended. The migration converts the rows; this closes the door for any row
#: that predates it, on a checkout where it has not run, or minted from an older
#: image. `tests/test_no_director_privilege.py` asserts both halves together.
#:
#: `admin.interview_audio` is still the one capability ADMIN alone holds nothing
#: extra to be said about — the asymmetry it recorded (a recording is an
#: operator's artefact containing a named student's voice, not placement
#: business) now lives entirely in MENTOR needing an explicit grant for it.
#: Faculty instruments. The Main Admin is not a faculty member: it has no
#: mentees, no private notebook, nobody's evidence to verify and no upskilling
#: shelf. These stay in the catalogue and stay SCOPED, so the Main Admin can
#: GRANT any of them in Governance -- to a faculty member, or to itself when a
#: student's evidence is stuck and nobody else will look -- and revoke them
#: again. `mentor.leave_approve` is NOT here: the Main Admin is the Program
#: Director, the second of the two approvers, and removing it breaks sanctioning.
_FACULTY_ONLY: Final[frozenset[str]] = frozenset(
    {"mentor.mentees", "mentor.notebook", "mentor.verifications", "mentor.upskilling"}
)

ROLE_BASELINE: Final[dict[str, frozenset[str]]] = {
    "ADMIN": _ALL - _FACULTY_ONLY,
    "DIRECTOR": frozenset(),
    # B2.3: A FACULTY ACCOUNT IS NOT A MENTOR BY EXISTING, and this line is
    # where that stopped being only a sentence in AGENTS.md. It was `_SCOPED` —
    # every SCOPED key in the catalogue — so "is this person staff" and "may this
    # person read a mentee's ledger" were one question with one answer.
    #
    # What is left is what belongs to the PERSON: the assistant, and their own
    # certificate shelf. The four that belong to a GROUP — the mentee log, the
    # notebook, evidence verification and leave approval — arrive as derived
    # grants when they are assigned their first student and go when their last
    # one is released (app/mentor_functions.py). Every one of those four already
    # refused a faculty member with no mentees at the endpoint; now Governance
    # says so too, which is where the office looks to answer "who can see what".
    #
    # The ten `student.*` keys left with them. They gate nothing anywhere —
    # B2.1 deletes them from the catalogue — and no client reads one, so this
    # removes no access from anybody.
    "MENTOR": frozenset({"mentor.agent", "mentor.upskilling"}),
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


def granted_reaches(db: Session, user_id: str, key: str) -> list[tuple[ScopeLevel | None, str | None]]:
    """How far this user's live grants for `key` reach, one entry per grant.

    `(None, None)` is a programme-wide grant and means everywhere. Anything else
    is a rung of the spine and the id it hangs on, and the holder reaches a
    target only when that pair is in the target's ancestry.

    Separate from `granted_capabilities` rather than folded into it because the
    two answer different questions and only one of them is asked on every
    request: "which keys does this session hold" drives the sidebar and runs on
    /auth/me, while "how far does this key reach" is asked by the handful of
    endpoints that name a target. Returning the reaches from the common path
    would make every /auth/me carry six columns it does not read.
    """
    if not user_id:
        return []
    now = _now()
    live = (
        CapabilityGrant.capability == key,
        CapabilityGrant.revoked_at.is_(None),
        or_(CapabilityGrant.expires_at.is_(None), CapabilityGrant.expires_at > now),
    )
    columns = (CapabilityGrant.scope_level, CapabilityGrant.scope_id)
    direct = select(*columns).where(
        CapabilityGrant.subject_kind == SubjectKind.USER,
        CapabilityGrant.subject_user_id == user_id,
        *live,
    )
    via_group = (
        select(*columns)
        .join(AccessGroupMember, AccessGroupMember.group_id == CapabilityGrant.subject_group_id)
        .where(
            CapabilityGrant.subject_kind == SubjectKind.GROUP,
            AccessGroupMember.user_id == user_id,
            *live,
        )
    )
    return [tuple(row) for row in db.execute(direct).all()] + [
        tuple(row) for row in db.execute(via_group).all()
    ]


def reaches_target(
    reaches: list[tuple[ScopeLevel | None, str | None]],
    ancestry: list[tuple[ScopeLevel, str]],
) -> bool:
    """Does any of these grants cover a target with this ancestry?

    A programme-wide grant covers everything. A scoped grant covers the target
    when its (rung, id) is one of the target's own — which is why the ancestry
    is computed as the full list rather than the deepest rung: a grant on the
    college and a grant on the batch are both satisfied by the same student.

    AN EMPTY ANCESTRY IS NOT COVERED BY A SCOPED GRANT, and that is deliberate.
    A student seated in no batch and filed under no department, or an unfiled
    faculty account, hangs under nothing — so a department-scoped holder cannot
    reach them. Answering "yes" there would make the unfiled state a way around
    every scope in the system, and unfiled is an ordinary state that the console
    shows a list of.
    """
    covered = set(ancestry)
    return any(level is None or (level, target_id) in covered for level, target_id in reaches)


def capabilities_for(db: Session, session: dict) -> frozenset[str]:
    """Everything this session may use: baseline, functions, and grants.

    Three sources, unioned, and each answers a different question. The BASELINE
    is what the role carries — the Main Admin's programme keys, a faculty
    member's own assistant and shelf. The FUNCTIONS are what mentoring somebody
    brings, derived live from the mentee count rather than stored, so no path
    that assigns a student can forget to write them (app/mentor_functions.py
    explains why that is not the design 04 asks for). The GRANTS are what a
    person decided to hand over, in Governance, with a reason.
    """
    role = str(session.get("role") or "")
    user_id = str(session.get("userId") or "")
    baseline = ROLE_BASELINE.get(role, frozenset())
    functions = mentor_functions_for(db, user_id) if role == "MENTOR" else frozenset()
    return baseline | functions | granted_capabilities(db, user_id)


def has_capability(db: Session, session: dict, key: str) -> bool:
    if key not in CAPABILITIES_BY_KEY:
        raise ValueError(f"unknown capability {key!r}")
    return key in capabilities_for(db, session)


def require_capability(
    db: Session,
    session: dict,
    key: str,
    *,
    target: list[tuple[ScopeLevel, str]] | None = None,
) -> None:
    """403 when the session lacks the capability, or holds it somewhere else.

    403 and not 404, unlike rule 2's refusals: the caller is a known staff member
    and the resource is not a student they might be probing for. "You do not hold
    this" is a true and safe thing to tell them, and a 404 here would send an
    admin hunting for a broken route instead of granting a capability.

    `target` IS OPT-IN AND EVERY EXISTING CALL SITE KEEPS ITS MEANING. Eighty
    calls in this repository pass three positional arguments and ask "may you do
    this at all"; they still get exactly that answer. A call that passes a
    target — the ancestry of the student, faculty member or batch it is about —
    additionally asks "may you do it HERE", and that is the only question scope
    narrows. Adding the parameter without a default would have been a change to
    all eighty at once, decided by whoever was quickest to update the signature.

    A capability held through the ROLE BASELINE is unscoped. That is the Main
    Admin, whose baseline is every programme key and whose whole job is the
    programme; a MENTOR's baseline keys are narrowed by rule 2's mentor-group
    check instead, which is a different and stricter gate that this must not
    replace. Scope is a property of a GRANT, because a grant is the thing
    somebody decided to hand over, and handing it over is where "how far" gets
    asked.
    """
    if key not in CAPABILITIES_BY_KEY:
        raise ValueError(f"unknown capability {key!r}")

    role = str(session.get("role") or "")
    user_id = str(session.get("userId") or "")
    if key in ROLE_BASELINE.get(role, frozenset()):
        return
    # A function is unscoped for the same reason a baseline key is: rule 2's
    # mentor-group check is already the fence on all four, and it is stricter
    # than any scope could be — it narrows to THIS mentor's own students rather
    # than to a department's.
    if role == "MENTOR" and key in mentor_functions_for(db, user_id):
        return

    reaches = granted_reaches(db, user_id, key)
    if not reaches:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"You do not hold the '{CAPABILITIES_BY_KEY[key].label}' capability. "
                "An administrator can grant it in Governance."
            ),
        )
    if target is not None and not reaches_target(reaches, target):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"Your '{CAPABILITIES_BY_KEY[key].label}' capability does not reach this "
                "record. An administrator can widen it in Governance."
            ),
        )


# --------------------------------------------------------------------------- #
# Student features
# --------------------------------------------------------------------------- #

def ancestry_of_student(db: Session, student_id: str) -> list[tuple[ScopeLevel, str]]:
    """Every (rung, id) pair this student hangs under.

    One flat read, and nothing is stored: the same shape as
    `routers/student.py::_institution_for`, and for the same reason — copying a
    student's ancestry onto their row is the backfill the spine exists to avoid.

    A cohort carries all three ancestor pointers rather than only the deepest,
    because the levels are individually optional; missing rungs simply produce no
    pair, and anything hung at a level this student has no ancestor for cannot
    match them.

    TWO POINTERS REACH A DEPARTMENT, AND THIS READS BOTH. `cohorts.department_id`
    is one; `students.department_id` (migration 31f7a4c60b12) is the other, and
    it is the ONLY one for a student who named a department on the registration
    form and has not been seated in a batch — which is every student at a college
    that has not built its batches yet. `_institution_for` has tried both since
    that column existed, and this function did not: it read the cohort route
    alone, so an override hung on a department reached the seated students in it
    and silently missed the unseated ones.

    That was a live bug in feature overrides before it was a hole in B1.2's
    scope check, and fixing it HERE fixes both, which is why this is the one
    ancestry function rather than a second one written for grants. Switching a
    feature off for a department now also switches it off for that department's
    unseated students — which is what "for this department" has always meant on
    the screen that sets it.

    The college is reached through the DEPARTMENT only. `cohorts.course_id` and
    `specialization_id` are flat sibling pointers, not a chain upward: a course
    does not carry a college, so walking through one would resolve nothing (see
    `routers/student.py`'s note on why chaining them is wrong).
    """
    row = db.execute(
        select(
            Student.id,
            Student.cohort_id,
            Student.department_id.label("own_department_id"),
            Cohort.department_id.label("batch_department_id"),
            Cohort.course_id,
            Cohort.specialization_id,
        )
        .select_from(Student)
        .outerjoin(Cohort, Student.cohort_id == Cohort.id)
        .where(Student.id == student_id)
    ).first()
    if row is None:
        return []

    # The batch's department wins where there is one, because it is the more
    # specific statement about where this student sits; the student's own
    # pointer stands alone for an unseated student, and stands in for a batch
    # nobody filed. Same precedence as `_institution_for`.
    department_id = row.batch_department_id or row.own_department_id
    college_id = (
        db.scalar(select(Department.college_id).where(Department.id == department_id))
        if department_id
        else None
    )
    pairs = [
        (ScopeLevel.STUDENT, row.id),
        (ScopeLevel.COHORT, row.cohort_id),
        (ScopeLevel.SPECIALIZATION, row.specialization_id),
        (ScopeLevel.COURSE, row.course_id),
        (ScopeLevel.DEPARTMENT, department_id),
        (ScopeLevel.COLLEGE, college_id),
    ]
    return [(scope, tid) for scope, tid in pairs if tid]


def ancestry_of_user(db: Session, user_id: str) -> list[tuple[ScopeLevel, str]]:
    """Where a STAFF account sits: its department, and that department's college.

    Shorter than a student's on purpose — a faculty member is filed under a
    department and nothing else. An unfiled account (`users.department_id IS
    NULL`, a first-class state on the Faculty screen) hangs under nothing, so a
    scoped grant cannot reach it and a scoped holder cannot reach them.
    """
    department_id = db.scalar(select(User.department_id).where(User.id == user_id))
    if not department_id:
        return []
    college_id = db.scalar(select(Department.college_id).where(Department.id == department_id))
    pairs = [(ScopeLevel.DEPARTMENT, department_id), (ScopeLevel.COLLEGE, college_id)]
    return [(scope, tid) for scope, tid in pairs if tid]


#: Kept so the feature-override code below reads as it did. The rename is the
#: point: this answers "where does this student hang", which is a question about
#: the spine and not about features.
_ancestry = ancestry_of_student


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
