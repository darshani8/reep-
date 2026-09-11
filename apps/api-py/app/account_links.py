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
(mentor, admin, alumni) get password accounts through activation.
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
    CODE_PURPOSES,
    PURPOSE_ACTIVATION,
    PURPOSE_CHANGE_CODE,
    PURPOSE_LOGIN_CODE,
    PURPOSE_ONBOARD,
    PURPOSE_ONBOARD_CODE,
    PURPOSE_ONBOARD_SET,
    PURPOSE_RESET,
    AuthToken,
    _uuid,
)
from .models.registration import Registration
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


def _human_hours(hours: int) -> str:
    """"7 days", not "168 hours". A lifetime is written into a mail a student
    reads once, and the number that matters to them is the one they can hold
    in their head. Falls back to hours whenever days would round."""
    if hours >= 48 and hours % 24 == 0:
        return f"{hours // 24} days"
    return f"{hours} hour" + ("" if hours == 1 else "s")


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
    if purpose in CODE_PURPOSES:
        db.execute(
            delete(AuthToken).where(
                AuthToken.user_id == user.id, AuthToken.purpose == purpose
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
            AuthToken.purpose.in_(CODE_PURPOSES),
            (AuthToken.consumed_at < cutoff) | (AuthToken.expires_at < cutoff),
        )
    )
    return int(result.rowcount or 0)


# ---------------------------------------------- registration confirmation --


# THE REGISTRATION CONFIRMATION LINK IS GONE (2026-09-10). issue/reissue/
# consume_email_verification and their route lived here; the mailbox proof
# moved past the decision and is now three purposes on `auth_tokens`
# (PURPOSE_ONBOARD, _CODE, _SET) rather than a row on `email_verifications`.
# The MODEL and its table stay: `purge_people` classifies all 93 tables and a
# table nobody classified aborts its run, and retention still names it.


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


# `send_enrolment_notice` IS GONE (2026-09-10). It told a provisioned student
# "sign in with your college Google account — there is no password to set",
# which was the whole of option B. Students set a password now, so provisioning
# sends `send_onboarding_invite` instead: the same moment, a mail that carries
# the way in rather than a sentence about a button.


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


def send_onboarding_invite(db: Session, user: User, raw: str, token_id: str) -> str:
    """The mail an APPROVED applicant gets: one link, and nothing else to do.

    This replaced `send_enrolment_notice` (2026-09-10). That notice said "sign
    in with your college Google account" and was the whole of option B, under
    which a student never held a password. Students now set one, so the mail
    has to carry the way in rather than a sentence about a button.

    It carries a LINK and not a code, because it is opened in a browser: the
    screen it lands on is what then asks for the address and mails the code.
    """
    link = f"{settings.web_origin.rstrip('/')}/onboard?token={raw}"
    subject = "Your REEP account is approved - set it up"
    text = (
        f"Hello {user.name},\n\n"
        f"Your REEP registration has been approved by the placement office.\n\n"
        f"Set up your account here:\n\n    {link}\n\n"
        f"You will be asked to confirm your email address with a one-time code, "
        f"and then to choose a password. The link expires in "
        f"{_human_hours(settings.activation_link_hours)}.\n"
    )
    deliver_once(
        db,
        kind="onboarding-invite",
        recipient=user.email,
        dedupe_key=f"onboard:{user.id}:{token_id}",
        subject=subject,
        send=_driver(text),
    )
    return link


def send_onboarding_code(db: Session, user: User, code: str, token_id: str) -> None:
    """The six digits that prove the mailbox is READABLE, not merely that a
    link reached it. A forwarded invite is still a valid invite; this is the
    step that a forward does not survive."""
    subject = "Your REEP verification code"
    text = (
        f"Hello {user.name},\n\n"
        f"Your code to confirm this email address is:\n\n    {code}\n\n"
        f"It expires in {settings.otp_code_minutes} minutes. Enter it on the "
        f"page you have open. If you were not setting up a REEP account, "
        f"ignore this email.\n"
    )
    deliver_once(
        db,
        kind="onboarding-code",
        recipient=user.email,
        dedupe_key=f"onboard-code:{user.id}:{token_id}",
        subject=subject,
        send=_driver(text),
    )


def send_change_code(db: Session, user: User, code: str, token_id: str) -> None:
    """The code that authorises changing the password on a LIVE account.

    Its own purpose and its own words. A person reading "confirm this email
    address" when they asked to change a password cannot tell whether they are
    looking at their own action or somebody else's attempt on their account -
    and that sentence is the only warning they will get.
    """
    subject = "Your REEP password-change code"
    text = (
        f"Hello {user.name},\n\n"
        f"Your code to change your REEP password is:\n\n    {code}\n\n"
        f"It expires in {settings.otp_code_minutes} minutes.\n\n"
        f"If you did NOT ask to change your password, do not enter this code - "
        f"somebody else may know your password. Tell the placement office.\n"
    )
    deliver_once(
        db,
        kind="change-code",
        recipient=user.email,
        dedupe_key=f"change-code:{user.id}:{token_id}",
        subject=subject,
        send=_driver(text),
    )


