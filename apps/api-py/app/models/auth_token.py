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

THE SIGN-IN CODE BENDS TWO OF THESE, ON PURPOSE. `token_hash` is globally
unique (`uq_auth_token_hash`) — right for a 256-bit link, and a 500 waiting
to happen for a six-digit code, where two people dealt 482913 in the same
minute, or anyone re-drawing a code consumed last year, would collide on a
bare `sha256(code)`. So a code's hash is `sha256("login_code:<row id>:<code>")`
(account_links._hash_code): unique by construction, and findable ONLY by
(user, purpose), which is the scoping a shared code needs anyway. And a code's
dead rows are DELETED — its predecessors on re-issue, the last one by
`account_links.sweep_login_codes` — because /login/code answers one sentence
for every refusal, so there are no "already used" words to preserve, and one
permanent row per staff sign-in is a leak.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base

PURPOSE_ACTIVATION = "activation"
PURPOSE_RESET = "reset"
# A sign-in one-time code: six digits, minutes to live, hashed WITH its row id
# (see the module docstring), and found by the user it was issued to, never by
# hash — a six-digit value is not unique across users, so
# `consume_user_token`'s hash-only lookup must never be used for one. See
# account_links.consume_user_code.
PURPOSE_LOGIN_CODE = "login_code"


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
    # sha256 hex, 64 chars — never the raw. For a link, sha256(token); for a
    # login code, sha256 over the row id AND the code, so the global unique
    # below can never be tripped by six digits.
    token_hash: Mapped[str] = mapped_column(String)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Who issued it — a director from the console, or nobody (a CLI, or the
    # student themself via forgot-password). SET NULL: losing the issuer must
    # not lose the record that a link was issued.
    created_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
