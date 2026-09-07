"""Setting the first password, forgetting it, and changing it.

Three flows, one ending: THE THING THAT LET YOU IN IS DESTROYED. An activation
link is consumed; a reset link is consumed and every other device is signed
out; a change keeps this device and signs out the rest. Logging the other
devices out after a reset matters because the commonest reason for a reset is
that somebody else got in.

WHAT THIS DOES NOT DO — decided, not forgotten. Students never come here.
Option B in the agreed plan: students sign in with their college Google
account and hold no password; staff get password accounts through activation.
So `activate` refuses a link for a STUDENT (none is ever issued), `forgot`
quietly does nothing for one, and `change-password` answers 409. The
password door itself is still `password_door_open` in auth.py — the first
staff activation issues the first scrypt hash, and that act opens it, exactly
as that function's comment says it should.

WHY A SEPARATE MODULE. auth.py is 830 lines and owns sign-in; this owns
credentials. It borrows auth's session issuance rather than copying it, so a
change to the cookie is still one edit.

NEVER SAY WHETHER AN ADDRESS EXISTS. `forgot` answers the same words with the
same status whether the account is real, Google-only, or unknown, and does the
mail work in a background task so the response returns at the same moment in
every case. Otherwise the form is a free tool for discovering who is enrolled.
"""

from __future__ import annotations

import logging
import time

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import account_links
from ..config import settings
from ..db import SessionLocal, get_db
from ..identity import get_current_session
from ..models.auth_token import PURPOSE_ACTIVATION, PURPOSE_RESET
from ..models.user import Role, User
from ..schemas.auth import SessionUser
from ..security import hash_password, note_revocation, verify_password
from ..set_password import password_problem
from .auth import _issue_session, _payload_for, _record_login

log = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["passwords"])


# --------------------------------------------------------------- throttle --
# The login limiter guards wrong passwords. "Forgot password" needs its own
# cap — per address and overall — or it becomes a way to send a student a
# hundred emails. Same in-process, bounded shape as auth.py's, same honesty
# about it: per task, not per fleet.


class _Throttle:
    def __init__(self, limit: int, window_seconds: int, max_keys: int = 4096) -> None:
        self.limit, self.window, self.max_keys = limit, window_seconds, max_keys
        self._hits: dict[str, tuple[float, int]] = {}

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        started, count = self._hits.get(key, (now, 0))
        if now - started >= self.window:
            started, count = now, 0
        if count >= self.limit:
            return False
        if key not in self._hits and len(self._hits) >= self.max_keys:
            self._hits = {k: v for k, v in self._hits.items() if now - v[0] < self.window}
            if len(self._hits) >= self.max_keys:
                self._hits.clear()
        self._hits[key] = (started, count + 1)
        return True

    def reset(self) -> None:
        self._hits.clear()


_forgot_per_address = _Throttle(settings.forgot_password_per_address_per_hour, 3600)
_forgot_global = _Throttle(settings.forgot_password_global_per_hour, 3600)


def reset_throttles() -> None:
    """For tests."""
    _forgot_per_address.reset()
    _forgot_global.reset()


# ------------------------------------------------------------- activation --


class LinkPasswordIn(BaseModel):
    token: str = Field(min_length=16, max_length=200)
    password: str = Field(min_length=1, max_length=256)


@router.post("/activate", response_model=SessionUser)
def activate(
    body: LinkPasswordIn,
    response: Response,
    db: Session = Depends(get_db),
) -> SessionUser:
    """Set a first password from an activation link, and sign in.

    ORDER MATTERS: the password is checked against policy BEFORE the link is
    spent. A refusal for "12 characters minimum" must not burn the link, or a
    typo costs the person a second email from an admin.
    """
    token = body.token.strip()
    live = account_links.peek_user_token(db, PURPOSE_ACTIVATION, token)
    if live is None:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail=account_links.explain_user_token(db, PURPOSE_ACTIVATION, token),
        )
    problem = password_problem(body.password)
    if problem:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=problem)

    user = account_links.consume_user_token(db, PURPOSE_ACTIVATION, token)
    if user is None:  # lost the race to a second click
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail=account_links.explain_user_token(db, PURPOSE_ACTIVATION, token),
        )
    if user.role is Role.STUDENT:
        # Cannot happen through issue_activation, which refuses students; this
        # is the second lock on the same door.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Students sign in with their college Google account.",
        )
    user.password_hash = hash_password(body.password)
    db.commit()
    log.info("activated %s (%s) via link", user.email, user.role.value)

    _record_login(db, user)
    payload = _payload_for(user)
    _issue_session(response, payload)
    return SessionUser(**payload)


