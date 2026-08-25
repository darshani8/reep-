"""Alumni profile — created by the alumnus themselves on first sign-in.

One row per ALUMNI user (unique user_id). The row existing at all is what the
client's first-login flow branches on: no row => show the create-profile form,
row => show the profile. The resume travels through the same hardened document_store
as student uploads (magic-byte sniffing, random stored name); only its metadata
lives here, and the four resume_* columns are nullable together — a profile
without a resume is a real profile, and replacing the resume swaps all four in
one update.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


class AlumniProfile(Base):
    __tablename__ = "alumni_profiles"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True
    )

    # Where they work now — the one field the first-login form requires.
    company: Mapped[str] = mapped_column(String)
    designation: Mapped[str | None] = mapped_column(String, nullable=True)
    graduation_year: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Current resume: metadata only, bytes in the document_store under resume_stored_name.
    resume_original_name: Mapped[str | None] = mapped_column(String, nullable=True)
    resume_stored_name: Mapped[str | None] = mapped_column(String, unique=True, nullable=True)
    resume_mime_type: Mapped[str | None] = mapped_column(String, nullable=True)
    resume_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
