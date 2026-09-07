"""Links that work once: issue them, consume them, and the emails that carry them.

This is the library half of activation, password reset and registration
confirmation. It knows nothing about HTTP — `routers/passwords.py` and
`routers/registration.py` are the callers — so `app/grant_access.py` can issue
an activation link from the command line with the same function the console
uses.

TWO TABLES, ONE SHAPE. User-bound links (activation, reset) live in
`auth_tokens`; a registration's confirmation link lives in the older
`email_verifications`, because an applicant is not a user yet. Both store only
`sha256(token)`, both expire, both are consumed with one atomic UPDATE.

WHO THE MAIL GOES TO, BY ROLE — the decision recorded as "option B" in the
agreed plan: STUDENTS SIGN IN WITH GOOGLE AND NEVER HOLD A PASSWORD, so a
provisioned student gets an ENROLMENT NOTICE ("your account is ready, sign in
with your college Google account") and never an activation link. STAFF
(mentor, director, admin, alumni) get password accounts through activation.
`issue_activation` refuses a STUDENT for that reason.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from . import mail_transport
from .config import settings
from .mailer import deliver_once
from .models.auth_token import PURPOSE_ACTIVATION, PURPOSE_RESET, AuthToken
from .models.registration import EmailVerification, Registration
from .models.user import Role, User

log = logging.getLogger(__name__)


# --------------------------------------------------------------- the token --


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _new_raw() -> str:
    # 32 bytes -> 43 URL-safe chars. 256 bits of entropy; unguessable, so the
    # stored hash can be a fast one.
    return secrets.token_urlsafe(32)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _link(path: str, raw: str) -> str:
    return f"{settings.web_origin.rstrip('/')}{path}?token={raw}"


def revoke_user_tokens(db: Session, user_id: str, purpose: str) -> int:
    """Kill every still-live link of `purpose` for this user. Returns how many."""
    result = db.execute(
        update(AuthToken)
        .where(
            AuthToken.user_id == user_id,
            AuthToken.purpose == purpose,
            AuthToken.consumed_at.is_(None),
        )
        .values(consumed_at=_now())
    )
    return int(result.rowcount or 0)


def issue_user_token(
    db: Session,
    user: User,
    purpose: str,
    ttl: timedelta,
    *,
    created_by_user_id: str | None = None,
) -> tuple[str, AuthToken]:
    """Mint a fresh link of `purpose`, superseding any earlier live one.

    Superseding on issue — not only on use — is deliberate: an admin who clicks
    "resend" twice should hand over ONE working link, and a student who asks
    for a reset twice should not have two live links in two inboxes. Only the
    newest works. Returns (raw token, row); the raw token exists in the caller's
    hands and the email, and nowhere else.
    """
    revoke_user_tokens(db, user.id, purpose)
    raw = _new_raw()
    row = AuthToken(
        user_id=user.id,
        purpose=purpose,
        token_hash=_hash(raw),
        expires_at=_now() + ttl,
        created_by_user_id=created_by_user_id,
    )
    db.add(row)
    db.flush()
    return raw, row


def peek_user_token(db: Session, purpose: str, raw: str) -> AuthToken | None:
    """The live row for `raw`, WITHOUT consuming it. Returns None if unknown,
    expired or used — `explain_user_token` tells those apart for the message.

    Used to validate a NEW PASSWORD before the link is spent: a policy refusal
    ("12 characters minimum") must not burn the link, or a typo costs the
    student a second email.
    """
    row = db.scalar(select(AuthToken).where(AuthToken.token_hash == _hash(raw)))
    if row is None or row.purpose != purpose:
        return None
    if row.consumed_at is not None or row.expires_at <= _now():
        return None
    return row


def explain_user_token(db: Session, purpose: str, raw: str) -> str:
    """Why `raw` is not usable, in the words the screen should show."""
    row = db.scalar(select(AuthToken).where(AuthToken.token_hash == _hash(raw)))
    if row is None or row.purpose != purpose:
        return "This link is not valid. Ask for a new one."
    if row.consumed_at is not None:
        return "This link has already been used. If that was not you, ask for a new one."
    return "This link has expired. Ask for a new one."


def consume_user_token(db: Session, purpose: str, raw: str) -> User | None:
    """Spend the link atomically. Exactly one caller ever gets the user back.

    `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now()` — the row
    count is the arbiter. Two clicks race; one wins; the other reads a consumed
    row and is told so.
    """
    now = _now()
    result = db.execute(
        update(AuthToken)
        .where(
            AuthToken.token_hash == _hash(raw),
            AuthToken.purpose == purpose,
            AuthToken.consumed_at.is_(None),
            AuthToken.expires_at > now,
        )
        .values(consumed_at=now)
        .returning(AuthToken.user_id)
    )
    user_id = result.scalar_one_or_none()
    if user_id is None:
        return None
    return db.get(User, user_id)


# ---------------------------------------------- registration confirmation --


def issue_email_verification(db: Session, registration: Registration) -> str:
    """A confirmation link for a fresh application. Returns the raw token."""
    raw = _new_raw()
    db.add(
        EmailVerification(
            registration_id=registration.id,
            token_hash=_hash(raw),
            expires_at=_now() + timedelta(hours=settings.email_verification_hours),
        )
    )
    db.flush()
    return raw


def consume_email_verification(db: Session, raw: str) -> Registration | None:
    """Spend a confirmation link atomically; the application, or None."""
    now = _now()
    result = db.execute(
        update(EmailVerification)
        .where(
            EmailVerification.token_hash == _hash(raw),
            EmailVerification.consumed_at.is_(None),
            EmailVerification.expires_at > now,
        )
        .values(consumed_at=now)
        .returning(EmailVerification.registration_id)
    )
    registration_id = result.scalar_one_or_none()
    if registration_id is None:
        return None
    return db.get(Registration, registration_id)


# ---------------------------------------------------------------- the mail --
# Each builder returns (subject, text). Plain text on purpose: it renders in
# every client, it is what SES's sandbox lets through first, and a link is the
# only thing these messages exist to carry. Nothing about a student's record
# goes in one — see mail_transport's note on rule 1.


def _driver(text: str):
    return lambda to, subject: mail_transport.send(to, subject or "", text)


def send_activation(db: Session, user: User, raw: str, token_id: str) -> str:
    """Email the activation link. Returns the link, for the on-screen fallback.

    Dedupe key includes the TOKEN id, not just the user: every re-issued link
    is a new message that must go out. Deduping on the user alone would make
    "resend" silently send nothing.
    """
    link = _link("/activate", raw)
    days = max(1, settings.activation_link_hours // 24)
    subject = "Set up your REEP account"
    text = (
        f"Hello {user.name},\n\n"
        f"An account has been created for you on REEP, the placement-readiness "
        f"dashboard. Set your password here:\n\n    {link}\n\n"
        f"This link works once and expires in {days} days. If you did not expect "
        f"this email, you can ignore it.\n"
    )
    deliver_once(
        db,
        kind="activation",
        recipient=user.email,
        dedupe_key=f"activation:{user.id}:{token_id}",
        subject=subject,
        send=_driver(text),
    )
    return link


def send_enrolment_notice(db: Session, user: User) -> None:
    """Tell a newly provisioned STUDENT their account exists. No link, no
    password: students sign in with Google (option B). Sent once per user —
    the dedupe key has no token because there is no token."""
    login = f"{settings.web_origin.rstrip('/')}/login"
    subject = "Your REEP account is ready"
    text = (
        f"Hello {user.name},\n\n"
        f"Your application has been approved and your REEP account is ready.\n\n"
        f"Sign in with your college Google account ({user.email}) here:\n\n"
        f"    {login}\n\n"
        f"There is no password to set — your college Google account is your sign-in.\n"
    )
    deliver_once(
        db,
        kind="enrolment",
        recipient=user.email,
        dedupe_key=f"enrolment:{user.id}",
        subject=subject,
        send=_driver(text),
    )


def send_password_reset(db: Session, user: User, raw: str, token_id: str) -> str:
    link = _link("/reset", raw)
    subject = "Reset your REEP password"
    text = (
        f"Hello {user.name},\n\n"
        f"Someone asked to reset the password for this REEP account. If that was "
        f"you, set a new one here:\n\n    {link}\n\n"
        f"This link works once and expires in {settings.password_reset_minutes} "
        f"minutes. If you did not ask for this, ignore it — your password has not "
        f"changed.\n"
    )
    deliver_once(
        db,
        kind="password-reset",
        recipient=user.email,
        dedupe_key=f"reset:{user.id}:{token_id}",
        subject=subject,
        send=_driver(text),
    )
    return link


def send_email_verification(db: Session, registration: Registration, raw: str) -> str:
    """The confirmation link for an application. Goes to the API directly (it
    is a GET the mail client can follow), which then redirects into the app."""
    link = f"{settings.web_origin.rstrip('/')}/api/register/verify?token={raw}"
    subject = "Confirm your email for your REEP application"
    text = (
        f"Hello {registration.name},\n\n"
        f"Confirm this is your address so the placement office can review your "
        f"application:\n\n    {link}\n\n"
        f"The link expires in {settings.email_verification_hours} hours. If you "
        f"did not apply, ignore this email and nothing will happen.\n"
    )
    deliver_once(
        db,
        kind="email-verification",
        recipient=registration.email,
        dedupe_key=f"verify:{registration.id}:{_hash(raw)[:16]}",
        subject=subject,
        send=_driver(text),
    )
    return link


# ---------------------------------------------------------- the two flows --


def issue_activation(
    db: Session, user: User, *, created_by_user_id: str | None
) -> tuple[str, bool]:
    """Mint an activation link for a STAFF account and email it.

    Returns (link, emailed). `emailed` is False when there is no transport —
    the caller shows the link on screen or prints it, which is the fallback the
    plan keeps PERMANENTLY: when a student says "the email never arrived", the
    admin reads them the link instead of waiting on a mail queue.

    Refuses a STUDENT. Under option B students never hold a password; giving
    one a link here would open a password door the roster design does not
    want. They get `send_enrolment_notice` from provisioning instead.
    """
    if user.role is Role.STUDENT:
        raise ValueError(
            "Students sign in with their college Google account and do not set a "
            "password. Activation links are for staff accounts."
        )
    raw, row = issue_user_token(
        db,
        user,
        PURPOSE_ACTIVATION,
        timedelta(hours=settings.activation_link_hours),
        created_by_user_id=created_by_user_id,
    )
    db.commit()
    link = send_activation(db, user, raw, row.id)
    return link, mail_transport.configured()


def issue_password_reset(db: Session, user: User) -> None:
    """Mint a reset link and email it. Only for accounts that HOLD a password —
    a Google-only account has nothing to reset, and mailing it a link would
    quietly turn it into a password account."""
    raw, row = issue_user_token(
        db, user, PURPOSE_RESET, timedelta(minutes=settings.password_reset_minutes)
    )
    db.commit()
    send_password_reset(db, user, raw, row.id)
