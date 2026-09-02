"""The email & password door's two code endpoints. The password door itself is
POST /api/auth/login in app/routers/auth.py; this router is the part that gets a
student a password in the first place.

  POST /api/auth/password/otp   -> email a one-time code (202, always)
  POST /api/auth/password/set   -> code + new password -> signed in (200)

Both take an OPTIONAL session (app/identity.py:get_optional_session): no cookie
is the create / forgot flow, a cookie is the change flow, and the only
difference is that a present session must name the address being changed.

FAILURES RETURN JSON, not `?error=` redirects: these are XHR calls from the SPA,
not top-level navigations, so the `sso_*` code contract in auth.py is untouched
and tests/test_sso_contract.py stays exactly as strict as it was.

EVERY GATE FIRES BEFORE THE DATABASE. 503 (the door is not configured), 429
(this network is spending the window), 403 (a signed-in caller naming someone
else's address) and 422 (a weak password) are all answered from the request and
the settings alone. What reaches the database is one shape of request, and for
/otp not even that: the handler schedules app/local_auth.py:request_code and
answers 202, so the response cannot say whether the address exists.
"""

from __future__ import annotations

import hmac
import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from .. import local_auth
from ..config import settings
from ..db import get_db
from ..identity import get_optional_session
from ..schemas.auth import SessionUser
from ..security import note_revocation
from .auth import _issue_session, _payload_for, _record_login

log = logging.getLogger(__name__)

router = APIRouter(prefix="/auth/password", tags=["auth"])

# One sentence for every way a code can fail to verify: unknown address,
# off-domain, no live code, wrong, exhausted, expired, already used. A more
# specific message is an oracle for one of those.
_CODE_REFUSED = (
    "That code is not valid or has expired. Only the newest code works - check the "
    "latest email, or request a new one."
)
_SESSION_MISMATCH = (
    "You are signed in as a different address. Sign out first, or use the address "
    "you signed in with."
)


class OtpRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)


class OtpAccepted(BaseModel):
    ok: bool = True
    resend_after_seconds: int = local_auth.RESEND_AFTER_SECONDS


class SetPasswordRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    code: str
    new_password: str = Field(min_length=1, max_length=local_auth.PASSWORD_MAX_CHARS + 1)

    @field_validator("code", mode="before")
    @classmethod
    def _six_digits(cls, value: object) -> str:
        text = str(value).strip() if value is not None else ""
        if len(text) != local_auth.OTP_DIGITS or not text.isdigit():
            raise ValueError(f"the code is {local_auth.OTP_DIGITS} digits")
        return text


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _gate() -> None:
    """503 with the reason, before anything else. The voice 503 shape: the door
    is not configured, and nothing about that is a boot failure."""
    if not settings.local_auth_ready:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=settings.local_auth_unready_reason,
        )


def _too_many(retry_after: int, detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=detail,
        headers={"Retry-After": str(retry_after)},
    )


def _bind_session(session: dict | None, email: str) -> None:
    """A present session may only act on its own address. Compares two strings
    the caller already knows; says nothing about the roster."""
    if session is None:
        return
    if str(session.get("email", "")).strip().lower() != email:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=_SESSION_MISMATCH)


@router.post("/otp", status_code=status.HTTP_202_ACCEPTED, response_model=OtpAccepted)
def request_otp(
    body: OtpRequest,
    request: Request,
    background: BackgroundTasks,
    session: dict | None = Depends(get_optional_session),
) -> OtpAccepted:
    """Email a code to an enrolled college address. Answers 202 for every
    address; the work happens after the response, in local_auth.request_code."""
    _gate()
    wait = local_auth.OTP_REQUESTS_PER_IP.retry_after(_client_ip(request))
    if wait is not None:
        raise _too_many(
            wait, "Too many code requests from this network. Try again in a few minutes."
        )
    email = local_auth.normalise_email(body.email)
    _bind_session(session, email)
    background.add_task(local_auth.request_code, email)
    return OtpAccepted()


@router.post("/set", response_model=SessionUser)
def set_password(
    body: SetPasswordRequest,
    request: Request,
    response: Response,
    session: dict | None = Depends(get_optional_session),
    db: Session = Depends(get_db),
) -> SessionUser:
    """Code + new password -> the password is set and the caller is signed in on a
    fresh cookie that is the only one still valid for this account."""
    _gate()
    wait = local_auth.OTP_SET_PER_IP.retry_after(_client_ip(request))
    if wait is not None:
        raise _too_many(wait, "Too many attempts from this network. Try again in a few minutes.")
    email = local_auth.normalise_email(body.email)
    _bind_session(session, email)
    problem = local_auth.validate_new_password(email, body.new_password)
    if problem:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=problem)

    refused = HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=_CODE_REFUSED)
    if not local_auth.address_allowed(email):
        hmac.compare_digest(local_auth.otp_hash("-", "-", body.code), local_auth.otp_hash("-", "-", "0"))
        raise refused
    user = local_auth.find_user(db, email)
    if user is None:
        hmac.compare_digest(local_auth.otp_hash("-", "-", body.code), local_auth.otp_hash("-", "-", "0"))
        raise refused
    otp = local_auth.verify_code(db, user, local_auth.PURPOSE_PASSWORD, body.code)
    if otp is None:
        raise refused

    version = local_auth.consume_and_set_password(db, user, otp, body.new_password)
    # This worker refuses the user's other cookies immediately; other workers
    # within AUTH_REVOCATION_CACHE_SECONDS. The cookie issued below carries the
    # new version and is the one survivor.
    note_revocation(user.id, version)
    log.info("auth-otp: password set for user %s", user.id)

    _record_login(db, user)
    payload = _payload_for(user)
    _issue_session(response, payload)
    return SessionUser(**payload)
