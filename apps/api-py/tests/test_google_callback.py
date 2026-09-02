"""GET /api/auth/sso/google/callback, driven end to end against a stubbed Google.

Google is replaced at the two seams that touch the network — `exchange_code`
(the POST to oauth2.googleapis.com) and `_fetch_jwks` — and NOWHERE ELSE. Every
signature, `aud`, `iss`, `exp`, nonce and `email_verified` check runs for real
against a locally minted RSA key, so these tests exercise the verification path
rather than a mock of it.

What they pin, in order of what would hurt most if it broke:

  1. THE SESSION IS THE SAME SESSION. Constraint 2 of the brief: Google
     authenticates, it does not get a session mechanism of its own. The cookie
     name, attributes and claim KEYS must be indistinguishable from the ones
     POST /api/auth/login sets, because app/identity.py, require_mentor,
     _assert_can_access_student and the interview WebSocket all read them and
     none of them was changed.
  2. THE ROSTER IS THE ACCESS CONTROL. A perfectly valid, Google-verified
     identity with no `users` row gets no session.
  3. FAILURES REDIRECT, THEY DO NOT 500. The callback is a top-level browser
     navigation, so a raw FastAPI error page is a broken-looking app outside the
     SPA. This is the rule that was quietly false for a non-ASCII `state`.
"""

from __future__ import annotations

import json
import time
import uuid

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import delete

from app import google_auth
from app.config import settings
from app.db import SessionLocal
from app.models.user import LoginDay, Role, Student, User
from app.security import SESSION_COOKIE, verify_session_token

from conftest import requires_db  # noqa: E402 — the house import, see test_voice.py

_CLIENT_ID = "reep-test-client.apps.googleusercontent.com"
_KID = "reep-test-kid"


