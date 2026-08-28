"""Password hashing and session tokens — byte-compatible with the Next.js app.

Password:  "scrypt:<salt_hex>:<digest_hex>", scrypt(N=16384, r=8, p=1, dklen=64)
           with the salt passed as its hex STRING (exactly what node:crypto's
           scryptSync does), so hashes migrate across without a reset.
Session:   HS256 JWT signed with AUTH_SECRET, claims = the session payload, plus
           iat/exp (12h). Same secret + alg as jose, so tokens verify on both
           sides during cutover. Cookie name: reep_session.
"""

import hashlib
import hmac
import logging
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

import jwt
from sqlalchemy import select

from .config import settings

log = logging.getLogger(__name__)

SESSION_COOKIE = "reep_session"
SESSION_TTL_SECONDS = 60 * 60 * 12

# --- Revocation ------------------------------------------------------------
#
# A session cookie is a STATELESS BEARER TOKEN: valid until `exp`, twelve hours
# away, whatever happens in between. "Log out" therefore used to mean only "this
# browser forgets the cookie" — a token copied off a shared lab machine stayed
# good for the rest of the day, and neither the student nor the placement office
# could do anything about it. That is the whole of finding M8.
#
# `users.token_version` closes it: the version at minting time rides in the
# token as `tokenVersion`, logout bumps the row, and a token whose version is
# BEHIND the row is refused. Doing that literally costs a SELECT on every
# authenticated request — including on the interview WebSocket's async path,
# where a blocking query sits on the event loop — so the version is cached per
# process for `settings.auth_revocation_cache_seconds`.
#
# THE HONEST CONSEQUENCE, which must not be dressed up as more than it is:
# revocation is IMMEDIATE in the worker that served the logout (it seeds its own
# cache) and takes UP TO auth_revocation_cache_seconds to reach the other
# workers. This is a best-effort logout, not a session store. If instant global
# revocation is ever genuinely needed, the answer is a shared store (Redis, or a
# per-request read), NOT a smaller TTL — a TTL of 0 simply puts the SELECT back
# on every request, which is the thing this cache exists to avoid.
SESSION_VERSION_CLAIM = "tokenVersion"

# user_id -> (monotonic deadline, version). Bounded by the number of real users
# who have signed in on this worker: only a token that already passed the HS256
# signature check ever reaches the lookup, so an attacker cannot seed entries.
_version_cache: dict[str, tuple[float, int]] = {}
# FastAPI runs `def` endpoints in a threadpool and the WS path enters from the
# event loop, so two requests really can be in here at once. The lock is held
# only around the dict, never across the query — a database that has gone slow
# must not serialise every authenticated request behind one connection attempt.
_version_lock = threading.Lock()

# Monotonic deadline armed when the lookup FAILS. A failure caches nothing (a
# transient error must not stick), so without this the read is retried on every
# single authenticated request while the database is down: a connect attempt per
# request, each parked for the driver's timeout, plus a stack trace per request
# in the log. That is the same trap _JWKS_FAILURE_BACKOFF_SECONDS was written
# for in app/google_auth.py, arriving from the other side. During the backoff
# the check simply admits — which is what it would have done anyway.
_db_retry_after: float = 0.0
# Fixed, not derived from auth_revocation_cache_seconds, because that setting is
# allowed to be 0 ("ask the database every request") and a zero backoff is no
# backoff at all. Short enough that revocation resumes within seconds of the
# database coming back.
_DB_FAILURE_BACKOFF_SECONDS = 10.0

# Node scryptSync defaults: N=16384, r=8, p=1, keylen here=64. maxmem must exceed
# 128 * N * r (= 16 MiB); give it headroom.
_SCRYPT = dict(n=16384, r=8, p=1, dklen=64, maxmem=64 * 1024 * 1024)


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=salt.encode(), **_SCRYPT).hex()
    return f"scrypt:{salt}:{digest}"


def verify_password(password: str, stored: str) -> bool:
    parts = stored.split(":")
    if len(parts) != 3:
        return False
    scheme, salt, digest = parts
    if scheme != "scrypt" or not salt or not digest:
        return False
    derived = hashlib.scrypt(password.encode(), salt=salt.encode(), **_SCRYPT).hex()
    return hmac.compare_digest(derived, digest)


def create_session_token(payload: dict) -> str:
    now = datetime.now(timezone.utc)
    claims = {**payload, "iat": now, "exp": now + timedelta(seconds=SESSION_TTL_SECONDS)}
    return jwt.encode(claims, settings.auth_secret, algorithm="HS256")


def _cache_ttl() -> float:
    """Read per call, not at import, so a test can move it. Never negative."""
    return max(float(settings.auth_revocation_cache_seconds), 0.0)


