"""Placement criteria (ported from Prisma `PlacementCriteria`). Director-set
academic gates the placement funnel reads; one set is `active`. A job's per-
posting override wins; otherwise these defaults apply.
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


class PlacementCriteria(Base):
    __tablename__ = "placement_criteria"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String, default="Default", server_default="Default")
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    min_reep_completion_pct: Mapped[float] = mapped_column(Float, default=80, server_default="80")
    require_core_certs: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    min_attendance_pct: Mapped[float] = mapped_column(Float, default=85, server_default="85")
    min_cert_completion_pct: Mapped[float] = mapped_column(Float, default=75, server_default="75")
    min_cgpa: Mapped[float] = mapped_column(Float, default=6.0, server_default="6.0")
    max_live_backlogs: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    max_gap_months: Mapped[int] = mapped_column(Integer, default=24, server_default="24")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
