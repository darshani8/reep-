"""The append-only record of what happened, and the work it queued.

Audit events, the transactional outbox, durable domain jobs, and the
idempotency-key store. Every external mutation writes an audit row AND an
outbox row in the SAME transaction as the domain change — see
`app/platform/audit_trail.py`, the only module that should write here.

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


class JobStatus(str, enum.Enum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"

class DeliveryStatus(str, enum.Enum):
    PENDING = "PENDING"
    DELIVERED = "DELIVERED"
    FAILED = "FAILED"

class AuditEvent(Base):
    __tablename__ = "redesign_audit_events"
    __table_args__ = (
        Index("ix_redesign_audit_tenant_time", "tenant_id", "occurred_at"),
        Index("ix_redesign_audit_entity_time", "entity_type", "entity_id", "occurred_at"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    tenant_id: Mapped[str | None] = mapped_column(ForeignKey("redesign_tenants.id", ondelete="SET NULL"), nullable=True)
    actor_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    actor_type: Mapped[str] = mapped_column(String(30), nullable=False, default="USER", server_default="USER")
    request_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    correlation_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    entity_type: Mapped[str] = mapped_column(String(100), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(100), nullable=False)
    action: Mapped[str] = mapped_column(String(100), nullable=False)
    before_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    after_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    metadata_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

class OutboxEvent(Base):
    __tablename__ = "redesign_outbox_events"
    __table_args__ = (
        Index("ix_redesign_outbox_delivery", "status", "available_at"),
        Index("ix_redesign_outbox_aggregate", "aggregate_type", "aggregate_id"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    tenant_id: Mapped[str | None] = mapped_column(ForeignKey("redesign_tenants.id", ondelete="SET NULL"), nullable=True)
    event_type: Mapped[str] = mapped_column(String(120), nullable=False)
    aggregate_type: Mapped[str] = mapped_column(String(100), nullable=False)
    aggregate_id: Mapped[str] = mapped_column(String(100), nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    status: Mapped[DeliveryStatus] = mapped_column(Enum(DeliveryStatus, name="redesign_delivery_status"), nullable=False, default=DeliveryStatus.PENDING, server_default="PENDING")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    event_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    routing_key: Mapped[str] = mapped_column(String(80), nullable=False, default="default", server_default="default")
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=8, server_default="8")
    lease_owner: Mapped[str | None] = mapped_column(String(120), nullable=True)
    lease_token: Mapped[str | None] = mapped_column(String(64), nullable=True)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dead_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dead_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    published_message_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

class DomainJob(Base):
    __tablename__ = "redesign_domain_jobs"
    __table_args__ = (Index("ix_redesign_job_queue", "status", "available_at"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    tenant_id: Mapped[str | None] = mapped_column(ForeignKey("redesign_tenants.id", ondelete="SET NULL"), nullable=True)
    job_type: Mapped[str] = mapped_column(String(100), nullable=False)
    subject_type: Mapped[str] = mapped_column(String(100), nullable=False)
    subject_id: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[JobStatus] = mapped_column(Enum(JobStatus, name="redesign_job_status"), nullable=False, default=JobStatus.QUEUED, server_default="QUEUED")
    progress: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=8, server_default="8")
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    lease_owner: Mapped[str | None] = mapped_column(String(120), nullable=True)
    lease_token: Mapped[str | None] = mapped_column(String(64), nullable=True)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dead_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dead_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    result_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    error_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

class ApiIdempotencyKey(Base):
    __tablename__ = "redesign_api_idempotency_keys"
    __table_args__ = (UniqueConstraint("principal_id", "route", "key", name="uq_redesign_idempotency_principal_route_key"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    principal_id: Mapped[str] = mapped_column(String(100), nullable=False)
    route: Mapped[str] = mapped_column(String(200), nullable=False)
    key: Mapped[str] = mapped_column(String(200), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    response_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    response_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reserved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    reservation_token: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