@pytest.fixture(scope="module")
def google_key():
    """A local RSA keypair standing in for Google's signing key."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    jwk.update(kid=_KID, alg="RS256", use="sig")
    return pem, {"keys": [jwk]}


@pytest.fixture
def google(monkeypatch, google_key):
    """Configure SSO and stub the two network seams. Returns a token minter."""
    pem, jwks = google_key
    monkeypatch.setattr(settings, "google_client_id", _CLIENT_ID)
    monkeypatch.setattr(settings, "google_client_secret", "GOCSPX-test-secret")
    monkeypatch.setattr(google_auth, "_fetch_jwks", lambda: jwt.PyJWKSet.from_dict(jwks))
    monkeypatch.setattr(google_auth, "_jwks", None)
    monkeypatch.setattr(google_auth, "_jwks_fetched_at", 0.0)
    monkeypatch.setattr(google_auth, "_jwks_retry_after", 0.0)

    def mint(**over) -> str:
        now = int(time.time())
        claims = {
            "iss": "https://accounts.google.com",
            "aud": _CLIENT_ID,
            "sub": "108127654321098765432",
            "email": "someone@bgscet.ac.in",
            "email_verified": True,
            "name": "Someone Real",
            "iat": now,
            "exp": now + 600,
        }
        claims.update(over)
        return jwt.encode(claims, pem, algorithm="RS256", headers={"kid": _KID})

    return mint


@pytest.fixture
def roster_user():
    """A throwaway roster row, torn down afterwards."""
    created: list[str] = []

    def _make(email: str, role: Role = Role.STUDENT):
        with SessionLocal() as db:
            user = User(
                email=email,
                name="Roster Person",
                role=role,
                # The unusable-password sentinel app.seed_roster writes.
                password_hash="google-only",
            )
            db.add(user)
            db.flush()
            if role is Role.STUDENT:
                db.add(Student(user_id=user.id, usn=f"1MP25TEST{uuid.uuid4().hex[:2].upper()}"))
            db.commit()
            created.append(user.id)
            return user.id

    yield _make

    with SessionLocal() as db:
        for uid in created:
            db.execute(delete(LoginDay).where(LoginDay.user_id == uid))
            db.execute(delete(Student).where(Student.user_id == uid))
            db.execute(delete(User).where(User.id == uid))
        db.commit()


def _start(client) -> tuple[str, str, str]:
    """Begin a flow. Returns (state, nonce, flow-cookie value)."""
    client.cookies.clear()
    r = client.get("/api/auth/sso/google", follow_redirects=False)
    assert r.status_code == 302, r.text
    cookie = r.cookies[google_auth.FLOW_COOKIE]
    claims = jwt.decode(cookie, google_auth._flow_secret(), algorithms=["HS256"])
    return claims["state"], claims["nonce"], cookie


def _callback(client, cookie: str, **params):
    client.cookies.clear()
    client.cookies.set(google_auth.FLOW_COOKIE, cookie)
    r = client.get("/api/auth/sso/google/callback", params=params, follow_redirects=False)
    client.cookies.clear()
    return r


# --------------------------------------------------------------------- 1. session


@requires_db
def test_google_issues_the_same_session_as_the_password_door(client, google, roster_user):
    email = f"ssotest-{uuid.uuid4().hex[:8]}@bgscet.ac.in"
    roster_user(email)
    state, nonce, cookie = _start(client)
    monkey_token = google(email=email, nonce=nonce)
    google_auth.exchange_code = lambda code: monkey_token  # noqa: E731 — seam, restored below
    try:
        r = _callback(client, cookie, code="good-code", state=state)
    finally:
        del google_auth.exchange_code

    assert r.status_code == 302, r.text
    assert r.headers["location"].endswith("/student")

    raw = r.cookies.get(SESSION_COOKIE)
    assert raw, f"no {SESSION_COOKIE} cookie was set: {r.headers}"
    claims = verify_session_token(raw)
    assert claims is not None, "the cookie Google's door sets does not verify as a session"
    # The claim KEYS are the contract every downstream consumer reads.
    assert set(claims) == {"userId", "email", "name", "role", "studentId", "iat", "exp"}
    assert claims["email"] == email
    assert claims["role"] == "STUDENT"
    assert claims["studentId"], "no studentId — every /api/student/* route would 403"

    # And the session actually works on a route that reads it.
    me = client.get("/api/auth/me", headers={"Cookie": f"{SESSION_COOKIE}={raw}"})
    assert me.status_code == 200, me.text
    assert me.json()["email"] == email


@requires_db
def test_a_roster_row_with_a_capital_letter_can_still_sign_in(client, google, roster_user):
    """Google lowercases; `users.email` is case-preserving. See the callback."""
    email = f"SSOTest-{uuid.uuid4().hex[:8]}@BGSCET.ac.in"
    roster_user(email)
    state, nonce, cookie = _start(client)
    tok = google(email=email.lower(), nonce=nonce)
    google_auth.exchange_code = lambda code: tok  # noqa: E731
    try:
        r = _callback(client, cookie, code="good-code", state=state)
    finally:
        del google_auth.exchange_code

    assert r.status_code == 302
    assert "error=" not in r.headers["location"], r.headers["location"]
    assert r.cookies.get(SESSION_COOKIE)


# ----------------------------------------------------------------- 2. the roster


@requires_db
def test_a_verified_google_account_not_on_the_roster_gets_no_session(client, google):
    state, nonce, cookie = _start(client)
    tok = google(email=f"stranger-{uuid.uuid4().hex[:8]}@gmail.com", nonce=nonce)
    google_auth.exchange_code = lambda code: tok  # noqa: E731
    try:
        r = _callback(client, cookie, code="good-code", state=state)
    finally:
        del google_auth.exchange_code

    assert r.status_code == 302
    assert r.headers["location"].endswith("/login?error=sso_not_enrolled")
    assert not r.cookies.get(SESSION_COOKIE), "a stranger was given a session"


# -------------------------------------------------- 3. failures redirect, not 500


@pytest.mark.parametrize(
    ("label", "params", "expected"),
    [
        ("no state at all", {"code": "c"}, "sso_state"),
        ("state that does not match", {"code": "c", "state": "not-the-one"}, "sso_state"),
        # The case that used to be a bare 500: compare_digest RAISES TypeError,
        # it does not return False, when either side carries a non-ASCII char.
        #
        # The expected code is asserted exactly, and that matters here. The
        # callback's catch-all would turn the TypeError into a redirect anyway,
        # so "it redirected" passes with or without the isascii() guard in
        # read_flow_state — only `sso_state` rather than the generic `sso_failed`
        # proves the guard is present and the student gets the honest message.
        ("non-ASCII state", {"code": "c", "state": "évil"}, "sso_state"),
        ("state validated but no code", {"state": None}, "sso_token"),
    ],
)
def test_every_bad_callback_redirects_rather_than_erroring(client, google, label, params, expected):
    state, _nonce, cookie = _start(client)
    if params.get("state", "sentinel") is None:
        params["state"] = state
    r = _callback(client, cookie, **params)
    assert r.status_code == 302, f"{label} produced {r.status_code}, not a redirect"
    assert r.headers["location"].endswith(f"/login?error={expected}"), (
        f"{label}: expected {expected}, got {r.headers['location']}"
    )
    assert not r.cookies.get(SESSION_COOKIE), label


def test_a_replayed_callback_is_refused_because_the_flow_cookie_is_single_use(client, google):
    state, nonce, cookie = _start(client)
    tok = google(nonce=nonce)
    google_auth.exchange_code = lambda code: tok  # noqa: E731
    try:
        first = _callback(client, cookie, code="c", state=state)
        # Same URL, no cookie: exactly what replaying the callback link does,
        # because the first response deleted it.
        client.cookies.clear()
        replay = client.get(
            "/api/auth/sso/google/callback",
            params={"code": "c", "state": state},
            follow_redirects=False,
        )
    finally:
        del google_auth.exchange_code

    assert first.status_code == 302
    assert replay.status_code == 302
    assert replay.headers["location"].endswith("/login?error=sso_state")
    assert not replay.cookies.get(SESSION_COOKIE)


def test_the_flow_cookie_is_not_signed_with_auth_secret(client, google):
    """It is a different statement, so it gets a different key.

    Without this separation the flow cookie is structurally a valid session
    token: pasted into `reep_session` it reached GET /api/auth/me, which does
    SessionUser(**session) and raised — an unauthenticated 500 from a cookie the
    browser's own owner holds.
    """
    _state, _nonce, cookie = _start(client)
    with pytest.raises(jwt.PyJWTError):
        jwt.decode(cookie, settings.auth_secret, algorithms=["HS256"])
    assert verify_session_token(cookie) is None

    r = client.get("/api/auth/me", headers={"Cookie": f"{SESSION_COOKIE}={cookie}"})
    assert r.status_code == 401, f"a flow cookie produced {r.status_code}, not a clean 401"


# ------------------------------------------------------------- the capability probe


def test_sso_status_reports_the_doors_and_the_domain(client):
    r = client.get("/api/auth/sso/status")
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {
        "google_available",
        "password_login_available",
        "password_setup_available",
        "domain",
        "reason",
        "password_reason",
    }
    # The suite runs on the dev default: the door is off until LOCAL_AUTH_ENABLED
    # is set, and the reason names it.
    assert body["password_setup_available"] is False
    assert "LOCAL_AUTH_ENABLED" in body["password_reason"]
    assert body["domain"] == settings.roster_domain
    assert isinstance(body["google_available"], bool)
