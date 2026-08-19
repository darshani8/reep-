"""Auth endpoints — password sign-in (dev/CI) and Google sign-in (everywhere).

  POST /api/auth/login                 -> email + password. REFUSED when ENV=prod.
  GET  /api/auth/sso/status            -> which sign-in doors this server offers
  GET  /api/auth/sso/google            -> begin Google sign-in (302 to Google)
  GET  /api/auth/sso/google/callback   -> finish it (302 back into the SPA)
  GET  /api/auth/me                    -> the current session
  POST /api/auth/logout                -> clear the cookie

THE CALLBACK PATH IS A CONTRACT, not a preference. It is registered as an
"Authorised redirect URI" on the Google OAuth client, derived by
app/google_auth.py:redirect_uri() from google_auth.CALLBACK_PATH, and documented
in .env.example. Google compares the redirect_uri byte for byte between the
authorize request and the token exchange, so renaming this route without
changing all four places fails every sign-in with `redirect_uri_mismatch` and
nothing in this repo to point at. `/api/auth/sso/google` is also the href the
login screen carries (apps/web .../login/login.component.ts:signInUrl), and
`/api/auth/sso/status` is the capability probe it reads before rendering — both
canonical, neither an alias, because a login screen pointed at a hidden
back-compat path becomes collateral damage the day the alias is tidied away.

ONE SESSION, TWO DOORS. Both sign-in paths end in the same three lines:
`_record_login`, `_payload_for`, `_issue_session`. The cookie is the same
httpOnly `reep_session`, signed the same way, carrying the same camelCase claims
(userId/email/name/role/studentId?/mentorId?) that the Next.js app minted and
that every consumer still reads — app/deps.py, require_mentor,
_assert_can_access_student, the WebSocket auth in app/routers/interview.py, and
the Angular `SessionPayload`. Google authenticates; it does not authorise, and it
does not get a session mechanism of its own. Nothing downstream can tell which
door a session came through, which is exactly the point.

THE ROSTER IS THE ALLOWLIST. A verified Google identity whose email matches no
`User` row is refused. There is no just-in-time provisioning: a provisioned
account would need a role invented for it, and AGENTS.md rule 2 makes guessing a
role a data-exposure bug rather than a UX one (a wrong MENTOR/DIRECTOR reads
every student's marks, attendance and USN). Accounts are created from the roster
by `python -m app.seed_roster`, which is also where the USN comes from — so a
student's profile shows it already filled in and they never type it.

FAILURES REDIRECT, THEY DO NOT RETURN JSON. The callback is a top-level browser
navigation: a 4xx there is a raw FastAPI error page outside the SPA. Every
failure lands on `{WEB_ORIGIN}/login?error=<code>` instead, and the login screen
turns the code into a sentence. The codes are:

    sso_config           Google sign-in is not configured on this server
    sso_denied           the student cancelled at Google's consent screen
    sso_state            state/cookie missing or mismatched (see read_flow_state)
    sso_token            code exchange failed (config, network, spent code)
    sso_identity         the ID token did not verify
    sso_unverified_email Google reports the address as unverified
    sso_not_enrolled     verified, but no roster row for that address
    sso_failed           the backstop: anything not enumerated above

THIS LIST IS A CONTRACT with `messageFor` in
apps/web/src/app/features/login/login.component.ts and with the table in
docs/google-sign-in.md. Adding a code in one place and not the others is
invisible to pytest, tsc and ng build alike, and it lands the student on the
"reason unknown to this page" fallback — which is exactly what happened the
first time these three lists were written independently.
"""

import logging
from datetime import date, datetime, timezone

