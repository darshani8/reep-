"""Setting up an approved student's account: link, code, password. In that order.

THE FLOW THIS REPLACES, and why. Under option B a student never held a
password: provisioning emailed an "enrolment notice" and they signed in with
their college Google account. That was a real design with real reasons, and it
was reversed deliberately on 2026-09-10 — students set a password now. Google
sign-in is untouched and still works for anyone who prefers it; what changed is
that it is no longer the *only* door a student has.

THREE STEPS, THREE DIFFERENT PROOFS. They are not ceremony:

  1. `POST /auth/onboard/start`     the invite link + the address typed back.
     The link proves somebody opened mail sent to the application's address.
     Typing the address back proves they know WHOSE account this is, which a
     link found in a shared inbox does not.
  2. `POST /auth/onboard/verify`    the six digits just mailed.
     This is the only step that proves the mailbox is READABLE RIGHT NOW. A
     forwarded invite survives step 1; it does not survive this.
  3. `POST /auth/onboard/password`  the ticket from step 2 + the new password.
     Accepts the ticket and NOT the invite link, so the code can never be
     skipped by someone holding the link alone.

AND IT DOES NOT SIGN ANYBODY IN. `/auth/activate` does, because a staff member
who just chose a password is plainly present. Here the last thing that happened
was a password being set on an account whose owner has proved a mailbox and
nothing else, so the flow ends at the login screen and the new password is
typed once more against the ordinary sign-in door — which applies the ordinary
brute-force limiter, the ordinary revocation and the ordinary single-device
retirement. One door, not two.

NEVER SAY WHETHER AN ADDRESS EXISTS, same rule as `forgot` in passwords.py: a
mismatched address at step 1 answers exactly what a bad link answers.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import account_links
from ..config import settings
from ..db import get_db
from ..models.auth_token import (
    PURPOSE_ONBOARD,
    PURPOSE_ONBOARD_CODE,
    PURPOSE_ONBOARD_SET,
)
from ..models.user import User
from ..security import hash_password
from ..set_password import password_problem

log = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["onboarding"])

#: One sentence for every way step 1 can fail — bad link, expired link, spent
#: link, right link and the wrong address. Telling them apart would turn the
#: invite into an oracle for "is this person enrolled", and the person who
#: genuinely mistyped their address is helped by the same words.
_REFUSED = (
    "That setup link is not valid, or the email address does not match it. "
    "Check the link in your approval email, or ask the placement office to "
    "send it again."
)


class OnboardStepOut(BaseModel):
    """Named for its surface, not its shape. `passwords.MessageOut` is a
    different screen's message and one name must mean one shape — the guard in
    tests/test_codebase_guards.py exists because two `MessageOut`s in one
    OpenAPI document silently become one generated client type."""

    message: str


class StartIn(BaseModel):
    token: str = Field(min_length=16, max_length=200)
    email: str = Field(min_length=3, max_length=254)


@router.post("/onboard/start", response_model=OnboardStepOut)
def start(body: StartIn, db: Session = Depends(get_db)) -> OnboardStepOut:
    """Step 1 — confirm the address on the invite, and mail a code to it.

    The link is PEEKED, never consumed: a mistyped address must not burn it, or
    one typo costs the student a support call. It is spent at step 3, once.
    """
    token = body.token.strip()
    live = account_links.peek_user_token(db, PURPOSE_ONBOARD, token)
    if live is None:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail=_REFUSED)
    user = db.get(User, live.user_id)
    if user is None or user.email.lower() != body.email.strip().lower():
        # Deliberately the SAME refusal as a dead link. See _REFUSED.
        raise HTTPException(status_code=status.HTTP_410_GONE, detail=_REFUSED)

    account_links.issue_onboarding_code(db, user)
    log.info("onboarding code sent for %s", user.email)
    return OnboardStepOut(
        message=(
            f"We have emailed a {settings.otp_code_minutes}-minute code to "
            f"{user.email}. Enter it below."
        )
    )


class VerifyIn(BaseModel):
    token: str = Field(min_length=16, max_length=200)
    code: str = Field(min_length=4, max_length=12)


class TicketOut(BaseModel):
    ticket: str


@router.post("/onboard/verify", response_model=TicketOut)
def verify(body: VerifyIn, db: Session = Depends(get_db)) -> TicketOut:
    """Step 2 — spend the emailed code, and hand back the ticket for step 3."""
    token = body.token.strip()
    live = account_links.peek_user_token(db, PURPOSE_ONBOARD, token)
    if live is None:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail=_REFUSED)
    user = db.get(User, live.user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail=_REFUSED)

    if not account_links.consume_user_code(
        db, user.id, PURPOSE_ONBOARD_CODE, body.code.strip()
    ):
        # A wrong code, an expired one and a replay read the same, because
        # `consume_user_code` cannot tell them apart without becoming an
        # oracle — and its clock is flat either way.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="That code is not right, or it has expired. Ask for a new one.",
        )
    db.commit()
    ticket = account_links.issue_onboarding_ticket(db, user)
    log.info("onboarding address confirmed for %s", user.email)
    return TicketOut(ticket=ticket)


class SetPasswordIn(BaseModel):
    ticket: str = Field(min_length=16, max_length=200)
    password: str = Field(min_length=1, max_length=256)


@router.post("/onboard/password", response_model=OnboardStepOut)
def set_first_password(body: SetPasswordIn, db: Session = Depends(get_db)) -> OnboardStepOut:
    """Step 3 — set the password. Ends at the login screen, signs nobody in.

    ORDER MATTERS, the same order `/auth/activate` uses: policy is checked
    BEFORE the ticket is spent, so "12 characters minimum" does not cost the
    student their ticket and a second code.
    """
    ticket = body.ticket.strip()
    live = account_links.peek_user_token(db, PURPOSE_ONBOARD_SET, ticket)
    if live is None:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail=(
                "This page has expired. Open your setup link again and ask for "
                "a new code."
            ),
        )
    problem = password_problem(body.password)
    if problem:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=problem)

    user = account_links.consume_user_token(db, PURPOSE_ONBOARD_SET, ticket)
    if user is None:  # lost the race to a second submit
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="This page has expired. Open your setup link again.",
        )
    user.password_hash = hash_password(body.password)
    # The invite is spent here and not at step 1, so the whole walk is one
    # single-use act: a link that reached step 3 cannot be walked again.
    account_links.revoke_user_tokens(db, user.id, PURPOSE_ONBOARD)
    db.commit()
    log.info("onboarding complete for %s (%s)", user.email, user.role.value)
    return OnboardStepOut(message="Your password is set. You can sign in now.")
