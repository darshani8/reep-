"""Auth endpoints â password sign-in (dev/CI) and Google sign-in (everywhere).

  POST /api/auth/login                 -> email + password. REFUSED when ENV=prod.
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
by `python -m app.seed_roster`, which is also where the USN comes from â so a
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
import time
from datetime import date, datetime, timezone

from fastapi import APIRouter, Cookie, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .. import google_auth
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

# ---------------------------------------------------------------------------
# Brute-force limiting for POST /login.
#
# Google sign-in carries its own rate limiting, its own anomaly detection and
# usually the college's 2FA. A password carries none of that, so the moment
# PASSWORD_LOGIN=true puts this endpoint on the public internet it becomes the
# one guessable way in — and a DIRECTOR password guessed here reads every
# student's marks, attendance and USN. This is the compensating control, and it
# is why that flag was not simply `not is_prod`.
#
# KEYED ON THE ACCOUNT, AND DELIBERATELY NOT ON THE SOURCE ADDRESS.
# registration.py's limiter keys on request.client.host and says in its own
# comment that behind a reverse proxy that is the PROXY. This deployment is
# behind an ALB, so request.client.host is one value for the entire internet:
# an address bucket there is not merely weak, it is a global outage waiting to
# happen — ten wrong passwords from anyone would lock out every student at once
# — and raising the limit until that stops hurting makes it stop working. It
# was tried, and the test suite caught exactly that: every login in the run
# shares the TestClient's single peer address, so the whole suite 429'd after
# ten deliberate wrong-password assertions.
#
# Counting failures per EMAIL is what actually bounds guessing at one account,
# and it holds however many source addresses the guesser has. What it does not
# bound is SPRAYING — one guess each against a thousand accounts — and no
# in-process counter can, behind a proxy that hides the caller. That control
# belongs at the edge (a WAF rate rule on the ALB or CloudFront), and saying so
# here is better than a bucket that pretends to cover it.
#
# ONLY FAILURES COUNT, and a success clears the bucket. Counting successes
# would log a busy shared-lab account out of its own door; leaving the bucket
# full after a correct password would punish the person who got in.
#
# Deliberately accepted limits, in the same spirit as registration.py's note:
#   * In-process, so each ECS task holds its own counters and the effective
#     limit is (tasks x _LOGIN_MAX_FAILURES). With autoscaling that is a real
#     weakening; it is still a hard bound per task, and a shared-state limiter
#     needs Redis or a table this endpoint does not have. Say so rather than
#     implying a guarantee that is not there.
#   * An attacker who knows an address can lock it out of PASSWORD sign-in for
#     the window by burning its budget. That is why the refusal names Google as
#     the way in that still works: Google is unaffected by this counter, so the
#     denial-of-service costs a real user a redirect, not their access.
_LOGIN_WINDOW_SECONDS = 900
_LOGIN_MAX_FAILURES = 10
_LOGIN_MAX_KEYS = 4096
_login_failures: dict[str, tuple[float, int]] = {}


def _login_retry_after(key: str) -> int | None:
    """Seconds until `key`'s window resets, or None if it may still be tried.

    Read-only: it counts nothing. `_record_login_failure` is what spends the
    budget, so a correct password on the last remaining attempt is never itself
    the thing that trips the limit.
    """
    now = time.monotonic()
    window_start, count = _login_failures.get(key, (now, 0))
    if now - window_start >= _LOGIN_WINDOW_SECONDS:
        return None
    if count >= _LOGIN_MAX_FAILURES:
        return max(1, int(_LOGIN_WINDOW_SECONDS - (now - window_start)))
    return None


def _record_login_failure(key: str) -> None:
    """Charge one failed attempt to `key`, bounding the table as it goes."""
    now = time.monotonic()
    window_start, count = _login_failures.get(key, (now, 0))
    if now - window_start >= _LOGIN_WINDOW_SECONDS:
        window_start, count = now, 0
    if key not in _login_failures and len(_login_failures) >= _LOGIN_MAX_KEYS:
        for other, (started, _n) in list(_login_failures.items()):
            if now - started >= _LOGIN_WINDOW_SECONDS:
                del _login_failures[other]
        if len(_login_failures) >= _LOGIN_MAX_KEYS:
            # Every window still live: start over rather than grow without
            # bound. The limiter must not become the memory exhaustion it
            # exists to prevent.
            _login_failures.clear()
    _login_failures[key] = (window_start, count + 1)


def _clear_login_failures(*keys: str) -> None:
    """Forget a key's failures. Called on success, never on a refusal."""
    for key in keys:
        _login_failures.pop(key, None)


