"""Governance — who may reach which screen, and which screens a student has.

TWO INSTRUMENTS, AND THEY HAVE OPPOSITE DEFAULTS. Collapsing them into one
setting is the bug this file exists to prevent, because the same control would
then sometimes grant and sometimes remove.

  * `CapabilityGrant` is DENY BY DEFAULT. Nobody holds a capability until an
    admin issues it, to a named user or to an `AccessGroup` whose members
    inherit it.
  * `FeatureOverride` is ALLOW BY DEFAULT. Every student has every feature until
    one is switched off, at any rung of the institutional hierarchy — a whole
    specialization, one batch, or a single student.

HOW A CAPABILITY COMPOSES WITH RULE 2 — the only question that matters here,
and the two answer DIFFERENT questions, which is what makes the composition safe:

    rule 2      decides WHICH STUDENTS a staff member may reach.
    capability  decides WHICH SCREENS AND ACTIONS they may use.

They are orthogonal, and both must pass. A grant may therefore widen the second —
that is what granting Analytics to a mentor does — but it can NEVER widen the
first. Holding `student.interviews` lets a mentor open scorecards for students
ALREADY IN THEIR OWN GROUP; it cannot reach a student outside it, and a MENTOR
WITH NO GROUP STILL SEES NOBODY, whatever they hold.

That is the whole safety argument: rule 2 exists because "no filter" is the
reading that turns an empty mentor group into the whole programme, and a
capability that could relax the student filter would hand that reading back
through a different door. `tests/test_governance.py` pins it.

CAPABILITIES ARE ADDITIVE OVER A ROLE BASELINE, not deny-everything. Every role
already holds the screens it has today (app/governance.py's ROLE_BASELINE), so
introducing this table takes nothing away from anyone; a grant is how a person
gets something their role does not already carry. A deny-by-default rollout would
have silently removed every mentor's own mentee log on deploy.

THE EXCEPTION, MARKED EVERYWHERE. Analytics, exports and the institution
hierarchy are cross-cohort by nature — there is no group to narrow them to. A
`PROGRAMME` capability therefore hands over the whole college, which is why it
is a separate scope on the catalogue rather than a footnote, why the console
paints it red, and why every grant on this table demands a reason.

THE CATALOGUE IS CODE, ONLY STATE IS ROWS — the same rule as the 48 badges
(models/badge.py) and the programme milestones (models/milestone.py). Adding a
capability is a code change on purpose: each one has to be enforced at a call
site, and a row that names a capability nothing checks is a promise the API does
not keep. What admins maintain in the database is who holds what.

`reason` is NOT NULL on both tables. An audit trail whose entries do not say why
is a list of dates.
"""

from __future__ import annotations

import enum
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    func,
    text as sql_text,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


# --------------------------------------------------------------------------- #
# The catalogue (code, not rows)
# --------------------------------------------------------------------------- #

class CapabilityScope(str, enum.Enum):
    #: Checked after rule 2. Reaches only students already in the holder's group.
    SCOPED = "SCOPED"
    #: Cross-cohort by nature. Cannot be narrowed; hands over the whole college.
    PROGRAMME = "PROGRAMME"


@dataclass(frozen=True, slots=True)
class Capability:
    key: str
    label: str
    scope: CapabilityScope
    #: True when exercising it shows a student's own record — marks, transcripts,
    #: certificates, a leave reason, their voice. Rule 1's concern, not rule 2's,
    #: and the reason the console marks these separately from the scope.
    carries_pii: bool = False


_S = CapabilityScope.SCOPED
_P = CapabilityScope.PROGRAMME