from fastapi import APIRouter, Cookie, Depends, HTTPException, Query, Response, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .. import google_auth
from ..config import settings
from ..db import get_db
from ..deps import get_current_session
from ..models.user import LoginDay, User
from ..schemas.auth import LoginRequest, SessionUser
from ..security import (
    SESSION_COOKIE,
    SESSION_TTL_SECONDS,
    create_session_token,
    verify_password,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# Where a signed-in user lands when the flow carries no `?next=`. Mirrors
# HOME_FOR_ROLE in apps/web/src/app/features/login/login.component.ts, because
# the SPA's own `''` route redirects to /student unconditionally — sending a
# DIRECTOR there would bounce them off a student-only screen on every sign-in.
_HOME_FOR_ROLE = {
    "STUDENT": "/student",
    "MENTOR": "/mentor",
    "DIRECTOR": "/director",
    "ADMIN": "/director",
}
_DEFAULT_HOME = "/student"


def _payload_for(user: User) -> dict:
    payload = {
        "userId": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role.value,
    }
    if user.student is not None:
        payload["studentId"] = user.student.id
    if user.mentor is not None:
        payload["mentorId"] = user.mentor.id
    return payload


def _record_login(db: Session, user: User) -> None:
    """last_login_at + the per-day streak row. BOTH sign-in paths call this.

    GET /api/student/dashboard counts LoginDay rows for the streak, so a door
    that authenticates without writing here produces a perfectly good session
    and a streak that silently stops counting — visible to the student, and
    attributable to nothing.
    """
    user.last_login_at = datetime.now(timezone.utc)
    # Local calendar date, matching the Next.js streak bucketing.
    local = datetime.now()
    today = date(local.year, local.month, local.day)
    already = db.scalar(
        select(LoginDay).where(LoginDay.user_id == user.id, LoginDay.day == today)
    )
    if already is None:
        db.add(LoginDay(user_id=user.id, day=today))
    db.commit()


def _issue_session(response: Response, payload: dict) -> None:
    """Set the one and only session cookie. `secure` follows ENV, nothing else."""
    response.set_cookie(
        SESSION_COOKIE,
        create_session_token(payload),
        httponly=True,
        samesite="lax",
        secure=settings.is_prod,
        path="/",
        max_age=SESSION_TTL_SECONDS,
    )


def _safe_next(raw: str | None) -> str:
    """An in-app destination, or "" — the server-side half of the open-redirect check.

    apps/web login.component.ts applies the same rule to `?next=`, but that check
    is bypassed entirely in the Google flow: the value survives the hop inside the
    state cookie and is consumed HERE, by a Location header the browser follows
    without the SPA ever seeing it. This is the only place an open redirect could
    be introduced, so the rule is re-applied rather than trusted.

    Rejected: anything not starting "/", protocol-relative "//evil.test", and
    "/\\evil.test" — browsers normalise a backslash to a forward slash, so the
    latter is protocol-relative in every engine despite passing a naive check.
    """
    value = (raw or "").strip()
    if not value.startswith("/"):
        return ""
    if value.startswith("//") or value.startswith("/\\"):
        return ""
    return value


def _app_url(path: str) -> str:
    return f"{settings.web_origin.rstrip('/')}{path}"


def _sso_failure(code: str) -> RedirectResponse:
    """Back to the login screen with a reason, and the flow cookie destroyed."""
    resp = RedirectResponse(
        _app_url(f"/login?error={code}"), status_code=status.HTTP_302_FOUND
    )
    _clear_flow_cookie(resp)
    return resp


def _clear_flow_cookie(response: Response) -> None:
    """Delete the transient state cookie. Called on EVERY callback outcome.

    This is what makes the state single-use: once the cookie is gone, replaying
    the same callback URL arrives with nothing to match against and is refused.
    The attributes mirror the ones it was set with — browsers match a deletion on
    name/domain/path alone, but keeping them in step avoids the asymmetry that
    would bite the day a Domain or SameSite=None is added.
    """
    response.delete_cookie(
        google_auth.FLOW_COOKIE,
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.is_prod,
    )


@router.post("/login", response_model=SessionUser)
def login(body: LoginRequest, response: Response, db: Session = Depends(get_db)) -> SessionUser:
    """Email + password. A DEV AND CI AFFORDANCE THAT PRODUCTION REFUSES.

    Sign-in is Google-only for real users, for every role. This endpoint is kept
    — not deleted — because tests/conftest.py's `login` fixture and the six test
    modules that use it (test_auth_rbac, test_conversations, test_feedback,
    test_knowledge, test_metrics, test_orchestrator) authenticate through it, and
    an OAuth round-trip cannot be driven from a TestClient without either
    stubbing Google or shipping a second, weaker door that exists in production.
    Refusing outside dev/CI is that second door not existing where it matters,
    and it is the same guard shape app/seed.py uses for the same kind of reason:
    some things must not merely be discouraged in production, they must be
    impossible there.

    `password_login_allowed`, NOT `not is_prod`: an allowlist of the environments
    this endpoint serves, so an ENV nobody anticipated shuts the door rather than
    opening it (see app/config.py). The guard fires BEFORE the database is
    touched, so it cannot be probed for which accounts exist and cannot be
    defeated by a timing difference.
    """
    if not settings.password_login_allowed:
        log.warning(
            "POST /api/auth/login -> 403: password sign-in is disabled when ENV=%r "
            "(Google sign-in only); this endpoint exists for dev and CI",
            settings.env,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Password sign-in is disabled. Use Continue with Google.",
        )

    email = body.email.strip().lower()
    user = db.scalar(select(User).where(User.email == email))
    # One message for both cases — never reveal which of email/password was wrong.
    # `not user.password_hash` covers a roster account that has no usable local
    # password: without it, verify_password would raise AttributeError on None and
    # turn a 401 into a 500, which is both a crash and an account-existence oracle.
    if (
        user is None
        or not user.password_hash
        or not verify_password(body.password, user.password_hash)
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        )

    _record_login(db, user)
    payload = _payload_for(user)
    _issue_session(response, payload)
    return SessionUser(**payload)


class SsoStatus(BaseModel):
    """What the login screen needs in order to render itself honestly.

    THE FIELD NAMES ARE THE WIRE CONTRACT with the `SsoStatus` interface in
    apps/web/.../login/login.component.ts. They are snake_case there too, on
    purpose: renaming on the way in is how a probe silently stops working, since
    `undefined === false` is false and the button then stays live forever on a
    server that cannot sign anybody in.

    `domain` is the institution's mail domain — the same value app.seed_roster
    derives addresses from. Served rather than baked into the Angular bundle
    because the convention is the one guess this design makes about the outside
    world, and a wrong guess must be fixable with a .env edit and no rebuild.
    Public and non-sensitive: it is printed on the college's own letterhead.
    """

    google_available: bool
    password_login_available: bool
    domain: str
    reason: str | None = None


@router.get("/sso/status", response_model=SsoStatus)
# Back-compat alias, matching the ones `/google/start` and `/google/callback`
# carry. The first cut of the login screen probed THIS path while the router
# served only /sso/status, and the consequence was silent rather than loud: a
# 404, a probe that fails open, a live Google button on a server with no
# credentials, and every student told to use the account ending "@your college"
# because the domain never arrived. The screen now calls the canonical path;
# this stays for anything else that was written against the old one. Hidden from
# the schema so /docs shows one status endpoint, not two.
@router.get("/google/status", response_model=SsoStatus, include_in_schema=False)
def sso_status() -> SsoStatus:
    """What sign-in methods this server actually offers. Unauthenticated by design.

    The login screen probes this before rendering, the same way the assistant
    probes GET /api/interview/status and GET /api/voice/status. Rendering a live
    "Continue with Google" button on a server with no GOOGLE_CLIENT_ID
    reproduces exactly the failure AGENTS.md already documents for voice: the
    button looks fine, the click fails, and nothing anywhere says the feature was
    never configured. Discloses no account data — only which doors exist.
    """
    if google_auth.sso_ready():
        return SsoStatus(
            google_available=True,
            password_login_available=settings.password_login_allowed,
            domain=settings.roster_domain,
        )
    reason = "Google sign-in is not configured on this server yet."
    if settings.is_prod:
        # Nothing works. Say so loudly here, because there is no other door.
        log.error("GET /api/auth/sso/status -> 200 unavailable: ENV=prod and %s", reason)
    return SsoStatus(
        google_available=False,
        password_login_available=settings.password_login_allowed,
        domain=settings.roster_domain,
        reason=reason,
    )


@router.get("/sso/google")
# The path this module was specified against, kept so a link or bookmark written
# to it still works. One handler, no duplicated logic; hidden from the schema so
# /docs shows the single canonical route.
@router.get("/google/start", include_in_schema=False)
def google_start(next_: str = Query("", alias="next")) -> RedirectResponse:
    """Begin Google sign-in: mint state + nonce, stash them, redirect to Google."""
    if not google_auth.sso_ready():
        log.error(
            "GET /api/auth/sso/google -> 302 /login?error=sso_config: "
            "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set in apps/api-py/.env"
        )
        return _sso_failure("sso_config")

    flow, cookie_value = google_auth.new_flow_state(_safe_next(next_))
    resp = RedirectResponse(
        google_auth.authorization_url(flow.state, flow.nonce),
        status_code=status.HTTP_302_FOUND,
    )
    resp.set_cookie(
        google_auth.FLOW_COOKIE,
        cookie_value,
        httponly=True,
        # LAX, NEVER STRICT. The callback is a top-level GET whose referrer is
        # accounts.google.com; a Strict cookie is not sent on that navigation, so
        # the state check would fail 100% of the time and look like "Google is
        # broken". Lax is precisely the case that permits it — and it is the same
        # policy the session cookie already runs under.
        samesite="lax",
        secure=settings.is_prod,
        path="/",
        max_age=google_auth.FLOW_TTL_SECONDS,
    )
    return resp


@router.get("/sso/google/callback")
# Alias, for the same reason as /google/start. Google itself only ever calls the
# canonical path — it is the one registered on the OAuth client.
@router.get("/google/callback", include_in_schema=False)
def google_callback(
    code: str | None = Query(None),
    state: str | None = Query(None),
    error: str | None = Query(None),
    flow_cookie: str | None = Cookie(None, alias=google_auth.FLOW_COOKIE),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    """Finish Google sign-in: validate state, exchange, verify, look up, admit.

    Order matters. The state is checked FIRST, before the code is spent, so a
    forged callback costs nothing and teaches nothing. The roster lookup is
    LAST, on an identity that has already proved it is a Google-verified address
    — matching on an unverified email would let anyone claim a student's row.
    """
    if not google_auth.sso_ready():
        log.error(
            "GET /api/auth/sso/google/callback -> 302 /login?error=sso_config: "
            "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set"
        )
        return _sso_failure("sso_config")

    if error:
        # The student pressed Cancel, or Google refused the request outright.
        log.info("GET /api/auth/sso/google/callback -> 302 /login?error=sso_denied: %s", error)
        return _sso_failure("sso_denied")

    try:
        flow = google_auth.read_flow_state(flow_cookie, state)
    except google_auth.GoogleAuthError as exc:
        log.warning("GET /api/auth/sso/google/callback -> 302 /login?error=%s: %s", exc.code, exc)
        return _sso_failure(exc.code)
    except Exception:
        # Same backstop, same reason as the one below: `state` is raw query
        # string, and this step is the first thing that touches it.
        log.exception(
            "GET /api/auth/sso/google/callback -> 302 /login?error=sso_failed: "
            "unexpected error validating the sign-in state"
        )
        return _sso_failure("sso_failed")

    if not code:
        log.warning(
            "GET /api/auth/sso/google/callback -> 302 /login?error=sso_token: "
            "state validated but no authorization code was returned"
        )
        return _sso_failure("sso_token")

    try:
        identity = google_auth.verify_id_token(
            google_auth.exchange_code(code), nonce=flow.nonce
        )
        # Compared case-INSENSITIVELY. `users.email` is a case-preserving column
        # and nothing in the schema forces lowercase, while Google always hands
        # us a lowercased address. app.seed_roster and app.grant_access both
        # lowercase, so this holds today — but with password sign-in refused in
        # production, one capital letter in a row inserted by any other route is
        # a permanent lockout with no second door to diagnose it through. At 33
        # students the lost index scan is not measurable.
        user = db.scalar(select(User).where(func.lower(User.email) == identity.email))
    except google_auth.GoogleAuthError as exc:
        log.warning("GET /api/auth/sso/google/callback -> 302 /login?error=%s: %s", exc.code, exc)
        return _sso_failure(exc.code)
    except Exception:
        # THE BACKSTOP FOR THE RULE THIS MODULE STATES AS A CONTRACT. A callback
        # is a top-level browser navigation, so an uncaught exception is a raw
        # traceback page outside the SPA rather than a sentence a student can act
        # on. Enumerating exception types is precisely how that rule gets quietly
        # broken — a TypeError out of compare_digest, a PyJWKSetError, a dead
        # database — so the last resort is a type, not a list. log.exception
        # keeps the traceback for the operator; the browser gets the redirect.
        log.exception(
            "GET /api/auth/sso/google/callback -> 302 /login?error=sso_failed: "
            "unexpected error finishing Google sign-in"
        )
        return _sso_failure("sso_failed")

    if user is None:
        # THE ALLOWLIST. Logged with the address because that is the one fact the
        # placement office needs to fix it (a roster typo, or a personal Gmail
        # instead of the institutional account); the browser is told only that
        # this account is not on the roster, which discloses nothing the person
        # signing in does not already control.
        log.warning(
            "GET /api/auth/sso/google/callback -> 302 /login?error=sso_not_enrolled: "
            "verified Google account %s has no user row (not on the roster)",
            identity.email,
        )
        return _sso_failure("sso_not_enrolled")

    # Built BEFORE the write, not after: `_record_login` commits, a commit
    # expires every loaded attribute, and reading them back on a database that
    # has just failed would raise from inside the recovery path.
    payload = _payload_for(user)
    try:
        _record_login(db, user)
    except SQLAlchemyError:
        # The streak row is telemetry; the session is the product. A verified
        # identity has already been established at this point, and letting a
        # failed write on a LoginDay row turn it into a 500 would refuse a
        # legitimate sign-in over a counter. The under-count is logged so it is
        # attributable, which is the thing _record_login's own docstring says
        # matters about it.
        db.rollback()
        log.exception(
            "GET /api/auth/sso/google/callback: could not record the login for %s "
            "(session still issued; the streak will under-count)",
            payload["email"],
        )

    destination = flow.next_path or _HOME_FOR_ROLE.get(payload["role"], _DEFAULT_HOME)

    resp = RedirectResponse(_app_url(destination), status_code=status.HTTP_302_FOUND)
    _clear_flow_cookie(resp)
    _issue_session(resp, payload)
    # The Google `sub` is logged and nowhere else recorded: the account is keyed
    # on the email string alone, so if the college ever re-provisions an address
    # the new holder inherits the old student's marks, uploads and mentor notes
    # silently. A line naming the Google principal behind each session is the
    # zero-migration half of that — the other half is a users.google_sub column,
    # pinned on first sign-in and compared thereafter, when a migration is due.
    log.info(
        "GET /api/auth/sso/google/callback -> 302 %s: signed in %s (%s) as Google sub %s",
        destination,
        payload["email"],
        payload["role"],
        identity.sub,
    )
    return resp


@router.get("/me", response_model=SessionUser)
def me(session: dict = Depends(get_current_session)) -> SessionUser:
    return SessionUser(**session)


@router.post("/logout")
def logout(response: Response) -> dict:
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}
