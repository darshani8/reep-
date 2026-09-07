"""A link that works once and then stops — activation and password reset.

ONE TABLE, TWO JOBS (and a third is a row, not a migration). Setting a first
password and resetting a forgotten one are the same mechanism: a secret in an
email, a hash of it here, consumed exactly once. `purpose` is a plain String
so a future "confirm new email address" is `purpose="email_change"` and no
`CREATE TYPE`. Registration's own confirmation link is NOT here — it predates
this table and hangs off `registrations`, which is not a user yet; see
`EmailVerification` in registration.py.

THREE RULES THAT MAKE IT SAFE, from the agreed plan (docs/prototypes/.../passwords.html):

  1. THE LINK IS STORED HASHED, NEVER IN PLAIN TEXT. Same reason passwords are:
     a leaked dump of this table yields hashes, not a working link into every
     account with a pending reset. SHA-256, not scrypt — the token is 256
     random bits, not a guessable phrase, so a slow KDF buys nothing and only
     slows every click.
  2. USED ONCE, AND THE CHECK IS ATOMIC. `UPDATE ... WHERE consumed_at IS NULL`
     and act on the row count — the same trick interview finalisation uses for
     `status = 'running'`. Two clicks race; exactly one wins.
  3. SHORT LIVES. Activation 7 days (a new staff member may not check mail
     today). Reset 1 hour (the account exists and may already be under attack).

`consumed_at` is kept rather than the row deleted, so a second click can be
told apart from an expired link and given the right words.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base

PURPOSE_ACTIVATION = "activation"
PURPOSE_RESET = "reset"


def _uuid() -> str:
    return uuid.uuid4().hex


class AuthToken(Base):
    __tablename__ = "auth_tokens"
    __table_args__ = (
        # Named: an unnamed unique is called one thing by create_all() and
        # another by the migration (see College.code's history).
        UniqueConstraint("token_hash", name="uq_auth_token_hash"),
        Index("ix_auth_tokens_user_purpose", "user_id", "purpose"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    # CASCADE, unlike the institution tables: a token for a user who no longer
    # exists cannot mean anything, and keeping it would only be a hash pointing
    # at nothing.
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    purpose: Mapped[str] = mapped_column(String)  # PURPOSE_ACTIVATION | PURPOSE_RESET
    token_hash: Mapped[str] = mapped_column(String)  # sha256 hex, 64 chars — never the raw
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Who issued it — a director from the console, or nobody (a CLI, or the
    # student themself via forgot-password). SET NULL: losing the issuer must
    # not lose the record that a link was issued.
    created_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