def current_token_version(user_id: str) -> int | None:
    """The user's `token_version`, from this worker's cache or the database.

    None means the database returned no user row and resolves to version 0. A
    database exception returns the internal negative sentinel instead; callers
    treat that as an authorization failure. This is intentionally fail-closed:
    revocation state is security state, so the application must not admit a
    bearer token when it cannot confirm the current token version.
    """
    global _db_retry_after

    now = time.monotonic()
    with _version_lock:
        entry = _version_cache.get(user_id)
        if entry is not None and now < entry[0]:
            return entry[1]
        if now < _db_retry_after:
            # Still inside the backoff from a failed read. Revocation is
            # authorization state, so refuse until the database can answer.
            return -1

    try:
        # Imported HERE, not at module scope. app/seed.py, app/seed_roster.py
        # and the CLI tools import this module for `hash_password` alone, and
        # `app.models.user` drags the whole 31-module models package — and the
        # engine underneath it — in behind it. Nothing else in this file needs a
        # database, and the password half must stay importable without one.
        from .db import SessionLocal
        from .models.user import User

        with SessionLocal() as db:
            version = db.scalar(select(User.token_version).where(User.id == user_id))
    except Exception:
        # OperationalError, InterfaceError, DNS failure and a half-applied
        # migration all fail closed. Privileged authorization must not continue
        # when the source of truth cannot confirm the identity state.
        with _version_lock:
            _db_retry_after = time.monotonic() + _DB_FAILURE_BACKOFF_SECONDS
        log.exception(
            "could not read token_version for user %s; refusing the session and "
            "not re-asking for %.0fs until the database answers",
            user_id,
            _DB_FAILURE_BACKOFF_SECONDS,
        )
        # -1 is an internal failure sentinel, distinct from a missing user row
        # (which resolves to version 0). verify_session_token refuses it.
        return -1

    # A row that has vanished — a user deleted while still holding a session —
    # reads as version 0 rather than as a refusal. This function answers exactly
    # one question, "has this user revoked since the token was minted?", and a
    # missing row cannot answer yes. Deciding that a deleted user's session must
    # die is a different decision belonging to the deps that do authorisation,
    # not to a signature check.
    resolved = int(version or 0)
    with _version_lock:
        _version_cache[user_id] = (now + _cache_ttl(), resolved)
    return resolved


def note_revocation(user_id: str, version: int) -> None:
    """Record a just-committed bump so THIS worker refuses the old token now.

    Without it a logout would not bite even in the process that served it until
    the TTL lapsed — and that is the one case a student is watching: sign out,
    press Back, still signed in. Other workers converge within the TTL.
    """
    with _version_lock:
        _version_cache[user_id] = (time.monotonic() + _cache_ttl(), int(version))


def _claimed_version(claims: dict) -> int:
    """The `tokenVersion` the token carries. A MISSING CLAIM IS VERSION 0.

    That is not laxity, it is the deploy story: every session minted before this
    column existed lacks the claim, and reading "absent" as "invalid" would sign
    the entire college out at the moment the new build goes live, for no
    security gain whatsoever — those tokens predate any revocation to enforce.
    A claim that is present but not an integer is a different thing: only this
    server mints these, so a non-integer means a forged or hand-edited token,
    and -1 puts it behind every possible row value.
    """
    raw = claims.get(SESSION_VERSION_CLAIM, 0)
    try:
        return int(raw)
    except (TypeError, ValueError):
        return -1


def verify_session_token(token: str) -> dict | None:
    """The claims of a valid session cookie, or None. Signature AND shape.

    A SESSION IS A TOKEN THAT CARRIES AN IDENTITY, and nothing else is. The
    shape check is not belt-and-braces: AUTH_SECRET signs a second kind of token
    since Google sign-in landed — the ten-minute OAuth state/nonce cookie in
    app/google_auth.py, which has no server-side store to live in — and that one
    deliberately carries no userId and no role. It authorises nothing (every
    require_* guard reads `role` through .get() and refuses), but it IS
    structurally a valid HS256 JWT under this secret, and the consumers past the
    guards index session["userId"] / session["role"] directly: pasted into
    `reep_session` by the browser's own owner, it turned an unauthenticated
    request into a 500 instead of a clean 401. google_auth.read_flow_state
    already refuses the mirror case; this closes the other direction. Every
    payload _payload_for() mints has both keys, so no real session changes.

    REVOCATION LIVES HERE, not in app/identity.py, because this is the ONE function
    that turns a cookie into an identity — the HTTP dependency, the WebSocket
    dependency and every test read the session through it. A revocation check
    bolted onto one caller is a revocation check the next caller forgets.
    """
    try:
        claims = jwt.decode(token, settings.auth_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if not isinstance(claims, dict) or not claims.get("userId") or not claims.get("role"):
        return None
    # STRICTLY BEHIND is revoked; equal or ahead is admitted. `<` rather than
    # `!=` on purpose: "ahead" cannot happen in normal operation, only after a
    # database restore rolls the counter back, and in that case admitting the
    # sessions people are actually holding beats logging the whole college out
    # of a system that has just been through an incident.
    current = current_token_version(str(claims["userId"]))
    if current is not None and current < 0:
        return None
    if current is not None and _claimed_version(claims) < current:
        return None
    return claims
