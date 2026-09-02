"""Auth endpoints â password sign-in (dev/CI, or opted in) and Google sign-in (everywhere).

  POST /api/auth/login                 -> email + password (see password_login_allowed)
  POST /api/auth/password/otp          -> email a one-time code   (app/routers/local_auth.py)
  POST /api/auth/password/set          -> code + new password -> signed in (same file)
  GET  /api/auth/sso/status            -> which sign-in doors this server offers
  GET  /api/auth/sso/google            -> begin Google sign-in (302 to Google)
  GET  /api/auth/sso/google/callback   -> finish it (302 back into the SPA)
  GET  /api/auth/me                    -> the current session
  POST /api/auth/logout                -> clear the cookie AND revoke the token

THE CALLBACK PATH IS A CONTRACT, not a preference. It is registered as an
"Authorised redirect URI" on the Google OAuth client, derived by
app/google_auth.py:redirect_uri() from google_auth.CALLBACK_PATH, and documented
in .env.example. Google compares the redirect_uri byte for byte between the
authorize request and the token exchange, so renaming this route without
changing all four places fails every sign-in with `redirect_uri_mismatch` and
nothing in this repo to point at. `/api/auth/sso/google` is also the href the
login screen carries (apps/web .../login/login.component.ts:signInUrl), and
`/api/auth/sso/status` is the capability probe it reads before rendering â both
canonical, neither an alias, because a login screen pointed at a hidden
back-compat path becomes collateral damage the day the alias is tidied away.

ONE SESSION, TWO DOORS. Both sign-in paths end in the same three lines:
`_record_login`, `_payload_for`, `_issue_session`. The cookie is the same
httpOnly `reep_session`, signed the same way, carrying the same camelCase claims
(userId/email/name/role/studentId?/mentorId?) that the Next.js app minted and
that every consumer still reads â app/identity.py, require_mentor,
_assert_can_access_student, the WebSocket auth in app/routers/interview.py, and
the Angular `SessionPayload`. Google authenticates; it does not authorise, and it
does not get a session mechanism of its own. Nothing downstream can tell which
door a session came through, which is exactly the point.

THE ROSTER IS THE ALLOWLIST. A verified Google identity whose email matches no
`User` row is refused. There is no just-in-time provisioning: a provisioned
account would need a role invented for it, and AGENTS.md rule 2 makes guessing a
role a data-exposure bug rather than a UX one (a wrong MENTOR/DIRECTOR reads
every student's marks, attendance and USN). Accounts are created from the roster
by `python -m app.seed_roster`, which is also where the USN comes from. The
password door reads the same roster and adds a domain fence (app/local_auth.py) â so a
student's profile shows it already filled in and they never type it.

THE EMAIL FINDS THE ROW; THE GOOGLE `sub` PINS IT. An institutional address is a
lease the college re-issues to the next intake, so matching on the address alone
meant a new holder of 1mp25mdm01@ signed in â verified, error-free â into the
previous student's marks, uploads and mentor notes. `users.google_sub` is set on
the first Google sign-in and compared on every one after; a mismatch is refused
(`sso_identity_mismatch`) and logged rather than reconciled, because only a
human can tell a legitimate re-issue from someone who arranged one.

A SESSION CAN NOW BE REVOKED, within the limits app/security.py states plainly.
`users.token_version` rides in the token and logout bumps it, so signing out on
a shared lab machine finally invalidates a copy of the cookie rather than merely
forgetting it here. It is best-effort across workers, not a session store.

FAILURES REDIRECT, THEY DO NOT RETURN JSON. The callback is a top-level browser
navigation: a 4xx there is a raw FastAPI error page outside the SPA. Every
failure lands on `{WEB_ORIGIN}/login?error=<code>` instead, and the login screen
turns the code into a sentence. The codes are:

    sso_config            Google sign-in is not configured on this server
    sso_denied            the student cancelled at Google's consent screen
    sso_state             state/cookie missing or mismatched (see read_flow_state)
    sso_token             code exchange failed (config, network, spent code)
    sso_identity          the ID token did not verify
    sso_unverified_email  Google reports the address as unverified
    sso_not_enrolled      verified, but no roster row for that address
    sso_identity_mismatch the roster row is pinned to a DIFFERENT Google account
    sso_failed            the backstop: anything not enumerated above

THIS LIST IS A CONTRACT with `messageFor` in
apps/web/src/app/features/login/login.component.ts and with the table in
docs/google-sign-in.md. Adding a code in one place and not the others is
invisible to pytest, tsc and ng build alike, and it lands the student on the
"reason unknown to this page" fallback â which is exactly what happened the
first time these three lists were written independently.
"""

