"""Institution boundary — a tenant, and who belongs to it.

Split out of the former `models/redesign.py`, which held four unrelated
concerns under a project-phase name. Table names are unchanged (`redesign_*`),
so this is a code move with no migration behind it.
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


class MembershipRole(str, enum.Enum):
    STUDENT = "STUDENT"
    MENTOR = "MENTOR"
    DIRECTOR = "DIRECTOR"
    ADMIN = "ADMIN"

class Tenant(Base):
    __tablename__ = "redesign_tenants"
    __table_args__ = (UniqueConstraint("slug", name="uq_redesign_tenant_slug"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    slug: Mapped[str] = mapped_column(String(80), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="ACTIVE", server_default="ACTIVE")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

class TenantMembership(Base):
    __tablename__ = "redesign_tenant_memberships"
    __table_args__ = (
        UniqueConstraint("tenant_id", "user_id", name="uq_redesign_membership_tenant_user"),
        Index("ix_redesign_membership_user_role", "user_id", "role"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("redesign_tenants.id", ondelete="CASCADE"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    role: Mapped[MembershipRole] = mapped_column(Enum(MembershipRole, name="redesign_membership_role"), nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="ACTIVE", server_default="ACTIVE")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
