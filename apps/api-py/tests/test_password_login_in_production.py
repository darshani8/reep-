"""Password sign-in outside dev/CI: the flag, the limiter, and the key issuer.

Three rules, and each one fails in a way nothing else would report.

THE FLAG IS AN OPT-IN, NOT A CONSEQUENCE OF ENV. `password_login_allowed` used
to be exactly `_is_dev_env(env)`, and the temptation when opening this door is
to relax it to `not is_prod` — which silently opens `staging`, `uat`, `demo` and
every typo, on boxes that hold real roster rows. The tests below pin that an
unrecognised ENV stays SHUT unless the flag positively says otherwise, which is
the same fail-closed shape the cookie's `Secure` guard uses.

THE LIMITER IS KEYED ON THE ACCOUNT AND NOT THE ADDRESS. An address bucket
behind an ALB is one bucket for the whole internet, so ten wrong passwords from
anyone would lock out every student at once. That is not a hypothetical: it was
written that way first and the suite went from 24 failures to 134, because every
TestClient request shares one peer address. `test_a_failure_for_one_account_does_
not_lock_out_another` is that regression, pinned.

A PASSWORD MUST BE ISSUED DELIBERATELY. Opening the door does not give anybody a
key: accounts minted by grant_access/seed_roster hold the SSO-only sentinel, and
app.set_password is the only way past it. If that ever silently accepts a short
or published password, the door and the key are both weak at once.
"""

from __future__ import annotations

import uuid

import pytest

from sqlalchemy import delete

from app import set_password as sp
from app.config import Settings, settings
from app.db import SessionLocal
from app.grant_access import SSO_ONLY_PASSWORD_HASH
from app.models.user import LoginDay, Role, User
from app.routers import auth as auth_router
from app.security import verify_password

from conftest import requires_db


@pytest.fixture
def sso_only_account():
    """Mint a key-less account the way grant_access does, and tear it down.

    A FIXTURE rather than inline setup because of teardown ORDER: a successful
    sign-in writes a `login_days` row pointing at the user, and deleting the
    user first makes SQLAlchemy null that FK rather than remove the row — which
    fails the NOT NULL constraint and reports as an IntegrityError in whatever
    test happens to run next. conftest's `make_user` clears the same table in
    the same order for the same reason.
    """
    created: list[str] = []

    def _make(role: Role = Role.ALUMNI) -> str:
        email = f"pwtest-{uuid.uuid4().hex[:8]}@bgscet.ac.in"
        with SessionLocal() as db:
            user = User(
                email=email,
                name="Password Test",
                role=role,
                # Exactly what grant_access and seed_roster write: not
                # scrypt:salt:digest, so nothing verifies against it.
                password_hash=SSO_ONLY_PASSWORD_HASH,
            )
            db.add(user)
            db.commit()
            created.append(user.id)
        return email

    yield _make

    with SessionLocal() as db:
        for uid in created:
            db.execute(delete(LoginDay).where(LoginDay.user_id == uid))
            db.execute(delete(User).where(User.id == uid))
        db.commit()


# --------------------------------------------------------------------------
# The flag
# --------------------------------------------------------------------------


def _settings(env: str, password_login: str = "") -> Settings:
    """A Settings instance built directly, so the real .env cannot leak in."""
    return Settings(env=env, password_login=password_login)


@pytest.mark.parametrize("env", ["dev", "development", "test", "testing", "ci", "local"])
def test_dev_environments_keep_password_login_with_no_flag(env: str) -> None:
    """The suite's own door. A guard that trips on a laptop gets deleted."""
    assert _settings(env).password_login_allowed is True


@pytest.mark.parametrize("env", ["prod", "production", "prd", "live"])
def test_production_refuses_password_login_by_default(env: str) -> None:
    """Blank PASSWORD_LOGIN means Google-only, which is the shipped default."""
    assert _settings(env).password_login_allowed is False


@pytest.mark.parametrize("env", ["prod", "production", "staging", "uat", "demo", ""])
def test_the_flag_opens_the_door_on_any_environment(env: str) -> None:
    """Opting in is explicit and works wherever the operator sets it."""
    assert _settings(env, "true").password_login_allowed is True


@pytest.mark.parametrize(
    "env", ["staging", "uat", "demo", "prodd", "", "  ", "Production ", "unknown"]
)
def test_an_unrecognised_environment_stays_shut_without_the_flag(env: str) -> None:
    """FAIL CLOSED. This is the half that must not become `not is_prod`.

    A `staging` box has real HTTPS, real roster rows and real students. It is not
    one of the four prod spellings, so `not is_prod` would hand it an open
    password door that nobody chose.
    """
    assert _settings(env).password_login_allowed is False