def send_registration_rejected(db: Session, registration: Registration, reason: str) -> None:
    """Tell an applicant their registration was not accepted, and why.

    THE REASON IS THE POINT. A rejected applicant is not a user and never will
    be one, so this mail is the only channel the product has to them - and the
    admin was already required to type a reason before the Reject button would
    confirm. Sending the decision without it would waste the one thing that
    makes the refusal answerable ("my USN was mistyped") rather than final.

    Dedupe is on the application, not on a token: a decision happens once.
    """
    subject = "About your REEP registration"
    text = (
        f"Hello {registration.name},\n\n"
        f"Your REEP registration could not be accepted.\n\n"
        f"Reason given by the placement office:\n\n    {reason}\n\n"
        f"If you believe this is a mistake, reply to the placement office with "
        f"your name and USN.\n"
    )
    deliver_once(
        db,
        kind="registration-rejected",
        recipient=registration.email,
        dedupe_key=f"rejected:{registration.id}",
        subject=subject,
        send=_driver(text),
    )


# ---------------------------------------------------------- the two flows --


def issue_activation(
    db: Session, user: User, *, created_by_user_id: str | None
) -> tuple[str, bool]:
    """Mint an activation link for a STAFF account and email it.

    Returns (link, emailed). `emailed` is False when there is no transport —
    the caller shows the link on screen or prints it, which is the fallback the
    plan keeps PERMANENTLY: when a student says "the email never arrived", the
    admin reads them the link instead of waiting on a mail queue.

    STILL REFUSES A STUDENT, and not because option B survives — it does not,
    students set passwords now. It refuses because a student's equivalent is
    `issue_onboarding`, whose walk makes them confirm the address with an
    emailed CODE before any password is set. An activation link skips that: it
    is a staff first-password link, and staff accounts are created by a named
    admin who already knows who they are. Handing one to a student would trade
    the mailbox proof for nothing.
    """
    if user.role is Role.STUDENT:
        raise ValueError(
            "Students set their password from the setup link they are emailed "
            "when their registration is approved. Activation links are for "
            "staff accounts."
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


def issue_onboarding(db: Session, user: User) -> tuple[str, bool]:
    """Mint the setup link an approved student is emailed. Returns (link, emailed).

    Called from provisioning — the Main Admin's APPROVE and a rule's
    auto-approve alike — so there is exactly one way an account comes into
    existence with a way in attached. It does NOT refuse a STUDENT the way
    `issue_activation` does: that refusal WAS option B, and option B is what
    this replaces.

    Superseding is `issue_user_token`'s, so re-approving or re-sending hands
    over one live link. The commit lands the token before the mail goes out; a
    send that fails leaves a link that still works rather than a row promising
    a mail nobody has.
    """
    raw, row = issue_user_token(
        db, user, PURPOSE_ONBOARD, timedelta(hours=settings.activation_link_hours)
    )
    db.commit()
    link = send_onboarding_invite(db, user, raw, row.id)
    return link, mail_transport.configured()


def issue_onboarding_code(db: Session, user: User) -> None:
    """Mail the six digits that confirm the address. Minutes, not hours."""
    _, row = issue_user_token(
        db,
        user,
        PURPOSE_ONBOARD_CODE,
        timedelta(minutes=settings.otp_code_minutes),
        raw=(code := new_login_code()),
    )
    db.commit()
    send_onboarding_code(db, user, code, row.id)


def issue_onboarding_ticket(db: Session, user: User) -> str:
    """The short-lived proof that THIS person just spent the emailed code.

    Minted only by `onboard/verify`, accepted only by `onboard/password`. It
    exists because the code is single-use and already consumed by the time the
    password screen renders: without a ticket that step would have to trust the
    invite link alone, and the mailbox proof — the entire reason the code is in
    the flow — would be skippable by anyone holding a forwarded link.

    Fifteen minutes: long enough to choose a password, short enough that a
    ticket left on a lab machine is dead before the next class.
    """
    raw, _ = issue_user_token(db, user, PURPOSE_ONBOARD_SET, timedelta(minutes=15))
    db.commit()
    return raw


def issue_change_code(db: Session, user: User) -> None:
    """Mail the code that authorises a password change on a live account."""
    _, row = issue_user_token(
        db,
        user,
        PURPOSE_CHANGE_CODE,
        timedelta(minutes=settings.otp_code_minutes),
        raw=(code := new_login_code()),
    )
    db.commit()
    send_change_code(db, user, code, row.id)


def issue_password_reset(db: Session, user: User) -> None:
    """Mint a reset link and email it. Only for accounts that HOLD a password —
    a Google-only account has nothing to reset, and mailing it a link would
    quietly turn it into a password account."""
    raw, row = issue_user_token(
        db, user, PURPOSE_RESET, timedelta(minutes=settings.password_reset_minutes)
    )
    db.commit()
    send_password_reset(db, user, raw, row.id)