import logging
import secrets
from datetime import date, datetime, timezone

from fastapi import APIRouter, Cookie, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .. import google_auth, local_auth
from ..config import settings
from ..db import get_db
from ..identity import get_current_session
from ..models.user import LoginDay, User
from ..schemas.auth import LoginRequest, SessionUser
from ..security import (
    SESSION_COOKIE,
    SESSION_TTL_SECONDS,
    SESSION_VERSION_CLAIM,
    create_session_token,
    has_usable_password,
    hash_password,
    note_revocation,
    verify_password,
    verify_session_token,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# A real scrypt hash of a value nobody can log in with, verified against on the
# unknown-email/no-hash path of /login so a refusal costs the same scrypt work
# as a wrong password â see the comment at the call site. Computed once at
# import (one scrypt, tens of ms, at boot) rather than pasted as a literal that
# silently rots if the hash format ever changes.
_TIMING_EQUALIZER_HASH = hash_password(secrets.token_urlsafe(32))

# Where a signed-in user lands when the flow carries no `?next=`. Mirrors
# HOME_FOR_ROLE in apps/web/src/app/core/session.ts (the SPA's `''` route now
# routes by role too, via homeRedirectGuard) â keep the two maps in step.
_HOME_FOR_ROLE = {
    "STUDENT": "/student",
    "MENTOR": "/mentor",
    "DIRECTOR": "/director",
    "ADMIN": "/director",
    "ALUMNI": "/alumni",
}
_DEFAULT_HOME = "/student"


def _cookie_secure() -> bool:
    """Whether the auth cookies carry `Secure`. ONE ANSWER, FOUR CALL SITES.

    This used to be `secure=settings.is_prod` written out at each of them, and
    `is_prod` is true only for the four spellings in _PROD_ENV_NAMES. A
    staging/uat/demo box â on HTTPS, holding real roster rows, because that is
    what a staging box is for â therefore issued the session cookie WITHOUT
    `Secure`, so any downgraded or plain-HTTP request leaked it. The test was
    asking the wrong question: `Secure` is not a property of production, it is
    the default for everything, and the only environments that may go without it
    are the ones served over plain http://localhost.

    So it is inverted and fails CLOSED, the same shape `password_login_allowed`
    already uses: an ENV nobody anticipated gets `Secure`, and losing the cookie
    on a http:// dev box is a loud, five-second diagnosis â whereas the failure
    this replaces was silent and shipped.

    Behind one function rather than four literals because the four MUST agree:
    a browser matches a deletion on name/domain/path, but a cookie set `Secure`
    and deleted without it is exactly the asymmetry `_clear_flow_cookie` was
    written to avoid.
    """
    return not settings.insecure_cookies_allowed


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
    # OMITTED WHILE IT IS ZERO, which is the state of every user who has never
    # logged out. app/security.py reads an absent claim as version 0 â it has to,
    # or the deploy that added the column would sign everyone out â so writing
    # `tokenVersion: 0` would say exactly nothing at the cost of putting a new
    # key in the claim set that app/identity.py, the interview WebSocket, the Angular
    # `SessionPayload` and tests/test_google_callback.py all describe as the
    # contract. The claim appears the moment it means something.
    if user.token_version:
        payload[SESSION_VERSION_CLAIM] = user.token_version
    return payload


def _record_login(db: Session, user: User) -> None:
    """last_login_at + the per-day streak row. BOTH sign-in paths call this.

    GET /api/student/dashboard counts LoginDay rows for the streak, so a door
    that authenticates without writing here produces a perfectly good session
    and a streak that silently stops counting â visible to the student, and
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
    """Set the one and only session cookie. See `_cookie_secure` for `secure`."""
    response.set_cookie(
        SESSION_COOKIE,
        create_session_token(payload),
        httponly=True,
        samesite="lax",
        secure=_cookie_secure(),
        path="/",
        max_age=SESSION_TTL_SECONDS,
    )


def _safe_next(raw: str | None) -> str:
    """An in-app destination, or "" â the server-side half of the open-redirect check.

    apps/web login.component.ts applies the same rule to `?next=`, but that check
    is bypassed entirely in the Google flow: the value survives the hop inside the
    state cookie and is consumed HERE, by a Location header the browser follows
    without the SPA ever seeing it. This is the only place an open redirect could
    be introduced, so the rule is re-applied rather than trusted.

    Rejected: anything not starting "/", protocol-relative "//evil.test", and
    "/\\evil.test" â browsers normalise a backslash to a forward slash, so the
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
    The attributes mirror the ones it was set with â browsers match a deletion on
    name/domain/path alone, but keeping them in step avoids the asymmetry that
    would bite the day a Domain or SameSite=None is added.
    """
    response.delete_cookie(
        google_auth.FLOW_COOKIE,
        path="/",
        httponly=True,
        samesite="lax",
        secure=_cookie_secure(),
    )


@router.post("/login", response_model=SessionUser)
def login(
    body: LoginRequest, request: Request, response: Response, db: Session = Depends(get_db)
) -> SessionUser:
    """Email + password: the second door, beside Google.

    OPEN in dev/CI without configuration (tests/conftest.py's fixtures and the
    modules that post here authenticate through it, and an OAuth round-trip
    cannot be driven from a TestClient), and in ANY environment that opts in
    with LOCAL_AUTH_ENABLED and a ready email transport - because a password a
    student cannot obtain is not a door. `password_login_allowed` (app/config.py)
    is that rule and it is still an allowlist, never `not is_prod`: an ENV
    nobody anticipated shuts this door rather than opening it.

    ORDER: guard -> per-IP window -> per-address window -> lookup (case-
    insensitive) -> domain fence -> usable hash -> verify -> session. Every gate
    fires BEFORE the database, so nothing here can be probed for which accounts
    exist, and every refusal below the guard is the same 401 at the same cost:
    the scrypt equaliser is burned for an unknown address, an off-domain one AND
    a roster row that has never set a password, so the sentinel is not a
    stopwatch oracle either.
    """
    if not settings.password_login_allowed:
        log.warning(
            "POST /api/auth/login -> 403: password sign-in is not available when "
            "ENV=%r (%s)",
            settings.env,
            settings.local_auth_unready_reason,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Password sign-in is not available on this server. Use Continue with Google.",
        )

    client_ip = request.client.host if request.client else "unknown"
    email = local_auth.normalise_email(body.email)
    too_many = (
        "Too many failed sign-in attempts. Wait a few minutes, or reset your password "
        "with an emailed code."
    )
    for window, key in (
        (local_auth.LOGIN_IP_FAILURES, client_ip),
        (local_auth.LOGIN_ADDRESS_FAILURES, email),
    ):
        wait = window.blocked(key)
        if wait is not None:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=too_many,
                headers={"Retry-After": str(wait)},
            )

    def _refuse() -> HTTPException:
        # Every 401 records one failure on both windows; a success clears the
        # address window below. The message hides which case this is.
        local_auth.LOGIN_IP_FAILURES.hit(client_ip)
        local_auth.LOGIN_ADDRESS_FAILURES.hit(email)
        return HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        )

    user = local_auth.find_user(db, email)
    if (
        user is None
        or not local_auth.address_allowed(email)
        or not has_usable_password(user.password_hash)
    ):
        # The CLOCK must hide the case too: scrypt takes tens of milliseconds,
        # so skipping it for an unknown or password-less account would make
        # "does this account exist" answerable with a stopwatch despite the
        # uniform 401. Burn the same work against a throwaway hash first.
        verify_password(body.password, _TIMING_EQUALIZER_HASH)
        raise _refuse()
    if not verify_password(body.password, user.password_hash):
        raise _refuse()

    local_auth.LOGIN_ADDRESS_FAILURES.clear(email)
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

    `domain` is the institution's mail domain â the same value app.seed_roster
    derives addresses from. Served rather than baked into the Angular bundle
    because the convention is the one guess this design makes about the outside
    world, and a wrong guess must be fixable with a .env edit and no rebuild.
    Public and non-sensitive: it is printed on the college's own letterhead.
    """

    google_available: bool
    password_login_available: bool
    # The email & password door's OWN readiness and reason, separate from
    # Google's: the login screen renders the form disabled with `password_reason`
    # when this is false, the same way it disables the Google button on `reason`.
    password_setup_available: bool = False
    domain: str
    reason: str | None = None
    password_reason: str | None = None


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
    never configured. Discloses no account data â only which doors exist.
    """
    if google_auth.sso_ready():
        return SsoStatus(
            google_available=True,
            password_login_available=settings.password_login_allowed,
            password_setup_available=settings.local_auth_ready,
            domain=settings.roster_domain,
            password_reason=settings.local_auth_unready_reason,
        )
    reason = "Google sign-in is not configured on this server yet."
    if settings.is_prod:
        # Nothing works. Say so loudly here, because there is no other door.
        log.error("GET /api/auth/sso/status -> 200 unavailable: ENV=prod and %s", reason)
    return SsoStatus(
        google_available=False,
        password_login_available=settings.password_login_allowed,
        password_setup_available=settings.local_auth_ready,
        domain=settings.roster_domain,
        reason=reason,
        password_reason=settings.local_auth_unready_reason,
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
        # broken". Lax is precisely the case that permits it â and it is the same
        # policy the session cookie already runs under.
        samesite="lax",
        secure=_cookie_secure(),
        path="/",
        max_age=google_auth.FLOW_TTL_SECONDS,
    )
    return resp


@router.get("/sso/google/callback")
# Alias, for the same reason as /google/start. Google itself only ever calls the
# canonical path â it is the one registered on the OAuth client.
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
    â matching on an unverified email would let anyone claim a student's row.
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
        # lowercase, so this holds today â but with password sign-in refused in
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
        # broken â a TypeError out of compare_digest, a PyJWKSetError, a dead
        # database â so the last resort is a type, not a list. log.exception
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

    # THE ADDRESS FOUND THE ROW; THE `sub` PROVES IT IS THE SAME PERSON.
    #
    # An institutional address is a lease. The college re-issues
    # 1mp25mdm01@bgscet.ac.in to the next intake, and with the match on email
    # alone the new holder signed in â legitimately, verified by Google, no
    # error anywhere â straight into the previous student's marks, uploads and
    # mentor notes. `sub` is the one identifier Google promises is stable and
    # never reused, so it is what the row is pinned to.
    #
    # A mismatch is REFUSED, not reconciled. This code cannot tell "the office
    # re-issued the address" from "someone talked the office into re-issuing it",
    # and the two need opposite outcomes, so it stops and makes a human decide:
    # clearing users.google_sub is a deliberate act with a name attached to it.
    #
    # ITS OWN CODE, `sso_identity_mismatch`, not the `sso_identity` this used to
    # borrow. Those two are the same word and opposite events: `sso_identity` is
    # "the token did not verify", whose honest copy is *try again, tell the
    # operator if it persists* â advice that is actively wrong here, because
    # retrying will refuse identically forever and only the placement office can
    # end it. A code is only worth having if the sentence behind it changes what
    # the reader does next, and this one does.
    #
    # WHAT THE STUDENT IS TOLD IS DELIBERATELY LESS THAN WHAT IS LOGGED. The
    # screen says the account does not match the one on file and to contact the
    # placement office; it does NOT say another Google account holds this
    # address, because to the honest new holder of a re-issued address that is a
    # fact about the previous student, disclosed to a stranger by a login screen.
    # The evidence lives in the log line below, where a person with a name is
    # reading it â both principals, because that pair IS the decision.
    #
    # Plain `!=`, not hmac.compare_digest, and that is not an oversight: a Google
    # `sub` is a public account identifier, not a secret. The only party who can
    # time this comparison is the one who supplied the value being compared, so
    # there is nothing to learn â and compare_digest RAISES on a non-ASCII
    # operand, which on this path would be a raw traceback page instead of the
    # redirect this module promises.
    if user.google_sub is not None and user.google_sub != identity.sub:
        log.error(
            "GET /api/auth/sso/google/callback -> 302 /login?error=sso_identity_mismatch: "
            "%s is pinned to Google sub %s but signed in with %s â REFUSED. This is "
            "a re-provisioned address or an account takeover; clear users.google_sub "
            "for that row only after confirming who should hold it.",
            identity.email,
            user.google_sub,
            identity.sub,
        )
        return _sso_failure("sso_identity_mismatch")

    # Built BEFORE the write, not after: `_record_login` commits, a commit
    # expires every loaded attribute, and reading them back on a database that
    # has just failed would raise from inside the recovery path.
    payload = _payload_for(user)
    # Pinned on the first Google sign-in, and folded into the commit
    # `_record_login` already makes rather than given one of its own: two writes
    # would mean two failure modes to reason about for one logical event. If
    # that commit fails the pin is simply not set and the next sign-in tries
    # again â self-healing, and never a reason to refuse an identity Google has
    # already verified.
    pin_pending = user.google_sub is None
    if pin_pending:
        user.google_sub = identity.sub
    try:
        _record_login(db, user)
    except SQLAlchemyError:
        # The streak row is telemetry; the session is the product. A verified
        # identity has already been established at this point, and letting a
        # failed write on a LoginDay row turn it into a 500 would refuse a
        # legitimate sign-in over a counter. The under-count is logged so it is
        # attributable, which is the thing _record_login's own docstring says
        # matters about it. The google_sub pin rides in this same commit, so it
        # is lost here too â named explicitly because an IntegrityError is a
        # REAL possibility for it (one Google account already pinned to another
        # roster row) and it would otherwise read as a streak problem.
        db.rollback()
        log.exception(
            "GET /api/auth/sso/google/callback: could not record the login for %s "
            "(session still issued; the streak will under-count and users.google_sub "
            "is unchanged â a UniqueViolation here means this Google account is "
            "already pinned to a different roster row)",
            payload["email"],
        )
        if pin_pending:
            # A valid Google token is not enough: without a durable first-use
            # sub pin, issuing a session would bypass address re-issue binding.
            return _sso_failure("sso_failed")

    destination = flow.next_path or _HOME_FOR_ROLE.get(payload["role"], _DEFAULT_HOME)

    resp = RedirectResponse(_app_url(destination), status_code=status.HTTP_302_FOUND)
    _clear_flow_cookie(resp)
    _issue_session(resp, payload)
    # The Google `sub` is logged as well as pinned. The column decides who gets
    # in; the log line is what an operator reads afterwards to answer "which
    # Google account was this?" without a query â and, on the day a pin has to
    # be cleared, it is the history of which principal held the row before.
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
def logout(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> dict:
    """Clear the cookie AND revoke the token it carried.

    Deleting the cookie only ever meant "this browser forgets". The token itself
    stayed valid for the rest of its twelve hours, so a session copied off a
    shared lab machine â the exact scenario "log out when you're done" is meant
    to cover â survived the logout completely. Bumping `users.token_version`
    kills it: app/security.py refuses any token carrying a version behind the
    row. Read that module for what "kills it" honestly means across workers.

    NOT `Depends(get_current_session)`. Signing out must work when the session
    has already expired, been revoked from another tab, or never existed â
    otherwise the sign-out button 401s at precisely the moment the browser most
    needs to be told to drop the cookie, and the student is left looking signed
    in. So the cookie is read optionally, and the endpoint is idempotent.
    """
    token = request.cookies.get(SESSION_COOKIE)
    claims = verify_session_token(token) if token else None
    if claims:
        user_id = str(claims["userId"])
        try:
            user = db.get(User, user_id)
            if user is not None:
                user.token_version = (user.token_version or 0) + 1
                db.commit()
                # Seed this worker's cache immediately, before the response is
                # written. Without it the very next request â the SPA's redirect
                # to /login, on the same worker â could still be inside the
                # previous cache window and answer as signed in.
                note_revocation(user_id, user.token_version)
        except SQLAlchemyError:
            # The cookie deletion below still happens, and that is the half the
            # person in front of the screen can see. Logged at ERROR because the
            # half they CANNOT see â the copied token â is still live, and this
            # line is the only trace that the revocation half of the logout did
            # not happen.
            db.rollback()
            log.exception(
                "POST /api/auth/logout: could not bump token_version for %s â the "
                "cookie is cleared but any COPY of that session stays valid until it "
                "expires (see users.token_version in app/security.py)",
                user_id,
            )

    # The attributes mirror the ones _issue_session set, for the reason
    # _clear_flow_cookie already spells out: browsers match a deletion on
    # name/domain/path, so this works today either way, but the asymmetry is
    # what bites the day a Domain or SameSite=None is added â and then the
    # cookie the student thinks they deleted is simply still there.
    response.delete_cookie(
        SESSION_COOKIE,
        path="/",
        httponly=True,
        samesite="lax",
        secure=_cookie_secure(),
    )
    return {"ok": True}
