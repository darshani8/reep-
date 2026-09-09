"""The programme sign-up flow (ported from Prisma): an application to join,
the data-driven rules that may wave it through, and single-use email
confirmation links.

Structural note carried over verbatim: `Registration` has NO foreign key to
`Student`. A Student cannot exist until a cohort is decided — which is the very
thing approval decides — so the applicant lives in its own table until then, and
the created student's id is written back to `approved_student_id` as a plain
string breadcrumb (deleting the student must not resurrect a pending application).

`registration_status` is a new PG enum; `degree_level` is the existing one shared
with Cohort/Job (create_type=False), reused by one instance across both columns
that need it here.
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Index, Integer, String, func, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base
from .job import DegreeLevel


def _uuid() -> str:
    return uuid.uuid4().hex


class RegistrationStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    PENDING_VERIFICATION = "PENDING_VERIFICATION"
    PENDING_REVIEW = "PENDING_REVIEW"
    AUTO_APPROVED = "AUTO_APPROVED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


# One shared instance so the (already-existing) degree_level type is referenced
# consistently by both the required column here and the nullable one on the rule.
_DEGREE_LEVEL = Enum(DegreeLevel, name="degree_level", create_type=False)


class RegistrationRule(Base):
    """When a registration may be waved through without a human reading it. The
    conditions live in data so the admissions office can change them between
    intakes without a deploy. All populated conditions must match; the lowest
    `priority` among the matches decides."""

    __tablename__ = "registration_rules"
    __table_args__ = (Index("ix_regrule_enabled_priority", "enabled", "priority"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")

    # Everything after the "@", lowercased. Null means "any domain".
    email_domain: Mapped[str | None] = mapped_column(String, nullable=True)
    # Regex the USN must satisfy, e.g. ^1BG2[0-9]MBA[0-9]{3}$.
    usn_pattern: Mapped[str | None] = mapped_column(String, nullable=True)
    degree_level: Mapped[DegreeLevel | None] = mapped_column(_DEGREE_LEVEL, nullable=True)

    cohort_id: Mapped[str | None] = mapped_column(
        ForeignKey("cohorts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # False means "matched, and still send it to a human" — a rule can route and
    # label an application without approving it.
    auto_approve: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    priority: Mapped[int] = mapped_column(Integer, default=100, server_default="100")

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Registration(Base):
    __tablename__ = "registrations"
    __table_args__ = (Index("ix_registration_status_created", "status", "created_at"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String)
    email: Mapped[str] = mapped_column(String, unique=True)
    usn: Mapped[str | None] = mapped_column(String, nullable=True)
    phone: Mapped[str | None] = mapped_column(String, nullable=True)

    degree_level: Mapped[DegreeLevel] = mapped_column(
        _DEGREE_LEVEL, default=DegreeLevel.PG, server_default="PG"
    )
    # The cohort applied for. Nullable — an applicant may not know; a rule or a
    # reviewer assigns it.
    cohort_id: Mapped[str | None] = mapped_column(
        ForeignKey("cohorts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    status: Mapped[RegistrationStatus] = mapped_column(
        Enum(RegistrationStatus, name="registration_status"),
        default=RegistrationStatus.DRAFT,
        server_default="DRAFT",
    )

    # Which rule decided this, when one did.
    matched_rule_id: Mapped[str | None] = mapped_column(
        ForeignKey("registration_rules.id", ondelete="SET NULL"), nullable=True, index=True
    )
    decision_reason: Mapped[str | None] = mapped_column(String, nullable=True)

    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Reviewer's user id — a plain column (audit stamp), as on Upload.
    reviewed_by_id: Mapped[str | None] = mapped_column(String, nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    review_note: Mapped[str | None] = mapped_column(String, nullable=True)

    # Set once the application became a Student. A string, not a relation.
    approved_student_id: Mapped[str | None] = mapped_column(String, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class EmailVerification(Base):
    """A single-use email confirmation link. Only the hash of the token is
    stored — the token itself exists in the email and nowhere else, so a leaked
    dump of this table cannot confirm anybody's address. `consumed_at` is kept
    rather than the row deleted, so a second click can be told apart from an
    expired link and given the right message."""

    __tablename__ = "email_verifications"
    __table_args__ = (Index("ix_emailverif_registration", "registration_id"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    registration_id: Mapped[str] = mapped_column(
        ForeignKey("registrations.id", ondelete="CASCADE")
    )
    token_hash: Mapped[str] = mapped_column(String, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


#: The two things an applicant may attach before anyone has decided on them.
#: Plain strings, not a PG enum — the same choice `auth_tokens.purpose` made:
#: adding a third kind is a deploy, not a type migration.
DOCUMENT_KIND_CV = "CV"
DOCUMENT_KIND_PHOTO = "PHOTO"
DOCUMENT_KINDS: tuple[str, ...] = (DOCUMENT_KIND_CV, DOCUMENT_KIND_PHOTO)


class RegistrationDocument(Base):
    """A file attached to a public application BEFORE it is decided.

    Why not `Upload`: an Upload is keyed on `students.id`, and an applicant has
    no Student row until a director approves them — that is the whole point of
    the queue. So the file lives here, owned by the application, and on
    APPROVE it is MOVED into `uploads` (same stored_name, no second copy of the
    bytes) as the student's first RESUME / PROFILE_PHOTO. On REJECT, or when a
    never-verified application is swept, it is deleted with the row.

    ONE OF EACH KIND, REPLACED IN PLACE — the unique constraint is what makes
    "re-upload your CV" a replace and not a second file the reviewer has to
    guess between. The bytes go through app/document_store like every other
    upload: magic-sniffed (PDF / PNG / JPEG only), size-capped, no path from
    the client ever reaches the disk.
    """

    __tablename__ = "registration_documents"
    __table_args__ = (
        Index("ix_regdoc_registration", "registration_id"),
        UniqueConstraint("registration_id", "kind", name="uq_regdoc_registration_kind"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    registration_id: Mapped[str] = mapped_column(
        ForeignKey("registrations.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(String)  # DOCUMENT_KIND_CV | DOCUMENT_KIND_PHOTO
    original_name: Mapped[str] = mapped_column(String)
    stored_name: Mapped[str] = mapped_column(String, unique=True)
    mime_type: Mapped[str] = mapped_column(String)
    size_bytes: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
