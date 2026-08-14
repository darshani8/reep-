"""SWOC board — strengths / weaknesses / opportunities / challenges, one entry
per observation, attributed to a viewpoint (ported from Prisma `SwocEntry`).
The board is deliberately un-averaged: disagreement between viewpoints is itself
the finding, so every entry keeps its source.
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


class SwocSource(str, enum.Enum):
    PLACEMENT = "PLACEMENT"
    MENTOR = "MENTOR"
    PM = "PM"


class SwocKind(str, enum.Enum):
    STRENGTH = "STRENGTH"
    WEAKNESS = "WEAKNESS"
    OPPORTUNITY = "OPPORTUNITY"
    CHALLENGE = "CHALLENGE"


class SwocEntry(Base):
    __tablename__ = "swoc_entries"
    __table_args__ = (
        Index("ix_swoc_student_kind", "student_id", "kind"),
        Index("ix_swoc_student_source", "student_id", "source"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    student_id: Mapped[str] = mapped_column(ForeignKey("students.id", ondelete="CASCADE"))
    source: Mapped[SwocSource] = mapped_column(Enum(SwocSource, name="swoc_source"))
    kind: Mapped[SwocKind] = mapped_column(Enum(SwocKind, name="swoc_kind"))
    text: Mapped[str] = mapped_column(String)
    # 1-5, how strongly the author holds this; orders a quadrant.
    weight: Mapped[int] = mapped_column(Integer, default=3, server_default="3")
    author_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
