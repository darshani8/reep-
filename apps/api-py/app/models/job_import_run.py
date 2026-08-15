"""Audit trail for a bulk job-vacancy import (ported from Prisma `JobImportRun`).

Two imports of the same sheet, or a good sheet with three bad rows, are different
problems, and only the row that recorded the counts and per-row errors tells them
apart. `errors` is a JSONB list of {row, column, message} so a partly-good sheet
still imports and the operator is told exactly which lines were rejected.

`uploaded_by_id` is a plain column (audit stamp), as on Upload — the run is not
queried by who ran it.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


class JobImportRun(Base):
    __tablename__ = "job_import_runs"
    __table_args__ = (Index("ix_jobimport_started", "started_at"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    file_name: Mapped[str | None] = mapped_column(String, nullable=True)
    uploaded_by_id: Mapped[str | None] = mapped_column(String, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    rows_seen: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    rows_created: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    rows_updated: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # [{row, column, message}] — per-row rejections.
    errors: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")
