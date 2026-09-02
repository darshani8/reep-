"""One-time codes emailed for the password path (create / reset / change).

A row exists ONLY for an enrolled address on the college domain: the request
endpoint answers 202 for everyone and writes nothing for anyone else, so the
table cannot be grown by probing, and a row is itself proof that the address
passed the roster and domain fences at request time.

`code_hash`, never the code: HMAC-SHA256 keyed on a value derived from
AUTH_SECRET (app/local_auth.py:otp_hash), with the message bound to
user_id:purpose. A 6-digit code is 20 bits, so a plain hash of it is a lookup
table; the keyed hash means a copy of this table without the secret verifies
nothing, and a code can never verify against a row it was not issued for. Brute
force is stopped by `attempts` and `expires_at`, not by hash cost — a slow hash
here would be a ~30 ms unauthenticated CPU lever per guess for no gain over a
keyed MAC.

"Live" is derived, never stored: consumed_at IS NULL AND attempts < the cap AND
expires_at > now(). A status column would be a second source of truth for a
fact three columns already state.

ON DELETE CASCADE on purpose. tests/conftest.py's make_user and the roster
fixtures tear users down with `delete(User)` after LoginDay/Student; a plain
foreign key would make any fixture that issued a code fail at teardown, and an
account removed from the roster must not leave its codes behind.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


class EmailOtp(Base):
    __tablename__ = "auth_email_otps"
    __table_args__ = (Index("ix_auth_email_otps_user_created", "user_id", "created_at"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # "password" today. "login" is RESERVED for the optional OTP-on-every-login
    # flag (designed, not built) and must never be reused: a password-purpose
    # code must not be spendable as a login step, and the purpose is what the
    # hash is bound to.
    purpose: Mapped[str] = mapped_column(String(16), nullable=False)
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # created_at + OTP_TTL_SECONDS. A newer request sets this to now() on the
    # older live rows rather than deleting them, so the per-hour count and the
    # resend cooldown still see the request they are supposed to count.
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
