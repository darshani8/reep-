"""Alerts — rule-triggered flags on a student that the mentor dashboard surfaces
(ported from Prisma `Alert`). context snapshots the values that fired the rule,
for auditability; resolved_at/resolved_by close it.
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


class AlertRuleKey(str, enum.Enum):
    NO_CHECKIN_N_DAYS = "NO_CHECKIN_N_DAYS"
    PACE_BELOW_THRESHOLD = "PACE_BELOW_THRESHOLD"
    ATTENDANCE_BELOW_THRESHOLD = "ATTENDANCE_BELOW_THRESHOLD"
    CERT_OVERDUE = "CERT_OVERDUE"
    LOW_FOCUS_QUALITY = "LOW_FOCUS_QUALITY"


class AlertSeverity(str, enum.Enum):
    INFO = "INFO"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"


class Alert(Base):
    __tablename__ = "alerts"
    __table_args__ = (
        Index("ix_alert_student_resolved", "student_id", "resolved_at"),
        Index("ix_alert_rule", "rule_triggered"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    student_id: Mapped[str] = mapped_column(ForeignKey("students.id", ondelete="CASCADE"))
    rule_triggered: Mapped[AlertRuleKey] = mapped_column(Enum(AlertRuleKey, name="alert_rule_key"))
    severity: Mapped[AlertSeverity] = mapped_column(
        Enum(AlertSeverity, name="alert_severity"), default=AlertSeverity.WARNING, server_default="WARNING"
    )
    message: Mapped[str] = mapped_column(String)
    context: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    triggered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_by: Mapped[str | None] = mapped_column(String, nullable=True)
