"""Admin-authored interview questions, per track and phase - the question bank
the free-style interviewer weaves in.

THE INTERVIEWER STAYS FREE-STYLE. app/interview_matrix.py's Specialization
already carries `question_bank`, and build_instructions renders it as "a guide
to coverage, not a script: rephrase each naturally, follow up on what the
student actually says". Until now only the voice platform filled that field,
from its own UG/PG catalogue; the interviewer students actually use ran with it
empty. These rows fill it for the four live tracks. Nothing about the phase
machine, the persona or the word gate changes: an admin decides WHAT gets
covered, the model decides HOW it is asked.

`track` and `phase` are plain strings, validated in the router against
SPECIALIZATIONS and InterviewPhase - the catalogue of tracks is code, so a PG
enum would turn a fifth track into a type migration (the auth_tokens.purpose
choice). `position` is the order the questions are worked in; the prompt says
"in this order", so it is load-bearing, not cosmetic.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


class InterviewBankQuestion(Base):
    __tablename__ = "interview_bank_questions"
    __table_args__ = (Index("ix_interview_bank_track_position", "track", "position"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    track: Mapped[str] = mapped_column(String)  # a SPECIALIZATIONS key: hr / dm / ba / fa
    phase: Mapped[str] = mapped_column(String)  # opening / probing / deep_dive / wrap_up
    text: Mapped[str] = mapped_column(String)
    position: Mapped[int] = mapped_column(Integer)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    #: Audit stamp, a plain column like Registration.reviewed_by_id - not an FK,
    #: so deleting the author never deletes the question.
    created_by_user_id: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