# ---------------------------------------------------------------------------
# Is the password door open?
#
# DERIVED FROM THE DATABASE, NOT TOGGLED, unless an operator overrides it.
#
# The first cut of production password sign-in was a single env flag. On
# Fargate that flag lives in the task definition, which is a `terraform apply`
# away — a human at a terminal with AWS credentials, by this repo's own design
# (deploy.yml ships code and never infrastructure). Meanwhile issuing a KEY is
# one ops-task run away. So an operator who had just deliberately issued the
# first password would then be asked to make the same decision a second time,
# in a different tool, and until they did the login screen would show a form
# that 403s on every submission.
#
# Two sources of truth for one door is how a door ends up saying "open" over a
# lock nobody has a key to, or "shut" while keys are in circulation. So there is
# one: the door is open exactly when at least one account holds a real
# `scrypt:` hash. Nothing self-issues a key — grant_access and seed_roster write
# the SSO-only sentinel, app.seed refuses on ENV=prod — so "a key exists" can
# only mean "an operator ran set_password or grant_access --password-hash on
# purpose". The act of issuing the first key IS the decision to open the door.
#
# The env variable survives as the OVERRIDE, not the switch: PASSWORD_LOGIN=true
# forces open (a dev box with no keys yet), PASSWORD_LOGIN=false forces shut
# even with keys issued (incident response: shut the door, keep the hashes for
# later), and dev/CI are always open because the suite signs in through this
# endpoint. Blank means derive.
#
# WHAT THIS QUERY DISCLOSES. It answers "does ANY account have a password" and
# is independent of the request, so it cannot be used to learn which account
# does. That one bit is already public: GET /api/auth/sso/status reports it so
# the login screen can render the form only when it can work.


def password_keys_exist(db: Session) -> bool:
    """Whether at least one account holds a real password hash.

    `LIKE 'scrypt:%'` and not `!= SSO_ONLY_PASSWORD_HASH`: the sentinel is one
    value today, and any other non-scrypt string that ever lands in the column
    (a NULL-avoiding placeholder, a legacy format) must also count as "no key",
    because verify_password refuses everything that is not exactly
    scrypt:<salt>:<digest>. Only a hash that CAN verify is a key.
    """
    return (
        db.scalar(select(User.id).where(User.password_hash.like("scrypt:%")).limit(1))
        is not None
    )


