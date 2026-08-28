"""Companion registry and permission-scoped memory.

A companion is a named, role-configured assistant. Memory is deliberately kept
in one table so private and centralized entries share the same audit, indexing,
and pgvector path. Scope and ownership are enforced by the API, not by a
client-provided session key.
"""

import enum
import uuid
from datetime import datetime, timezone

from pgvector.sqlalchemy import Vector
from sqlalchemy import CheckConstraint, DateTime, Enum, ForeignKey, Index, String, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(timezone.utc)


class CompanionStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"


class MemoryScope(str, enum.Enum):
    PRIVATE = "PRIVATE"
    SHARED = "SHARED"


class MemoryStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    APPROVED = "APPROVED"
    ARCHIVED = "ARCHIVED"


class Companion(Base):
    __tablename__ = "companions"
    __table_args__ = (
        UniqueConstraint("slug", name="uq_companion_slug"),
        Index("ix_companion_status", "status"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    slug: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    role_key: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    system_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    capabilities: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")
    # REEP user roles allowed to invoke this companion.
    allowed_roles: Mapped[list] = mapped_column(
        JSONB,
        default=lambda: ["STUDENT", "MENTOR", "DIRECTOR", "ADMIN"],
        server_default='["STUDENT", "MENTOR", "DIRECTOR", "ADMIN"]',
    )
    status: Mapped[CompanionStatus] = mapped_column(
        Enum(CompanionStatus, name="companion_status"),
        default=CompanionStatus.ACTIVE,
        server_default="ACTIVE",
        nullable=False,
    )
    created_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, server_default=func.now(), nullable=False
    )

    memories: Mapped[list["CompanionMemory"]] = relationship(
        back_populates="companion", cascade="all, delete-orphan", passive_deletes=True
    )


class CompanionMemory(Base):
    __tablename__ = "companion_memories"
    __table_args__ = (
        CheckConstraint(
            "(scope = 'PRIVATE' AND companion_id IS NOT NULL AND owner_user_id IS NOT NULL) OR "
            "(scope = 'SHARED' AND companion_id IS NULL AND owner_user_id IS NULL)",
            name="ck_companion_memory_scope_ownership",
        ),
        Index("ix_companion_memory_lookup", "companion_id", "scope", "status", "created_at"),
        Index("ix_companion_memory_owner", "owner_user_id", "companion_id", "status"),
        Index(
            "ix_companion_memory_fts",
            text("to_tsvector('english', content)"),
            postgresql_using="gin",
        ),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    # NULL companion_id means a centralized entry available to every companion.
    companion_id: Mapped[str | None] = mapped_column(
        ForeignKey("companions.id", ondelete="CASCADE"), nullable=True
    )
    scope: Mapped[MemoryScope] = mapped_column(
        Enum(MemoryScope, name="memory_scope"), nullable=False
    )
    status: Mapped[MemoryStatus] = mapped_column(
        Enum(MemoryStatus, name="memory_status"),
        default=MemoryStatus.DRAFT,
        server_default="DRAFT",
        nullable=False,
    )
    title: Mapped[str] = mapped_column(String, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    # Private memory is owned by a user. Shared memory has no owner.
    owner_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    created_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    approved_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    metadata_json: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    # Dimensionless on purpose, matching the existing knowledge store. The
    # embedding provider can be selected without a schema migration.
    embedding: Mapped[list[float] | None] = mapped_column(Vector(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, server_default=func.now(), nullable=False
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    companion: Mapped[Companion | None] = relationship(back_populates="memories")
