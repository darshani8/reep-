"""Auth-critical models — the first slice of the fresh Python schema.

This is deliberately small: enough to authenticate and mint the same session
payload the Next.js app does (userId, email, name, role, studentId?, mentorId?).
The remaining ~35 models are ported in later phases (see
docs/python-fastapi-migration.md).
"""

import enum
import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Enum, Float, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


class Role(str, enum.Enum):
    STUDENT = "STUDENT"
    MENTOR = "MENTOR"
    DIRECTOR = "DIRECTOR"
    ADMIN = "ADMIN"
    # A graduate. No Student/Mentor row, no staff scope: they see their own
    # profile and the jobs sheet, nothing of the live cohort's records.
    ALUMNI = "ALUMNI"


class Stage(str, enum.Enum):
    """The REEP developmental stages, in order."""

    REBOOT = "REBOOT"
    EXCEL = "EXCEL"
    EXCEL_ADVANCED = "EXCEL_ADVANCED"
    ELEVATE = "ELEVATE"


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String, unique=True, index=True)
    name: Mapped[str] = mapped_column(String)
    role: Mapped[Role] = mapped_column(Enum(Role, name="role"), default=Role.STUDENT)
    # Format: "scrypt:<salt_hex>:<digest_hex>" — identical to the Next.js app,
    # so migrated hashes verify without a reset.
    password_hash: Mapped[str] = mapped_column(String)
    # THE GOOGLE PRINCIPAL THIS ROW IS PINNED TO. `email` is how a sign-in FINDS
    # a row; `sub` is what proves it is the same person as last time. An
    # institutional address is a lease, not an identity — the college re-issues
    # 1mp25mdm01@ to a new intake — and with sign-in keyed on the email string
    # alone the new holder inherited the previous student's marks, uploads and
    # mentor notes through a completely valid Google login, silently. Pinned on
    # the first Google sign-in (NULL until then, so every already-seeded roster
    # row keeps working) and compared on every one after; a mismatch is refused
    # in app/routers/auth.py rather than reconciled, because the only safe way
    # to hand a row to a new person is for a human to clear this column.
    #
    # UNIQUE so the same Google account cannot end up pinned to two roster rows.
    # Nullable + unique is the right pair in Postgres: NULLs are not compared,
    # so any number of un-pinned rows coexist.
    google_sub: Mapped[str | None] = mapped_column(String, unique=True, nullable=True)
    # Bumped on logout; carried in the session JWT and compared on the way back
    # in. See app/security.py — this column is the whole of the revocation
    # story, including its honest limits.
    token_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    # Institutional identity, printed on the official leave form as synced
    # fields the applicant cannot type over. Nullable because the roster does not
    # carry them for every row yet; the form says "not on record" rather than
    # inventing a department.
    designation: Mapped[str | None] = mapped_column(String, nullable=True)
    department: Mapped[str | None] = mapped_column(String, nullable=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    student: Mapped["Student | None"] = relationship(back_populates="user", uselist=False)
    mentor: Mapped["Mentor | None"] = relationship(back_populates="user", uselist=False)
    login_days: Mapped[list["LoginDay"]] = relationship(back_populates="user")


class Student(Base):
    __tablename__ = "students"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), unique=True)
    # Nullable / server-defaulted so the column adds cleanly onto existing rows.
    usn: Mapped[str | None] = mapped_column(String, unique=True, nullable=True)
    # Both indexed (b41c9e2d7f05): cohort_id is what leaderboards rank a cohort
    # by, mentor_id is what rule 2's staff-scope gate filters by — the two
    # hottest scope columns in the app, seq-scanned until the 2026-08 audit.
    cohort_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)  # FK to Cohort later
    mentor_id: Mapped[str | None] = mapped_column(ForeignKey("mentors.id"), nullable=True, index=True)
    current_stage: Mapped[Stage] = mapped_column(
        Enum(Stage, name="stage"), default=Stage.EXCEL, server_default="EXCEL"
    )
    current_semester: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    enrolled_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    weekly_hour_target: Mapped[float] = mapped_column(Float, default=12, server_default="12")

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
