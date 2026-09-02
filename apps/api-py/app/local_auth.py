"""Email & password sign-in: the one-time-code lifecycle and the rules both
doors share. FastAPI-free, like app/google_auth.py — the router in
app/routers/local_auth.py is the HTTP skin over this.

THREE FLOWS, ONE PATH. Creating a password for the first time, resetting a
forgotten one and changing one while signed in are the same three steps —
enter the address, enter the emailed code, choose the password — and they
share this module, one table (auth_email_otps), one screen and one endpoint
set. The only thing a live session adds is a binding: the address must be the
session's own.

WHO MAY USE IT. An address that is ALREADY a `users` row (the roster;
app.grant_access) AND is on the college domain (settings.roster_domain).
Nothing here creates a User, sets a role or touches google_sub: rule 2 in
AGENTS.md makes a guessed role a data-exposure bug, and the roster is the
allowlist for this door exactly as it is for Google.

WHY 202 FOR EVERYONE. `request_code` — the WHOLE distinguishing path: domain
fence, lookup, cooldown, hourly cap, insert, send — runs as a BackgroundTask
after the 202 has been written, with its own Session. Neither the body nor the
clock can tell an enrolled address from an unknown one, and a transport
failure is not a different answer either: its witnesses are the ERROR line
below, the FAILED mail_logs row and the CloudWatch alarm on that line.

THE CODE IS NEVER STORED. `code_hash` is HMAC-SHA256 under a key derived from
AUTH_SECRET, over user_id:purpose:code — a copy of the table verifies nothing
without the secret, and a code cannot verify against a row it was not issued
for. Rotating AUTH_SECRET therefore invalidates every outstanding code as well
as every session. Brute force is bounded by attempts and expiry, not hash cost:
a slow hash here would be a free CPU lever for an unauthenticated caller.

WHAT REVOKES WHAT. A new request expires the previous live code. A successful
set consumes the code and bumps users.token_version in the same transaction, so
every other session dies (immediately on this worker, within
AUTH_REVOCATION_CACHE_SECONDS elsewhere — app/security.py states the limit),
and the cookie issued on the same response is the one survivor.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from . import email as email_mod
from . import mailer
from .config import settings
from .db import SessionLocal
from .models.auth_otp import EmailOtp
from .models.mail import MailLog, MailStatus
from .models.user import User
from .ratelimit import FixedWindow
from .security import hash_password

log = logging.getLogger(__name__)

OTP_DIGITS = 6
OTP_TTL_SECONDS = 600  # 10 minutes
OTP_MAX_ATTEMPTS = 5  # wrong guesses per code; then dead even if the next guess is right
OTP_RESEND_SECONDS = 60  # per-user cooldown; a request inside it is a silent 202
OTP_MAX_PER_HOUR = 3  # codes issued per user per rolling hour, DB-counted
OTP_ROW_RETENTION_SECONDS = 86_400
OTP_MAIL_LOG_RETENTION_DAYS = 180  # the interview clock; the row holds the recipient address
PASSWORD_MIN_CHARS = 10
PASSWORD_MAX_CHARS = 200  # bounds the scrypt input; no composition rules (NIST 800-63B)

PURPOSE_PASSWORD = "password"
# RESERVED for the optional OTP-on-every-login flag (designed in
# docs/email-password-sign-in.md, not built). Kept as a named constant so the
# purpose separation is visible in review if that flag is ever added.
PURPOSE_LOGIN_RESERVED = "login"

# Domain separation for the HMAC key, the google_auth._FLOW_KEY_LABEL shape:
# the same AUTH_SECRET signs sessions and flow cookies, and a key derived under
# a different label cannot be confused with either.
_OTP_KEY_LABEL = b"reep.email-otp-v1\x00"

MAIL_KIND = "auth-otp"
MAIL_SUBJECT = "Your REEP sign-in code"  # no digits: mail_logs stores subjects
# The literal the CloudWatch metric filter matches (infra/aws/observability.tf).
SEND_FAILED_LOG = "auth-otp send failed"

# What the request endpoint always reports, whatever happened. A remaining-wait
# value would be an oracle for "a code was actually issued".
RESEND_AFTER_SECONDS = OTP_RESEND_SECONDS

# Fixed windows for the doors, all per process (app/ratelimit.py says why).
# /login counts FAILURES only — a mistyping student is not locked out by their
# successes, and the per-address window is the one deliberate lockout lever,
# bounded at 15 minutes and self-serviceable through the emailed-code reset.
LOGIN_IP_FAILURES = FixedWindow(600, 40)
LOGIN_ADDRESS_FAILURES = FixedWindow(900, 10)
OTP_REQUESTS_PER_IP = FixedWindow(600, 30)
OTP_SET_PER_IP = FixedWindow(900, 20)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def normalise_email(raw: str) -> str:
    return raw.strip().lower()


def address_allowed(email: str) -> bool:
    """The domain fence. `roster_domain` is the resolver the roster seed and the
    status probe already use — never a second domain setting."""
    if "@" not in email:
        return False
    return email.rsplit("@", 1)[1] == settings.roster_domain.strip().lower()


def find_user(db: Session, email: str) -> User | None:
    """Case-insensitive, the Google callback's and grant_access's rule."""
    return db.scalar(select(User).where(func.lower(User.email) == email))


def _otp_key() -> bytes:
    # Read per call, so a rotated AUTH_SECRET takes effect without a restart of
    # this module's state and so tests that monkeypatch the secret see it.
    return hashlib.sha256(_OTP_KEY_LABEL + settings.auth_secret.encode()).digest()


def otp_hash(user_id: str, purpose: str, code: str) -> str:
    message = f"{user_id}:{purpose}:{code}".encode()
    return hmac.new(_otp_key(), message, hashlib.sha256).hexdigest()


def validate_new_password(email: str, new_password: str) -> str | None:
    """The 422 sentence, or None when the password is acceptable. Checked
    BEFORE the code so a weak password does not spend an OTP attempt."""
    if len(new_password) < PASSWORD_MIN_CHARS:
        return f"Choose a password of at least {PASSWORD_MIN_CHARS} characters."
    if len(new_password) > PASSWORD_MAX_CHARS:
        return f"Choose a password of at most {PASSWORD_MAX_CHARS} characters."
    if new_password.strip().lower() == email.strip().lower():
        return "Your password cannot be your email address."
    return None


def _is_live(row: EmailOtp, now: datetime) -> bool:
    return row.consumed_at is None and row.attempts < OTP_MAX_ATTEMPTS and row.expires_at > now


def issue_code(
    db: Session, user: User, purpose: str, *, now: datetime | None = None
) -> tuple[EmailOtp, str] | None:
    """Mint a code for `user`, or None when the cooldown or the hourly cap says
    not now. The plaintext exists only in the return value and the outbound
    email. Older live codes are EXPIRED, not deleted, so the cap and the
    cooldown still count the request they are supposed to count."""
    now = now or utcnow()
    # Serialise on the user row for the length of this transaction. The cooldown
    # and the hourly cap are decided from a snapshot of this user's rows; without
    # a lock, N concurrent requests (30 per IP fit inside the window) each read
    # the pre-burst snapshot, all pass, and one address receives N emails. Every
    # return path below commits, which releases it.
    db.execute(select(User.id).where(User.id == user.id).with_for_update())
    db.execute(
        delete(EmailOtp).where(
            EmailOtp.user_id == user.id,
            EmailOtp.created_at < now - timedelta(seconds=OTP_ROW_RETENTION_SECONDS),
        )
    )
    rows = db.scalars(
        select(EmailOtp)
        .where(EmailOtp.user_id == user.id, EmailOtp.purpose == purpose)
        .order_by(EmailOtp.created_at.desc())
    ).all()
    if rows and rows[0].created_at > now - timedelta(seconds=OTP_RESEND_SECONDS):
        log.debug("auth-otp: resend cooldown for user %s", user.id)
        db.commit()
        return None
    recent = [r for r in rows if r.created_at > now - timedelta(seconds=3600)]
    if len(recent) >= OTP_MAX_PER_HOUR:
        # The user id, never the address: this line lands in CloudWatch.
        log.warning("auth-otp: hourly cap reached for user %s", user.id)
        db.commit()
        return None
    for row in rows:
        if _is_live(row, now):
            row.expires_at = now
    code = f"{secrets.randbelow(10**OTP_DIGITS):0{OTP_DIGITS}d}"
    otp = EmailOtp(
        user_id=user.id,
        purpose=purpose,
        code_hash=otp_hash(user.id, purpose, code),
        created_at=now,
        expires_at=now + timedelta(seconds=OTP_TTL_SECONDS),
    )
    db.add(otp)
    db.commit()
    db.refresh(otp)
    return otp, code


def verify_code(
    db: Session, user: User, purpose: str, code: str, *, now: datetime | None = None
) -> EmailOtp | None:
    """The newest live code if `code` matches it, else None — and a miss is
    counted against that code. Does NOT consume: consumption is one transaction
    with the password write, in consume_and_set_password."""
    now = now or utcnow()
    # FOR UPDATE, so the liveness check and the miss count run under the row
    # lock: parallel wrong guesses otherwise all read attempts=0, all pass, and
    # all write 1 - a 5-guess budget that a burst turns into 20.
    row = db.scalar(
        select(EmailOtp)
        .where(EmailOtp.user_id == user.id, EmailOtp.purpose == purpose)
        .order_by(EmailOtp.created_at.desc())
        .limit(1)
        .with_for_update()
    )
    if row is None or not _is_live(row, now):
        # Burn the same comparison so a missing row costs what a wrong code costs.
        hmac.compare_digest(otp_hash(user.id, purpose, code), otp_hash(user.id, purpose, "0"))
        db.commit()
        return None
    if hmac.compare_digest(row.code_hash, otp_hash(user.id, purpose, code)):
        db.commit()  # releases the lock; consumption is the caller's transaction
        return row
    # Atomic in SQL as well as locked: `attempts = attempts + 1`, never a Python
    # value written back, so a lost update is impossible even if the lock above
    # is ever loosened.
    db.execute(update(EmailOtp).where(EmailOtp.id == row.id).values(attempts=EmailOtp.attempts + 1))
    db.commit()
    return None


def consume_and_set_password(
    db: Session, user: User, otp: EmailOtp, new_password: str, *, now: datetime | None = None
) -> int:
    """Stamp the code consumed, write the hash over the sentinel or the old
    hash, bump token_version — one transaction. Returns the new version so the
    caller can seed the revocation cache and mint a cookie that carries it.
    `google_sub` is never touched: a password does not change who the row is."""
    now = now or utcnow()
    otp.consumed_at = now
    user.password_hash = hash_password(new_password)
    user.token_version = (user.token_version or 0) + 1
    db.commit()
    db.refresh(user)
    return user.token_version


def message_for_code(to: str, code: str) -> email_mod.OutboundEmail:
    text = (
        f"Your REEP code is {code}. It expires in {OTP_TTL_SECONDS // 60} minutes and works "
        "once. Enter it on the page where you asked for it.\n\n"
        "If you did not ask for a code, ignore this message - nothing changes without it. "
        "REEP staff will never ask you for this code.\n"
    )
    reply_to = settings.email_reply_to.strip() or None
    return email_mod.OutboundEmail(to=to, subject=MAIL_SUBJECT, text=text, reply_to=reply_to)


def deliver_code(db: Session, otp: EmailOtp, to: str, code: str) -> MailLog:
    """Send through the existing exactly-once mailer, keyed on the code row, so
    a retried task cannot send one code twice and a legitimate second request is
    never deduped. mailer.deliver_once swallows the driver's exception into the
    row by contract, so the ERROR tripwire is logged HERE — with ids, never the
    address or the code."""
    message = message_for_code(to, code)
    row = mailer.deliver_once(
        db,
        kind=MAIL_KIND,
        recipient=to,
        dedupe_key=f"{MAIL_KIND}:{otp.id}",
        subject=message.subject,
        send=lambda _recipient, _subject: email_mod.send(message),
    )
    if row.status is MailStatus.FAILED:
        # The provider's message may name the recipient (SES: "Email address is
        # not verified. The following identities failed the check ...: <addr>").
        # mail_logs.error keeps it verbatim beside the recipient column it
        # already holds; the log line, which reaches CloudWatch and the alarm,
        # does not.
        log.error("%s for otp %s: %s", SEND_FAILED_LOG, otp.id, redact_addresses(row.error))
    return row


_ADDRESS = re.compile(r"[^\s@<>,;:]+@[^\s@<>,;:]+")


def redact_addresses(text: str | None) -> str:
    return _ADDRESS.sub("<address>", text or "")


def request_code(email: str) -> None:
    """THE BackgroundTasks target. Everything that could distinguish an enrolled
    address from an unknown one happens here, after the 202 has gone out, on a
    Session of its own (never the request's — a yield-dependency's teardown
    order is not something to build a security property on). Every non-matching
    case returns silently."""
    try:
        if not address_allowed(email):
            return
        with SessionLocal() as db:
            user = find_user(db, email)
            if user is None:
                return
            issued = issue_code(db, user, PURPOSE_PASSWORD)
            if issued is None:
                return
            otp, code = issued
            deliver_code(db, otp, email, code)
    except Exception:  # noqa: BLE001 — a background task must never propagate a traceback with the address in it
        log.exception("auth-otp: request_code failed (address withheld)")


def purge_stale(db: Session, *, now: datetime | None = None) -> dict[str, int]:
    """Retention for this feature: code rows after a day, their delivery records
    after 180 days. Called from app/retention.py:purge_expired; the two keys are
    reported in its summary."""
    now = now or utcnow()
    otp_cutoff = now - timedelta(seconds=OTP_ROW_RETENTION_SECONDS)
    mail_cutoff = now - timedelta(days=OTP_MAIL_LOG_RETENTION_DAYS)
    otp_rows = db.execute(delete(EmailOtp).where(EmailOtp.created_at < otp_cutoff)).rowcount
    mail_rows = db.execute(
        delete(MailLog).where(MailLog.kind == MAIL_KIND, MailLog.sent_at < mail_cutoff)
    ).rowcount
    db.commit()
    return {"otp_rows_deleted": int(otp_rows or 0), "otp_mail_logs_deleted": int(mail_rows or 0)}
