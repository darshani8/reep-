"""Jobs board — postings (`Job`) and self-reported applications
(`JobApplication`), ported from Prisma. required_skills is denormalised onto the
row (canonical Skill.slug values) so the match percentage is one query, not a
fan-out. Per-posting min_cgpa / max_live_backlogs override the default criteria.
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    ARRAY,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


class DegreeLevel(str, enum.Enum):
    UG = "UG"
    PG = "PG"


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    source_ref: Mapped[str | None] = mapped_column(String, unique=True, nullable=True)
    title: Mapped[str] = mapped_column(String)
    company: Mapped[str] = mapped_column(String)
    degree_level: Mapped[DegreeLevel] = mapped_column(Enum(DegreeLevel, name="degree_level"))
    location: Mapped[str | None] = mapped_column(String, nullable=True)
    apply_url: Mapped[str | None] = mapped_column(String, nullable=True)
    description: Mapped[str] = mapped_column(String, default="", server_default="")
    required_skills: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    posted_on: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    closes_on: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Per-posting eligibility overrides; null => use the default criteria.
    min_cgpa: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_live_backlogs: Mapped[int | None] = mapped_column(Integer, nullable=True)
    import_run_id: Mapped[str | None] = mapped_column(String, nullable=True)  # FK to JobImportRun later
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class JobApplication(Base):
    __tablename__ = "job_applications"
    __table_args__ = (
        UniqueConstraint("student_id", "job_id", name="uq_job_application"),
        Index("ix_jobapp_job", "job_id"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    student_id: Mapped[str] = mapped_column(ForeignKey("students.id", ondelete="CASCADE"))
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"))
    applied_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    self_reported: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    notes: Mapped[str | None] = mapped_column(String, nullable=True)
