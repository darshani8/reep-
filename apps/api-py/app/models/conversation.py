"""Server-owned assistant conversations (Assistant V2 Phase A).

The security spine of the assistant: a conversation belongs to exactly one user
(owner_user_id) and is ALWAYS resolved from the authenticated session — never
from a client-chosen id. This is what closes the P0 where the client picked
`assistant-${userId}` and could read/write another user's thread.

Conversation reuses the existing `role` PG enum (create_type=False). Messages
carry a per-turn channel (text|voice) so one thread can mix chat and voice, and
an optional provider_turn_id so a streaming/voice provider's retries dedup.
"""

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..db import Base
from .user import Role


def _uuid() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    # Python-side default so every row gets a distinct, microsecond-precise
    # timestamp — messages within one request order deterministically.
    return datetime.now(timezone.utc)


class Conversation(Base):
    __tablename__ = "conversations"
    __table_args__ = (
        Index("ix_conversation_owner_activity", "owner_user_id", "last_activity_at"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    owner_user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE")
    )
    role: Mapped[Role] = mapped_column(Enum(Role, name="role", create_type=False))
    channel: Mapped[str] = mapped_column(
        String, default="text", server_default="text"
    )  # 'text' | 'voice' | 'mixed'
    consent_state: Mapped[str] = mapped_column(
        String, default="none", server_default="none"
    )  # 'none' | 'text' | 'voice'
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, server_default=func.now()
    )
    last_activity_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, server_default=func.now()
    )
    retention_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )  # soft-clear

    messages: Mapped[list["Message"]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan"
    )


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        Index("ix_message_conversation_created", "conversation_id", "created_at"),
        UniqueConstraint(
            "conversation_id", "provider_turn_id", name="uq_message_provider_turn"
        ),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE")
    )
    sender: Mapped[str] = mapped_column(String)  # 'user' | 'assistant'
    channel: Mapped[str] = mapped_column(
        String, default="text", server_default="text"
    )  # 'text' | 'voice'
    content: Mapped[str] = mapped_column(String)
    is_final: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default="true"
    )
    provider_turn_id: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, server_default=func.now()
    )

    conversation: Mapped[Conversation] = relationship(back_populates="messages")
