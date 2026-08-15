"""Mentor notes — a mentor's write-up of a meeting with a mentee (ported from
Prisma `MentorNote`). meeting_at (when it happened) is distinct from created_at
(when it was typed), since notes are often written up later.
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


class MentorAction(str, enum.Enum):
    NONE = "NONE"
    FLAGGED = "FLAGGED"
    NUDGE_SENT = "NUDGE_SENT"
    ONE_ON_ONE_SCHEDULED = "ONE_ON_ONE_SCHEDULED"


class MentorNote(Base):
    __tablename__ = "mentor_notes"
    __table_args__ = (
        Index("ix_mentornote_student_created", "student_id", "created_at"),
        Index("ix_mentornote_student_meeting", "student_id", "meeting_at"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    mentor_id: Mapped[str] = mapped_column(ForeignKey("mentors.id", ondelete="CASCADE"))
    student_id: Mapped[str] = mapped_column(ForeignKey("students.id", ondelete="CASCADE"))
    note_text: Mapped[str] = mapped_column(String)
    linked_action: Mapped[MentorAction] = mapped_column(
        Enum(MentorAction, name="mentor_action"), default=MentorAction.NONE, server_default="NONE"
    )
    meeting_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