# ------------------------------------------------------------------ forgot --


class ForgotIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)


class MessageOut(BaseModel):
    detail: str


_FORGOT_ANSWER = "If that address has a REEP password, we've sent a reset link to it."


def _issue_reset_in_background(email: str) -> None:
    """The half of `forgot` that would reveal whether the account exists if it
    ran in the request. Own session: this runs after the response is gone."""
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == email))
        if user is None or user.role is Role.STUDENT:
            return
        if not user.password_hash.startswith("scrypt:"):
            # Google-only account: nothing to reset, and mailing a link would
            # quietly turn it into a password account.
            return
        account_links.issue_password_reset(db, user)


@router.post("/forgot", response_model=MessageOut, status_code=status.HTTP_202_ACCEPTED)
def forgot(body: ForgotIn, background: BackgroundTasks) -> MessageOut:
    """Always the same answer. The work that differs happens after the reply."""
    email = body.email.strip().lower()
    if not _forgot_global.allow("global") or not _forgot_per_address.allow(email):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many reset requests. Please wait an hour and try again.",
            headers={"Retry-After": "3600"},
        )
    background.add_task(_issue_reset_in_background, email)
    return MessageOut(detail=_FORGOT_ANSWER)


# ------------------------------------------------------------------- reset --


@router.post("/reset", response_model=MessageOut)
def reset(body: LinkPasswordIn, db: Session = Depends(get_db)) -> MessageOut:
    """New password from a reset link. Every device is signed out, including
    this one — the person signs in fresh with what they just chose."""
    token = body.token.strip()
    if account_links.peek_user_token(db, PURPOSE_RESET, token) is None:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail=account_links.explain_user_token(db, PURPOSE_RESET, token),
        )
    problem = password_problem(body.password)
    if problem:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=problem)

    user = account_links.consume_user_token(db, PURPOSE_RESET, token)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail=account_links.explain_user_token(db, PURPOSE_RESET, token),
        )
    user.password_hash = hash_password(body.password)
    # Sign out everywhere: the commonest reason for a reset is that someone
    # else got in. token_version is the one number every session check reads.
    user.token_version = (user.token_version or 0) + 1
    # And no other pending link may finish what this one started.
    account_links.revoke_user_tokens(db, user.id, PURPOSE_RESET)
    db.commit()
    note_revocation(user.id, user.token_version)
    log.info("password reset for %s; all sessions revoked", user.email)
    return MessageOut(detail="Password updated. Sign in with your new password.")


# ----------------------------------------------------------------- change --


class ChangePasswordIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=1, max_length=256)


@router.post("/change-password", response_model=SessionUser)
def change_password(
    body: ChangePasswordIn,
    response: Response,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> SessionUser:
    """Signed in, knows the current password. Other devices out; this one stays.

    "This one stays" is the cookie being re-issued with the NEW token_version
    before the response goes out — otherwise the person who just changed their
    password is signed out by their own change and reads it as a bug.
    """
    user = db.get(User, session["userId"])
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sign in again.")
    if user.role is Role.STUDENT or not user.password_hash.startswith("scrypt:"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This account signs in with Google and has no password to change.",
        )
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="The current password is not right."
        )
    problem = password_problem(body.new_password)
    if problem:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=problem)
    if body.new_password == body.current_password:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The new password is the same as the current one.",
        )

    user.password_hash = hash_password(body.new_password)
    user.token_version = (user.token_version or 0) + 1
    account_links.revoke_user_tokens(db, user.id, PURPOSE_RESET)
    db.commit()
    note_revocation(user.id, user.token_version)

    payload = _payload_for(user)
    _issue_session(response, payload)
    log.info("password changed for %s; other sessions revoked", user.email)
    return SessionUser(**payload)