#: One entry per screen a staff member can reach. Keys mirror the Angular routes
#: so a reviewer can check the two lists against each other by eye.
CAPABILITIES: Final[tuple[Capability, ...]] = (
    # -- student records, scoped to the holder's mentor group ----------------
    Capability("student.profile", "Profile & USN", _S, carries_pii=True),
    Capability("student.records", "Academic records", _S, carries_pii=True),
    Capability("student.skilling", "Skilling & badges", _S),
    Capability("student.uploads", "Documents & uploads", _S, carries_pii=True),
    Capability("student.resume", "Resume Builder drafts", _S, carries_pii=True),
    Capability("student.interviews", "Interview results", _S, carries_pii=True),
    Capability("student.english", "English baseline", _S),
    Capability("student.time_log", "Time allocation ledger", _S),
    Capability("student.mentor_log", "Mentor meeting log", _S),
    Capability("student.jobs", "Job applications", _S),
    # -- faculty tools -------------------------------------------------------
    Capability("mentor.mentees", "Mentee log", _S),
    Capability("mentor.notebook", "Mentor notebook", _S),
    Capability("mentor.verifications", "Verify skills & evidence", _S),
    Capability("mentor.leave_approve", "Approve leave", _S, carries_pii=True),
    Capability("mentor.upskilling", "Own upskilling shelf", _S),
    Capability("mentor.agent", "REEP Agent", _S),
    # -- programme-wide: no group narrows these ------------------------------
    Capability("admin.analytics", "Analytics", _P),
    Capability("admin.exports", "Exports", _P, carries_pii=True),
    Capability("admin.institution", "Institution hierarchy", _P),
    Capability("admin.registrations", "Registrations", _P, carries_pii=True),
    Capability("admin.catalogue", "Approved certifications", _P),
    Capability("admin.jobs", "Jobs sheet", _P),
    Capability("admin.placement", "Placement", _P),
    Capability("admin.mentors", "Mentors & students", _P, carries_pii=True),
    Capability("admin.interview_audio", "Interview audio", _P, carries_pii=True),
    # The admin-authored question bank the free-style interviewer weaves in
    # (app/interview_bank.py). PROGRAMME: a question is asked of every student on
    # the track, so no mentor group could narrow it.
    Capability("admin.interview_questions", "Interview questions", _P),
)

CAPABILITIES_BY_KEY: Final[dict[str, Capability]] = {c.key: c for c in CAPABILITIES}


@dataclass(frozen=True, slots=True)
class Feature:
    key: str
    label: str


#: Student-facing features. These are SWITCHED OFF, never granted — every
#: student has them until an override says otherwise.
FEATURES: Final[tuple[Feature, ...]] = (
    Feature("student.assistant", "Voice interviewer (Mock Interview)"),
    Feature("student.agent", "REEP Agent (chat)"),
    Feature("student.resume", "Resume Builder"),
    Feature("student.english", "English baseline test"),
    Feature("student.jobs", "Jobs feed & applications"),
    Feature("student.leaderboards", "Leaderboards"),
    Feature("student.uploads", "Document uploads"),
    Feature("student.time_log", "Time allocation ledger"),
    Feature("student.skilling", "Skilling & badges"),
    Feature("student.certifications", "Certifications"),
)

FEATURES_BY_KEY: Final[dict[str, Feature]] = {f.key: f for f in FEATURES}


class FeatureScope(str, enum.Enum):
    """A rung of the institutional hierarchy.

    NOT `institution.HierarchyLevel`, which is a different thing with a
    confusingly similar name: that one says which levels a NEW BATCH must name.
    This one says where a feature override was hung. Ordered most general to most
    specific, and `SPECIFICITY` below depends on that order.
    """

    COLLEGE = "COLLEGE"
    DEPARTMENT = "DEPARTMENT"
    COURSE = "COURSE"
    SPECIALIZATION = "SPECIALIZATION"
    COHORT = "COHORT"
    STUDENT = "STUDENT"


#: Higher wins. A student-level override beats their cohort, which beats its
#: specialization, and so on up. Resolution reads every override that covers a
#: student and keeps the most specific — which is why an admin can switch a
#: feature off for a whole specialization and still turn it back on for one
#: student inside it, without deleting the broader rule.
SPECIFICITY: Final[dict[FeatureScope, int]] = {
    FeatureScope.COLLEGE: 0,
    FeatureScope.DEPARTMENT: 1,
    FeatureScope.COURSE: 2,
    FeatureScope.SPECIALIZATION: 3,
    FeatureScope.COHORT: 4,
    FeatureScope.STUDENT: 5,
}


class SubjectKind(str, enum.Enum):
    USER = "USER"
    GROUP = "GROUP"


# --------------------------------------------------------------------------- #
# The rows
# --------------------------------------------------------------------------- #

