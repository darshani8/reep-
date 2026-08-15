"""Every message the mailer was asked to send, keyed so it is asked only once
(ported from Prisma `MailLog`).

`dedupe_key` is the whole point of the table. "Weekly job alert" means one email
on Monday, but the sending job can be re-run by a retry, a second worker, or an
operator unsure the first run worked — each of those another email to a student
who now ignores all of them. The caller builds a key from the message and its
period (`job-alert:<studentId>:2026-W32`) and the unique index turns the second
attempt into a caught conflict instead of a delivery.

`kind` is free text, not an enum, on purpose: the catalogue of messages grows
with the product, and a new template should not need a migration to be sent.
`mail_status` is new to the Python schema, so autogenerate creates it cleanly.
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


class MailStatus(str, enum.Enum):
    SENT = "SENT"
    FAILED = "FAILED"
    # Suppressed on purpose — a dedupe hit, or a recipient who has opted out.
    SUPPRESSED = "SUPPRESSED"


class MailLog(Base):
    __tablename__ = "mail_logs"
    __table_args__ = (
        Index("ix_maillog_kind_sent", "kind", "sent_at"),
        Index("ix_maillog_recipient_sent", "recipient", "sent_at"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    kind: Mapped[str] = mapped_column(String)  # free text, e.g. "job-alert"
    recipient: Mapped[str] = mapped_column(String)
    dedupe_key: Mapped[str] = mapped_column(String, unique=True)
    subject: Mapped[str | None] = mapped_column(String, nullable=True)
    status: Mapped[MailStatus] = mapped_column(
        Enum(MailStatus, name="mail_status"),
        default=MailStatus.SENT,
        server_default="SENT",
    )
    # The driver's complaint, when status is FAILED.
    error: Mapped[str | None] = mapped_column(String, nullable=True)
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
