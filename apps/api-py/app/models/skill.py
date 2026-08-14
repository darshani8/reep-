"""Skills — a shared catalogue (`Skill`) and the per-student join (`StudentSkill`)
that carries proficiency and whether a mentor verified it (ported from Prisma).
The catalogue exists so "MS Excel" and "Advanced Excel" match one skill, which is
what makes a job-match percentage meaningful.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    ARRAY,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


class Skill(Base):
    __tablename__ = "skills"
    __table_args__ = (Index("ix_skills_category", "category"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    slug: Mapped[str] = mapped_column(String, unique=True)  # stable machine key
    name: Mapped[str] = mapped_column(String)
    category: Mapped[str] = mapped_column(String)
    aliases: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StudentSkill(Base):
    __tablename__ = "student_skills"
    __table_args__ = (
        UniqueConstraint("student_id", "skill_id", name="uq_student_skill"),
        Index("ix_student_skills_skill", "skill_id"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    student_id: Mapped[str] = mapped_column(ForeignKey("students.id", ondelete="CASCADE"))
    skill_id: Mapped[str] = mapped_column(ForeignKey("skills.id", ondelete="CASCADE"))
    # 1 Aware · 2 Beginner · 3 Working · 4 Proficient · 5 Expert.
    level: Mapped[int] = mapped_column(Integer, default=3, server_default="3")
    verified: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    evidence_upload_id: Mapped[str | None] = mapped_column(String, nullable=True)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    skill: Mapped[Skill] = relationship()
