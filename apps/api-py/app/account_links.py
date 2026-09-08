"""Links that work once: issue them, consume them, and the emails that carry them.

This is the library half of activation, password reset and registration
confirmation. It knows nothing about HTTP — `routers/passwords.py` and
`routers/registration.py` are the callers — so `app/grant_access.py` can issue
an activation link from the command line with the same function the console
uses.

TWO TABLES, ONE SHAPE. User-bound links (activation, reset) live in
`auth_tokens`; a registration's confirmation link lives in the older
`email_verifications`, because an applicant is not a user yet. Both store only
`sha256(token)`, both expire, both are consumed with one atomic UPDATE. The
sign-in CODE (`PURPOSE_LOGIN_CODE`) shares the first table and not the rule:
its hash is bound to its row (`_hash_code`), it is found by user rather than
by hash (`consume_user_code`), and its dead rows are deleted rather than kept.

WHO THE MAIL GOES TO, BY ROLE — the decision recorded as "option B" in the
agreed plan: STUDENTS SIGN IN WITH GOOGLE AND NEVER HOLD A PASSWORD, so a
provisioned student gets an ENROLMENT NOTICE ("your account is ready, sign in
with your college Google account") and never an activation link. STAFF
(mentor, director, admin, alumni) get password accounts through activation.
`issue_activation` refuses a STUDENT for that reason.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from . import mail_transport
from .config import settings
from .mailer import deliver_once
from .models.auth_token import (
    PURPOSE_ACTIVATION,
    PURPOSE_LOGIN_CODE,
    PURPOSE_RESET,
    AuthToken,
    _uuid,
)
from .models.registration import EmailVerification, Registration
from .models.user import Role, User

log = logging.getLogger(__name__)


# --------------------------------------------------------------- the token --


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _hash_code(row_id: str, raw: str) -> str:
    """The stored hash of a six-digit CODE — bound to its own row, not to the
    digits alone.

    `auth_tokens.token_hash` carries a GLOBAL unique constraint
    (`uq_auth_token_hash`), which is right for a 256-bit link token (one hash,
    one row, ever) and wrong for a value drawn from a space of a million: two
    staff dealt 482913 in the same ten minutes — or one staff member re-drawing
    a code anyone consumed last year — would collide on the bare sha256, and
    the INSERT would answer HTTP 500 to a person who had just typed the right
    password. Mixing the row's own id in makes every code hash unique BY
    CONSTRUCTION, so the constraint stays and can never be hit by six digits.
    The consumer knows which row to check because a code is looked up by
    (user, purpose), never by hash — see `consume_user_code`.
    """
    return _hash(f"{PURPOSE_LOGIN_CODE}:{row_id}:{raw}")


# A fixed row id and hash for the path where there is NO live code to check
# against. `consume_user_code` still hashes and compares, so "no such account"
# and "no live code" cost the same work as "wrong code" — the discipline
# /login applies with its throwaway scrypt hash, for the same reason.
_NO_ROW_ID = _uuid()
_NO_ROW_HASH = _hash_code(_NO_ROW_ID, secrets.token_urlsafe(16))


def _new_raw() -> str:
    # 32 bytes -> 43 URL-safe chars. 256 bits of entropy; unguessable, so the
    # stored hash can be a fast one.
    return secrets.token_urlsafe(32)


def new_login_code() -> str:
    """A six-digit sign-in code, zero-padded. Twenty bits of entropy, not 256:
    it is typed from a phone screen, so its safety is the short life
    (settings.otp_code_minutes), the per-account attempt budget on
    /auth/login/code, and the user-scoped consume — never the code alone."""
    return f"{secrets.randbelow(1_000_000):06d}"


def _now() -> datetime:
    return datetime.now(timezone.utc)


#: How long a dead login code (consumed, or expired unused) may linger before
#: `sweep_login_codes` deletes it. A day: long enough that an operator reading
#: "did this person get a code" that morning still finds the row.
LOGIN_CODE_SWEEP_GRACE = timedelta(days=1)


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
    raw: str | None = None,
) -> tuple[str, AuthToken]:
    """Mint a fresh link of `purpose`, superseding any earlier live one.

    Superseding on issue — not only on use — is deliberate: an admin who clicks
    "resend" twice should hand over ONE working link, and a student who asks
    for a reset twice should not have two live links in two inboxes. Only the
    newest works. Returns (raw token, row); the raw token exists in the caller's
    hands and the email, and nowhere else.

    `raw` lets a caller supply the secret — the sign-in code path passes
    `new_login_code()` — and defaults to a 256-bit link token.

    A LOGIN CODE IS THE EXCEPTION TWICE OVER. Its predecessors are DELETED, not
    stamped consumed: a link keeps its used row so a second click can be told
    "already used", but /login/code answers one sentence for every refusal, so
    a dead code row has no words to preserve — and a table gaining one
    permanent row per staff sign-in is a leak with nothing reading it. And its
    hash is `_hash_code(row.id, raw)`, bound to the row, so the six digits can
    never trip `uq_auth_token_hash` — the id is drawn here, before the row
    exists, because the hash needs it.
    """
    if purpose == PURPOSE_LOGIN_CODE:
        db.execute(
            delete(AuthToken).where(
                AuthToken.user_id == user.id, AuthToken.purpose == PURPOSE_LOGIN_CODE
            )
        )
        raw = raw or new_login_code()
        row_id = _uuid()
        token_hash = _hash_code(row_id, raw)
    else:
        revoke_user_tokens(db, user.id, purpose)
        raw = raw or _new_raw()
        row_id = _uuid()
        token_hash = _hash(raw)
    row = AuthToken(
        id=row_id,
        user_id=user.id,
        purpose=purpose,
        token_hash=token_hash,
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


def consume_user_code(db: Session, user_id: str, purpose: str, raw: str) -> bool:
    """Spend a one-time CODE atomically, for THIS user only.

    Looked up by (user, purpose), NEVER by hash — and that is the whole point.
    A link token is 256 random bits and its hash finds one row; a six-digit
    code is drawn from a million, so two people can hold 482913 at the same
    moment, and a hash-only lookup would let whoever typed it second sign in
    as whoever was issued it first. The stored hash is `_hash_code(row.id,
    raw)`, so the same digits hash differently on every row and the table's
    global unique is never in play; it also means the ONLY way to find the row
    is by who it was issued to, which is the scoping the schema could not give.

    THREE STEPS, ONE ARBITER. (1) Select this user's single live row — at most
    one exists, because issue deletes predecessors. (2) Compare in constant
    time. (3) `UPDATE ... WHERE id = :id AND consumed_at IS NULL RETURNING id`,
    so single-use is still a row-count decision: two racing posts of the right
    code both pass step 2 and exactly one wins step 3.

    THE CLOCK IS FLAT. No live row — an unknown account (the router passes a
    throwaway id), a code that expired, a replay — still hashes and compares
    against a fixed dummy, so the refusal costs the same work as a wrong code.
    Never use `consume_user_token` for a code. Returns whether the row was
    spent; a wrong code, an expired one, someone else's, and a replay all read
    the same False.
    """
    now = _now()
    row = db.scalar(
        select(AuthToken)
        .where(
            AuthToken.user_id == user_id,
            AuthToken.purpose == purpose,
            AuthToken.consumed_at.is_(None),
            AuthToken.expires_at > now,
        )
        .order_by(AuthToken.created_at.desc())
        .limit(1)
    )
    if row is None:
        hmac.compare_digest(_hash_code(_NO_ROW_ID, raw), _NO_ROW_HASH)
        return False
    if not hmac.compare_digest(_hash_code(row.id, raw), row.token_hash):
        return False
    result = db.execute(
        update(AuthToken)
        .where(AuthToken.id == row.id, AuthToken.consumed_at.is_(None))
        .values(consumed_at=now)
        .returning(AuthToken.id)
    )
    return result.scalar_one_or_none() is not None


def sweep_login_codes(db: Session, now: datetime | None = None) -> int:
    """Delete login-code rows that are dead past `LOGIN_CODE_SWEEP_GRACE` —
    consumed, or expired unused. Issue already deletes a user's predecessors,
    so what this catches is the LAST code of someone who does not sign in
    again: without it the table keeps one row per staff member forever, and a
    row nothing can read is not a record, it is a leak. Returns how many.
    """
    cutoff = (now or _now()) - LOGIN_CODE_SWEEP_GRACE
    result = db.execute(
        delete(AuthToken).where(
            AuthToken.purpose == PURPOSE_LOGIN_CODE,
            (AuthToken.consumed_at < cutoff) | (AuthToken.expires_at < cutoff),
        )
    )
    return int(result.rowcount or 0)


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


def send_login_code(db: Session, user: User, code: str, token_id: str) -> None:
    """Email the sign-in code. The code, not a link: it is typed into the screen
    that asked for the password, so there is nowhere for a link to land.

    Dedupe key carries the TOKEN id for the same reason activation's does:
    every fresh sign-in attempt mints a fresh code that must go out.
    """
    subject = "Your REEP sign-in code"
    text = (
        f"Hello {user.name},\n\n"
        f"Your one-time code to finish signing in to REEP is:\n\n"
        f"    {code}\n\n"
        f"It expires in {settings.otp_code_minutes} minutes. If you did not try "
        f"to sign in, ignore this — nobody can use it without your password.\n"
    )
    deliver_once(
        db,
        kind="login-code",
        recipient=user.email,
        dedupe_key=f"login-code:{user.id}:{token_id}",
        subject=subject,
        send=_driver(text),
    )


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