def password_door_open(db: Session) -> bool:
    """The single answer both /login and /sso/status give. See the note above."""
    if settings.password_login_allowed:
        # dev/CI, or PASSWORD_LOGIN=true. Never consult the DB for these: the
        # suite's login fixture must not depend on which rows happen to exist.
        return True
    if settings.password_login_forced is False:
        return False
    return password_keys_exist(db)

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
    body: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> SessionUser:
    """Email + password. ALWAYS IN DEV/CI; ELSEWHERE ONLY IF PASSWORD_LOGIN=true.

    Google remains the door this codebase recommends, and on a default
    deployment it is still the only one: PASSWORD_LOGIN is blank unless an
    operator sets it. This endpoint is kept
    â not deleted â because tests/conftest.py's `login` fixture and the six test
    modules that use it (test_auth_rbac, test_conversations, test_feedback,
    test_knowledge, test_metrics, test_orchestrator) authenticate through it, and
    an OAuth round-trip cannot be driven from a TestClient without stubbing
    Google. An operator who wants the same door for real people opens it
    deliberately, with one .env value, having read what it costs.

    THE DOOR IS `password_door_open(db)`, one answer shared with /sso/status:
    dev/CI always; PASSWORD_LOGIN=true always; PASSWORD_LOGIN=false never; and
    otherwise open exactly when some account holds a real scrypt hash — because
    a key can only exist if an operator issued one on purpose, and that act is
    the decision (see the note above password_keys_exist). Never `not is_prod`:
    `staging`, a typo, an empty ENV from a broken deploy all stay shut until a
    key is deliberately issued. The one query the guard runs is independent of
    the request, so it cannot be probed for WHICH accounts exist — only for the
    bit the login screen's probe already publishes.

    WHAT OPENING IT TAKES ON. A password is guessable where a Google account
    behind the college's 2FA is not, and a guessed DIRECTOR password reads every
    student's marks, attendance and USN. So this endpoint carries its own
    brute-force limiter, keyed on the ACCOUNT as well as the source address
    because behind an ALB the source address is the ALB. Two things it does not
    change: accounts have no usable password until `python -m app.set_password`
    is run for one BY NAME (grant_access and seed_roster mint the unusable
    SSO_ONLY_PASSWORD_HASH sentinel), and `app.seed` still refuses on ENV=prod,
    so the demo logins published in AGENTS.md cannot be what this admits.
    """
    if not password_door_open(db):
        log.warning(
            "POST /api/auth/login -> 403: password sign-in is shut when ENV=%r and "
            "PASSWORD_LOGIN=%r (no account holds a password, or the door is forced "
            "shut); issue a key with `python -m app.set_password`, or set "
            "PASSWORD_LOGIN=true",
            settings.env,
            settings.password_login,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Password sign-in is disabled. Use Continue with Google.",
        )

    email = body.email.strip().lower()

    # Checked BEFORE the database is touched and before any scrypt work, so a
    # flood costs neither a query nor a KDF. The source address is logged for
    # the operator reading this later but is NOT a bucket — see the note above
    # _login_retry_after for why an address bucket behind an ALB is an outage
    # rather than a control.
    client_ip = request.client.host if request.client else "unknown"
    account_key = f"account:{email}"
    retry_after = _login_retry_after(account_key)
    if retry_after is not None:
        log.warning(
            "POST /api/auth/login -> 429: %d failed attempts within %ds for %s (last from %s)",
            _LOGIN_MAX_FAILURES,
            _LOGIN_WINDOW_SECONDS,
            email,
            client_ip,
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            # Names Google deliberately. This counter does not touch the Google
            # path, so someone locked out here — including a real user whose
            # address an attacker burned the budget on — still has a way in.
            detail=(
                "Too many failed sign-in attempts. Wait and try again, "
                "or use Continue with Google."
            ),
            headers={"Retry-After": str(retry_after)},
        )

    user = db.scalar(select(User).where(User.email == email))
    # One message for both cases â never reveal which of email/password was wrong.
    # `not user.password_hash` covers a roster account that has no usable local
    # password: without it, verify_password would raise AttributeError on None and
    # turn a 401 into a 500, which is both a crash and an account-existence oracle.
    if user is None or not user.password_hash:
        # The message hides which case this is; the CLOCK must too. scrypt takes
        # tens of milliseconds, so skipping it for an unknown email makes "does
        # this account exist" answerable with a stopwatch despite the uniform
        # 401. Burn the same work against a throwaway hash before refusing.
        verify_password(body.password, _TIMING_EQUALIZER_HASH)
        # Charged even though no such account exists (or it is SSO-only): not
        # charging here would make the limiter itself an account-existence
        # oracle, answerable by watching which addresses can be tried forever.
        _record_login_failure(account_key)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        )
    if not verify_password(body.password, user.password_hash):
        _record_login_failure(account_key)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        )

    # The password was right, so the budget is returned rather than spent down:
    # a shared lab machine whose users fat-finger passwords all morning must not
    # lock out the person who types theirs correctly.
    _clear_login_failures(account_key)
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
def sso_status(db: Session = Depends(get_db)) -> SsoStatus:
    """What sign-in methods this server actually offers. Unauthenticated by design.

    The login screen probes this before rendering, the same way the assistant
    probes GET /api/interview/status and GET /api/voice/status. Rendering a live
    "Continue with Google" button on a server with no GOOGLE_CLIENT_ID
    reproduces exactly the failure AGENTS.md already documents for voice: the
    button looks fine, the click fails, and nothing anywhere says the feature was
    never configured. Discloses no account data â only which doors exist.
    """
    # One answer, computed once, so both branches below say the same thing.
    available = password_door_open(db)
    if google_auth.sso_ready():
        return SsoStatus(
            google_available=True,
            password_login_available=available,
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