@pytest.mark.parametrize("value", ["", "  ", "false", "no", "0", "TRUE ", "yes", "1", "on"])
def test_only_the_exact_word_true_opens_it(value: str) -> None:
    """Anything but `true` is off, including near-misses.

    `TRUE ` is stripped and lowercased and so DOES open it — that spelling is a
    human writing the same word. `yes`/`1`/`on` do not: guessing at synonyms is
    how a flag ends up meaning something nobody wrote down.
    """
    expected = value.strip().lower() == "true"
    assert _settings("prod", value).password_login_allowed is expected


# --------------------------------------------------------------------------
# The endpoint
# --------------------------------------------------------------------------


@requires_db
def test_the_endpoint_403s_on_production_without_the_flag(client, monkeypatch) -> None:
    monkeypatch.setattr(settings, "env", "prod", raising=False)
    monkeypatch.setattr(settings, "password_login", "", raising=False)
    r = client.post(
        "/api/auth/login",
        json={"email": "student@bgscet.ac.in", "password": "student123"},
    )
    assert r.status_code == 403
    # Names the door that does work rather than stopping at "no".
    assert "Google" in r.json()["detail"]


@requires_db
def test_the_endpoint_works_on_production_with_the_flag(client, monkeypatch) -> None:
    """The whole point of the change: a real sign-in on ENV=prod."""
    monkeypatch.setattr(settings, "env", "prod", raising=False)
    monkeypatch.setattr(settings, "password_login", "true", raising=False)
    auth_router._login_failures.clear()
    r = client.post(
        "/api/auth/login",
        json={"email": "student@bgscet.ac.in", "password": "student123"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["email"] == "student@bgscet.ac.in"
    # The SAME cookie the Google path sets — one session, two doors.
    assert "reep_session" in r.headers.get("set-cookie", "")


@requires_db
def test_the_refusal_is_reported_by_the_capability_probe(client, monkeypatch) -> None:
    """The login screen renders its form from this field, and fails CLOSED.

    A server that refuses the password must not advertise the form, or every
    submission on it 403s and reads to a student as "my password is wrong".
    """
    monkeypatch.setattr(settings, "env", "prod", raising=False)
    monkeypatch.setattr(settings, "password_login", "", raising=False)
    assert client.get("/api/auth/sso/status").json()["password_login_available"] is False

    monkeypatch.setattr(settings, "password_login", "true", raising=False)
    assert client.get("/api/auth/sso/status").json()["password_login_available"] is True


# --------------------------------------------------------------------------
# The limiter
# --------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean_limiter():
    """The counter is module state; a leaked bucket fails the NEXT test."""
    auth_router._login_failures.clear()
    yield
    auth_router._login_failures.clear()


@requires_db
def test_repeated_wrong_passwords_stop_being_answered(client) -> None:
    """The budget is spent, then 429 with a Retry-After a client can obey."""
    body = {"email": "student@bgscet.ac.in", "password": "not-the-password"}
    for _ in range(auth_router._LOGIN_MAX_FAILURES):
        assert client.post("/api/auth/login", json=body).status_code == 401

    r = client.post("/api/auth/login", json=body)
    assert r.status_code == 429
    assert int(r.headers["Retry-After"]) > 0
    # Points at the door this counter does not gate. A student locked out here
    # — including one an attacker locked out on purpose — still has a way in.
    assert "Google" in r.json()["detail"]


@requires_db
def test_the_limit_holds_even_once_the_password_is_correct(client) -> None:
    """A guesser who finds it on attempt 11 is still refused.

    Checking the budget only on the failure path would make the limiter
    decorative: the one request that matters is the one that succeeds.
    """
    for _ in range(auth_router._LOGIN_MAX_FAILURES):
        client.post(
            "/api/auth/login",
            json={"email": "student@bgscet.ac.in", "password": "wrong"},
        )
    r = client.post(
        "/api/auth/login",
        json={"email": "student@bgscet.ac.in", "password": "student123"},
    )
    assert r.status_code == 429


@requires_db
def test_a_failure_for_one_account_does_not_lock_out_another(client) -> None:
    """THE REGRESSION. Keyed on the account, never on the source address.

    Written with an address bucket first, this failed instantly: every request
    in the suite shares the TestClient's single peer, so ten deliberate
    wrong-password assertions 429'd the other 600 tests. Behind an ALB the same
    thing happens with real users, and the blast radius is every student at once.
    """
    for _ in range(auth_router._LOGIN_MAX_FAILURES + 2):
        client.post(
            "/api/auth/login",
            json={"email": "student@bgscet.ac.in", "password": "wrong"},
        )
    # Same client, same peer address, different account: unaffected.
    r = client.post(
        "/api/auth/login",
        json={"email": "mentor@bgscet.ac.in", "password": "mentor123"},
    )
    assert r.status_code == 200, r.text


@requires_db
def test_a_correct_password_returns_the_budget(client) -> None:
    """A shared lab machine full of typos must not lock out the person who
    eventually types it right, one request later."""
    for _ in range(auth_router._LOGIN_MAX_FAILURES - 1):
        client.post(
            "/api/auth/login",
            json={"email": "student@bgscet.ac.in", "password": "wrong"},
        )
    assert (
        client.post(
            "/api/auth/login",
            json={"email": "student@bgscet.ac.in", "password": "student123"},
        ).status_code
        == 200
    )
    # Budget restored: the earlier failures no longer count against them.
    for _ in range(auth_router._LOGIN_MAX_FAILURES - 1):
        client.post(
            "/api/auth/login",
            json={"email": "student@bgscet.ac.in", "password": "wrong"},
        )
    assert (
        client.post(
            "/api/auth/login",
            json={"email": "student@bgscet.ac.in", "password": "student123"},
        ).status_code
        == 200
    )


@requires_db
def test_an_unknown_address_is_limited_too(client) -> None:
    """Otherwise the limiter answers "does this account exist?".

    An address that can be tried forever is one with no row; an address that
    starts 429ing has one. Charging both keeps the uniform 401 honest.
    """
    ghost = f"nobody-{uuid.uuid4().hex[:8]}@bgscet.ac.in"
    for _ in range(auth_router._LOGIN_MAX_FAILURES):
        assert (
            client.post("/api/auth/login", json={"email": ghost, "password": "x"}).status_code
            == 401
        )
    assert (
        client.post("/api/auth/login", json={"email": ghost, "password": "x"}).status_code == 429
    )


# --------------------------------------------------------------------------
# Issuing the key
# --------------------------------------------------------------------------


@requires_db
def test_set_password_makes_an_sso_only_account_able_to_sign_in(
    client, sso_only_account
) -> None:
    """The end-to-end shape: grant_access mints a key-less account, and only
    set_password gives it one. Opening the door is not itself a key."""
    email = sso_only_account()

    # The sentinel is not scrypt:salt:digest, so nothing verifies against it.
    assert (
        client.post("/api/auth/login", json={"email": email, "password": "anything"}).status_code
        == 401
    )

    with SessionLocal() as db:
        sp.set_password(db, email, "correct horse battery staple")

    r = client.post(
        "/api/auth/login",
        json={"email": email, "password": "correct horse battery staple"},
    )
    assert r.status_code == 200, r.text


@requires_db
def test_revoke_restores_the_sentinel_and_leaves_the_row(client, sso_only_account) -> None:
    """Taking the password away must not take Google access with it."""
    email = sso_only_account()
    with SessionLocal() as db:
        sp.set_password(db, email, "correct horse battery staple")
        user = sp.revoke_password(db, email)
        assert user.password_hash == SSO_ONLY_PASSWORD_HASH
        # The row survives, so google_callback still finds it on the roster.
        assert user.email == email
    assert (
        client.post(
            "/api/auth/login",
            json={"email": email, "password": "correct horse battery staple"},
        ).status_code
        == 401
    )


def test_a_short_password_is_refused() -> None:
    problem = sp.password_problem("short")
    assert problem is not None
    assert str(sp.MIN_PASSWORD_LENGTH) in problem


@pytest.mark.parametrize(
    "published", ["director123", "student123", "mentor123", "alumni123", "Director123"]
)
def test_the_passwords_published_in_this_repository_are_refused(published: str) -> None:
    """These are the exact strings an operator reaches for, and the exact
    strings anyone who has cloned this repo tries first."""
    assert sp.password_problem(published) is not None


def test_a_long_passphrase_is_accepted() -> None:
    assert sp.password_problem("correct horse battery staple") is None


@requires_db
def test_set_password_refuses_an_address_with_no_row() -> None:
    """Creating accounts is grant_access's decision, with a --role it refuses to
    default. Granting privilege must never be a side effect of setting a key."""
    with SessionLocal() as db:
        with pytest.raises(ValueError) as excinfo:
            sp.set_password(db, f"ghost-{uuid.uuid4().hex[:8]}@bgscet.ac.in", "a" * 20)
    assert "grant_access" in str(excinfo.value)


@requires_db
def test_a_weak_password_is_refused_before_it_is_written(sso_only_account) -> None:
    """The refusal must not leave a half-applied hash behind.

    Checked against the DATABASE rather than the return value: a validation that
    raises after committing is indistinguishable from one that raises before,
    right up until the account it half-wrote signs in.
    """
    email = sso_only_account()
    with SessionLocal() as db:
        with pytest.raises(ValueError):
            sp.set_password(db, email, "director123")
    with SessionLocal() as db:
        row = db.query(User).filter(User.email == email).one()
        assert row.password_hash == SSO_ONLY_PASSWORD_HASH
        assert not verify_password("director123", row.password_hash)