class AccessGroup(Base):
    """A named set of faculty who inherit the same capabilities.

    Group-level rather than per-person because "the placement coordinators" is a
    role that outlives its current membership: a grant issued to the group is
    held by whoever joins later, without an admin remembering to repeat it.
    """

    __tablename__ = "access_groups"
    __table_args__ = (UniqueConstraint("name", name="uq_access_group_name"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(String(400), nullable=True)
    created_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AccessGroupMember(Base):
    __tablename__ = "access_group_members"
    __table_args__ = (
        UniqueConstraint("group_id", "user_id", name="uq_access_group_member"),
        Index("ix_access_group_member_user", "user_id"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    group_id: Mapped[str] = mapped_column(ForeignKey("access_groups.id", ondelete="CASCADE"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    added_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CapabilityGrant(Base):
    """One capability, held by one user or one group, until revoked or expired.

    NOT deleted on revoke. `revoked_at` is stamped and the row stays, because
    "who held exports last March, and who signed it off" has to remain
    answerable — the same reasoning as `badge_evidence.upload_id` being SET NULL
    rather than CASCADE. A governance table that forgets is not governance.
    """

    __tablename__ = "capability_grants"
    __table_args__ = (
        # Declared HERE as well as in the migration, or `alembic check` reports it
        # as a removed constraint on every run and real drift becomes invisible
        # behind the noise — the incident recorded on redesign.py's outbox indexes.
        CheckConstraint(
            "(subject_kind = 'USER'  AND subject_user_id  IS NOT NULL AND subject_group_id IS NULL)"
            " OR "
            "(subject_kind = 'GROUP' AND subject_group_id IS NOT NULL AND subject_user_id  IS NULL)",
            name="ck_capability_grant_one_subject",
        ),
        Index("ix_capgrant_user_live", "subject_user_id", "capability", "revoked_at"),
        Index("ix_capgrant_group_live", "subject_group_id", "capability", "revoked_at"),
        Index("ix_capgrant_capability", "capability"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    #: A key from CAPABILITIES. A plain String, not a PG enum, so adding a
    #: capability is a deploy rather than a type migration — the same choice
    #: auth_tokens.purpose makes and for the same reason.
    capability: Mapped[str] = mapped_column(String(64), nullable=False)

    subject_kind: Mapped[SubjectKind] = mapped_column(
        Enum(SubjectKind, name="governance_subject_kind"), nullable=False
    )
    #: Exactly one of these is set; the CHECK constraint in the migration is what
    #: enforces that, because two half-set columns is a grant nobody holds.
    subject_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    subject_group_id: Mapped[str | None] = mapped_column(
        ForeignKey("access_groups.id", ondelete="CASCADE"), nullable=True
    )

    reason: Mapped[str] = mapped_column(String, nullable=False)
    granted_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    granted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    #: NULL means it does not lapse. An expiry is the cheapest way to stop a
    #: capability issued for one November audit from still being held in March.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    revoke_reason: Mapped[str | None] = mapped_column(String, nullable=True)


class FeatureOverride(Base):
    """A student-facing feature switched off (or back on) at one rung.

    `enabled` exists rather than only ever meaning "off" because the most-specific
    rule wins: switching the voice interviewer off for a specialization and back
    on for one student inside it is two rows, and deleting the broader one would
    turn it on for the other eighty-five.
    """

    __tablename__ = "feature_overrides"
    __table_args__ = (
        UniqueConstraint("feature", "scope", "target_id", name="uq_feature_override_target"),
        Index("ix_feature_override_lookup", "feature", "scope", "target_id"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    feature: Mapped[str] = mapped_column(String(64), nullable=False)
    scope: Mapped[FeatureScope] = mapped_column(
        Enum(FeatureScope, name="governance_feature_scope"), nullable=False
    )
    #: The id of the college / department / course / specialization / cohort /
    #: student this hangs on. Not an FK: it points at six different tables
    #: depending on `scope`, and a polymorphic FK is a constraint no database can
    #: express. Resolution joins explicitly per level instead.
    target_id: Mapped[str] = mapped_column(String, nullable=False)

    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=sql_text("false")
    )
    reason: Mapped[str] = mapped_column(String, nullable=False)
    set_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    set_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
