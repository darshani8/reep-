"""Leave requests — the two-approver workflow (ported from Prisma
`LeaveRequest`). A request needs two distinct signatures: SUBMITTED ->
FIRST_APPROVED (first approver) -> APPROVED (second). A rejection at either
stage -> REJECTED. LeaveDecision has no PENDING: a null decision already says
the approver has not looked yet.
"""

import enum
import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Enum, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


class LeaveStatus(str, enum.Enum):
    SUBMITTED = "SUBMITTED"
    FIRST_APPROVED = "FIRST_APPROVED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"


class LeaveDecision(str, enum.Enum):
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


# One shared Enum instance for both decision columns, so the PG type is created
# exactly once (two separate Enum(...) would each try to CREATE TYPE).
_LEAVE_DECISION = Enum(LeaveDecision, name="leave_decision")


class LeaveRequest(Base):
    __tablename__ = "leave_requests"
    __table_args__ = (
        Index("ix_leave_status_created", "status", "created_at"),
        Index("ix_leave_requester", "requester_user_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    requester_user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    from_date: Mapped[date] = mapped_column(Date)
    to_date: Mapped[date] = mapped_column(Date)
    reason: Mapped[str] = mapped_column(String)
    status: Mapped[LeaveStatus] = mapped_column(
        Enum(LeaveStatus, name="leave_status"), default=LeaveStatus.SUBMITTED, server_default="SUBMITTED"
    )

    first_approver_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    first_decision: Mapped[LeaveDecision | None] = mapped_column(_LEAVE_DECISION, nullable=True)
    first_decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    first_note: Mapped[str | None] = mapped_column(String, nullable=True)

    second_approver_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    second_decision: Mapped[LeaveDecision | None] = mapped_column(_LEAVE_DECISION, nullable=True)
    second_decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    second_note: Mapped[str | None] = mapped_column(String, nullable=True)

    # --- the official BGSCET form -------------------------------------------
    # Which of the printed options is being applied for: the form lists Casual
    # Leave / Permission / OOD / RH / LOP and strikes off the rest, so this is a
    # selection among them rather than a free leave-type vocabulary.
    leave_kind: Mapped[str | None] = mapped_column(String, nullable=True)
    # The form's "Credit" cell. A free string, because the sheet accepts one.
    credit: Mapped[str | None] = mapped_column(String, nullable=True)
    # "Alternate Arrangements: (For Department purpose)" — a name, then a table
    # of Date / Staff Name / Class / Time / Remarks. Stored as JSON because the
    # rows are a printed table with no life outside this document; giving them
    # their own table would imply queries nobody makes.
    alt_name: Mapped[str | None] = mapped_column(String, nullable=True)
    alt_rows: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # When the applicant signed. The form's SIGNATURE OF STAFF block prints from
    # this and the requester's name; a request with no timestamp is a draft.
    signed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
