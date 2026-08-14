"""Auth-critical models — the first slice of the fresh Python schema.

This is deliberately small: enough to authenticate and mint the same session
payload the Next.js app does (userId, email, name, role, studentId?, mentorId?).
The remaining ~35 models are ported in later phases (see
docs/python-fastapi-migration.md).
"""

import enum
import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Enum, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


class Role(str, enum.Enum):
    STUDENT = "STUDENT"
    MENTOR = "MENTOR"
    DIRECTOR = "DIRECTOR"
    ADMIN = "ADMIN"


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String, unique=True, index=True)
    name: Mapped[str] = mapped_column(String)
    role: Mapped[Role] = mapped_column(Enum(Role, name="role"), default=Role.STUDENT)
    # Format: "scrypt:<salt_hex>:<digest_hex>" — identical to the Next.js app,
    # so migrated hashes verify without a reset.
    password_hash: Mapped[str] = mapped_column(String)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    student: Mapped["Student | None"] = relationship(back_populates="user", uselist=False)
    mentor: Mapped["Mentor | None"] = relationship(back_populates="user", uselist=False)
    login_days: Mapped[list["LoginDay"]] = relationship(back_populates="user")


class Student(Base):
    __tablename__ = "students"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), unique=True)

    user: Mapped[User] = relationship(back_populates="student")


class Mentor(Base):
    __tablename__ = "mentors"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), unique=True)

    user: Mapped[User] = relationship(back_populates="mentor")


class LoginDay(Base):
    """One row per user per calendar day they signed in — feeds the streak.

    The day is the local calendar date (matching the Next.js app), so an evening
    sign-in is not bucketed onto the next UTC day.
    """

    __tablename__ = "login_days"
    __table_args__ = (UniqueConstraint("user_id", "day", name="uq_login_day"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    day: Mapped[date] = mapped_column(Date)

    user: Mapped[User] = relationship(back_populates="login_days")
