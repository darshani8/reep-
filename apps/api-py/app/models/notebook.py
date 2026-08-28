"""The mentor's digital notebook — entries, revisions, actions, attachments.

`NotebookVisibility` is the load-bearing one: PRIVATE_STAFF text must never
reach a student endpoint, an export, a log, an analytics payload or AI context.

`RecordStatus` lives here rather than in `knowledge_versioned.py` because the
notebook is its primary user and the Postgres enum type it maps to is named
`redesign_notebook_status` — `KnowledgeDocumentVersion` reuses both. That
sharing predates this split and is preserved exactly; renaming the type would
be a migration, not a file move.

Split out of the former `models/redesign.py`. Table names are unchanged.
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    Float,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base



def _uuid() -> str:
    return uuid.uuid4().hex


class RecordStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    PUBLISHED = "PUBLISHED"
    ARCHIVED = "ARCHIVED"

class NotebookVisibility(str, enum.Enum):
    PRIVATE_STAFF = "PRIVATE_STAFF"
    STUDENT_VISIBLE = "STUDENT_VISIBLE"

class NotebookEntryType(str, enum.Enum):
    MEETING = "MEETING"
    ACADEMIC_REVIEW = "ACADEMIC_REVIEW"
    WELLBEING = "WELLBEING"
    PLACEMENT = "PLACEMENT"
    ATTENDANCE = "ATTENDANCE"
    REFERRAL = "REFERRAL"
    CUSTOM = "CUSTOM"

class ActionStatus(str, enum.Enum):
    OPEN = "OPEN"
    IN_PROGRESS = "IN_PROGRESS"
    DONE = "DONE"
    CANCELLED = "CANCELLED"

class ActionPriority(str, enum.Enum):
    LOW = "LOW"
    NORMAL = "NORMAL"
    HIGH = "HIGH"
    URGENT = "URGENT"

class MentorNotebookEntry(Base):
    __tablename__ = "redesign_mentor_notebook_entries"
    __table_args__ = (
        Index("ix_redesign_notebook_student_time", "student_id", "meeting_at"),
        Index("ix_redesign_notebook_student_visibility", "student_id", "visibility", "status"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    student_id: Mapped[str] = mapped_column(ForeignKey("students.id", ondelete="CASCADE"), nullable=False)
    author_user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    mentor_id: Mapped[str | None] = mapped_column(ForeignKey("mentors.id", ondelete="SET NULL"), nullable=True)
    entry_type: Mapped[NotebookEntryType] = mapped_column(Enum(NotebookEntryType, name="redesign_notebook_entry_type"), nullable=False, default=NotebookEntryType.MEETING, server_default="MEETING")
    template_key: Mapped[str] = mapped_column(String(80), nullable=False, default="meeting", server_default="meeting")
    template_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    structured_data: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    visibility: Mapped[NotebookVisibility] = mapped_column(Enum(NotebookVisibility, name="redesign_notebook_visibility"), nullable=False, default=NotebookVisibility.PRIVATE_STAFF, server_default="PRIVATE_STAFF")
    status: Mapped[RecordStatus] = mapped_column(Enum(RecordStatus, name="redesign_notebook_status"), nullable=False, default=RecordStatus.DRAFT, server_default="DRAFT")
    meeting_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    client_request_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

class MentorNotebookAction(Base):
    __tablename__ = "redesign_mentor_notebook_actions"
    __table_args__ = (Index("ix_redesign_notebook_action_student_due", "student_id", "status", "due_at"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    entry_id: Mapped[str | None] = mapped_column(ForeignKey("redesign_mentor_notebook_entries.id", ondelete="SET NULL"), nullable=True)
    student_id: Mapped[str] = mapped_column(ForeignKey("students.id", ondelete="CASCADE"), nullable=False)
    owner_user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[ActionStatus] = mapped_column(Enum(ActionStatus, name="redesign_action_status"), nullable=False, default=ActionStatus.OPEN, server_default="OPEN")
    priority: Mapped[ActionPriority] = mapped_column(Enum(ActionPriority, name="redesign_action_priority"), nullable=False, default=ActionPriority.NORMAL, server_default="NORMAL")
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

class MentorNotebookEntryRevision(Base):
    __tablename__ = "redesign_mentor_notebook_entry_revisions"
    __table_args__ = (UniqueConstraint("entry_id", "version", name="uq_redesign_notebook_revision"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    entry_id: Mapped[str] = mapped_column(ForeignKey("redesign_mentor_notebook_entries.id", ondelete="CASCADE"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    author_user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    snapshot_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

class MentorNotebookAttachment(Base):
    __tablename__ = "redesign_mentor_notebook_attachments"
    __table_args__ = (Index("ix_redesign_notebook_attachment_entry", "entry_id"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    entry_id: Mapped[str] = mapped_column(ForeignKey("redesign_mentor_notebook_entries.id", ondelete="CASCADE"), nullable=False)
    uploaded_by_user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(120), nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="PENDING", server_default="PENDING")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
