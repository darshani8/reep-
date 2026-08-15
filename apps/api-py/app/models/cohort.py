"""Cohort — an admissions batch (ported from Prisma). degree_level (UG/PG) is an
admissions fact that gates which vacancies the cohort sees; it reuses the
existing `degree_level` PG enum (create_type=False).
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, String, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base
from .job import DegreeLevel


def _uuid() -> str:
    return uuid.uuid4().hex


class Cohort(Base):
    __tablename__ = "cohorts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    code: Mapped[str] = mapped_column(String, unique=True)  # e.g. MBA-2026-B
    name: Mapped[str] = mapped_column(String)
    batch_label: Mapped[str] = mapped_column(String)  # e.g. 2024-26
    degree_level: Mapped[DegreeLevel] = mapped_column(
        Enum(DegreeLevel, name="degree_level", create_type=False)
    )
    start_date: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    end_date: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
