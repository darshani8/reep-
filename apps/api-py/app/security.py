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
import secrets
from datetime import datetime, timedelta, timezone

import jwt

from .config import settings

SESSION_COOKIE = "reep_session"
SESSION_TTL_SECONDS = 60 * 60 * 12

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
    """
    try:
        claims = jwt.decode(token, settings.auth_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if not isinstance(claims, dict) or not claims.get("userId") or not claims.get("role"):
        return None
    return claims
