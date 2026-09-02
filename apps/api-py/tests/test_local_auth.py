"""The email & password door end to end, against a live Postgres.

The `door` fixture switches the feature on for one test (LOCAL_AUTH_ENABLED
true; the suite's ENV is dev, so the blank transport resolves to `log`) and
replaces app.email.send with a recorder, so every test reads the code from the
captured OutboundEmail and never from a log. `roster_user` creates a User the
way app.seed_roster does — the unusable-password sentinel — plus a Student row,
and tears down LoginDay/Student/User; auth_email_otps rows go with the user
(ON DELETE CASCADE), mail_logs rows are deleted by recipient.

Starlette's TestClient runs BackgroundTasks before `client.post` returns, so
the request endpoint's work is complete by the next line of each test.
"""

from __future__ import annotations

import logging
import re
import threading
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import delete, select, text

from app import email as email_mod
from app import local_auth, retention
from app.config import settings
from app.db import SessionLocal
from app.models.auth_otp import EmailOtp
from app.models.mail import MailLog, MailStatus
from app.models.user import LoginDay, Role, Student, User
from app.ratelimit import FixedWindow
from app.security import UNUSABLE_PASSWORD_HASH, hash_password
from conftest import requires_db

pytestmark = requires_db

GOOD_PASSWORD = "correct-horse-battery"
OTP = "/api/auth/password/otp"
SET = "/api/auth/password/set"
LOGIN = "/api/auth/login"
ME = "/api/auth/me"


@pytest.fixture
def door(monkeypatch):
    """The feature on, the transport recorded."""
    sent: list[email_mod.OutboundEmail] = []
    monkeypatch.setattr(settings, "local_auth_enabled", True)
    monkeypatch.setattr(settings, "email_transport", "")
    monkeypatch.setattr(email_mod, "send", lambda message: sent.append(message))
    monkeypatch.setattr(local_auth, "OTP_RESEND_SECONDS", 0)  # most tests need >1 code
    return sent


@pytest.fixture
def roster_user():
    created: list[tuple[str, str]] = []

    def _make(email: str | None = None, *, role: Role = Role.STUDENT, password: str | None = None):
        email = email or f"1mp25test{uuid.uuid4().hex[:6]}@bgscet.ac.in"
        with SessionLocal() as db:
            user = User(
                email=email,
                name="Roster Person",
                role=role,
                password_hash=hash_password(password) if password else UNUSABLE_PASSWORD_HASH,
            )
            db.add(user)
            db.flush()
            if role is Role.STUDENT:
                db.add(Student(user_id=user.id, usn=f"1MP25T{uuid.uuid4().hex[:4].upper()}"))
            db.commit()
            created.append((user.id, email))
            return user.id, email

    yield _make

    with SessionLocal() as db:
        for uid, email in created:
            db.execute(delete(MailLog).where(MailLog.recipient == email.lower()))
            db.execute(delete(LoginDay).where(LoginDay.user_id == uid))
            db.execute(delete(Student).where(Student.user_id == uid))
            db.execute(delete(User).where(User.id == uid))
        db.commit()


def _code_from(sent: list[email_mod.OutboundEmail]) -> str:
    match = re.search(r"\b(\d{6})\b", sent[-1].text)
    assert match, sent[-1].text
    return match.group(1)


def _otp_rows(user_id: str) -> list[EmailOtp]:
    with SessionLocal() as db:
        return db.scalars(
            select(EmailOtp).where(EmailOtp.user_id == user_id).order_by(EmailOtp.created_at)
        ).all()


def _user(user_id: str) -> User:
    with SessionLocal() as db:
        return db.get(User, user_id)


def _request(client, email: str, cookies: dict | None = None):
    r = client.post(OTP, json={"email": email}, headers=cookies or {})
    client.cookies.clear()
    return r


def _set(client, email: str, code: str, password: str = GOOD_PASSWORD, cookies: dict | None = None):
    r = client.post(
        SET, json={"email": email, "code": code, "new_password": password}, headers=cookies or {}
    )
    cookie = {"Cookie": r.headers.get("set-cookie", "")}
    client.cookies.clear()
    return r, cookie


def _login(client, email: str, password: str):
    r = client.post(LOGIN, json={"email": email, "password": password})
    cookie = {"Cookie": r.headers.get("set-cookie", "")}
    client.cookies.clear()
    return r, cookie


# --- requesting a code --------------------------------------------------------


@pytest.mark.parametrize(
    "address",
    ["nobody-here@bgscet.ac.in", "someone@gmail.com", "not-an-address", "a@b"],
)
def test_request_answers_202_with_the_constant_body_and_sends_nothing_for_others(
    client, door, address
):
    r = _request(client, address)
    assert r.status_code == 202, r.text
    assert r.json() == {"ok": True, "resend_after_seconds": 60}
    assert door == []


def test_request_for_an_off_domain_roster_account_sends_nothing(client, door, roster_user):
    uid, email = roster_user("granted-staff@gmail.com", role=Role.MENTOR)
    r = _request(client, email)
    assert r.status_code == 202 and r.json() == {"ok": True, "resend_after_seconds": 60}
    assert door == [] and _otp_rows(uid) == []


def test_request_for_an_enrolled_college_address_sends_exactly_one_six_digit_code(
    client, door, roster_user, caplog
):
    uid, email = roster_user()
    with caplog.at_level(logging.DEBUG):
        r = _request(client, email.upper())  # mixed case MUST still find the row
    assert r.status_code == 202 and r.json() == {"ok": True, "resend_after_seconds": 60}
    assert len(door) == 1
    assert door[0].to == email.lower()
    assert door[0].subject == "Your REEP sign-in code"
    code = _code_from(door)
    assert len(_otp_rows(uid)) == 1 and _otp_rows(uid)[0].code_hash != code
    for record in caplog.records:
        message = record.getMessage()
        assert code not in message and email.lower() not in message


def test_the_code_endpoint_never_reveals_a_send_failure(client, door, roster_user, monkeypatch, caplog):
    uid, email = roster_user()

    def _boom(message):
        raise email_mod.EmailError("ses: MessageRejected: Email address is not verified.")

    monkeypatch.setattr(email_mod, "send", _boom)
    with caplog.at_level(logging.ERROR):
        r = _request(client, email)
    assert r.status_code == 202 and r.json() == {"ok": True, "resend_after_seconds": 60}
    with SessionLocal() as db:
        row = db.scalar(select(MailLog).where(MailLog.recipient == email, MailLog.kind == "auth-otp"))
    assert row is not None and row.status is MailStatus.FAILED and "MessageRejected" in row.error
    errors = [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR]
    assert any(local_auth.SEND_FAILED_LOG in m for m in errors)
    assert all(email not in m for m in errors)


def test_resend_is_silently_throttled_inside_the_cooldown(client, door, roster_user, monkeypatch):
    monkeypatch.setattr(local_auth, "OTP_RESEND_SECONDS", 60)
    uid, email = roster_user()
    assert _request(client, email).status_code == 202
    assert _request(client, email).status_code == 202
    assert len(door) == 1 and len(_otp_rows(uid)) == 1


def test_a_new_request_supersedes_the_previous_code(client, door, roster_user):
    uid, email = roster_user()
    _request(client, email)
    first = _code_from(door)
    _request(client, email)
    second = _code_from(door)
    assert first != second or True  # equal digits are possible; the row state is the pin
    rows = _otp_rows(uid)
    assert len(rows) == 2 and rows[0].expires_at <= rows[1].created_at
    r, _ = _set(client, email, first)
    assert r.status_code == 400
    r, _ = _set(client, email, second)
    assert r.status_code == 200, r.text


def test_the_fourth_request_in_an_hour_answers_202_and_sends_nothing(
    client, door, roster_user, caplog
):
    uid, email = roster_user()
    for _ in range(3):
        assert _request(client, email).status_code == 202
    with caplog.at_level(logging.WARNING):
        assert _request(client, email).status_code == 202
    assert len(door) == 3 and len(_otp_rows(uid)) == 3
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert any("hourly cap" in m and uid in m for m in warnings)
    assert all(email not in m for m in warnings)


# --- setting the password -----------------------------------------------------


def test_set_with_the_right_code_signs_in_and_replaces_the_sentinel(client, door, roster_user):
    uid, email = roster_user()
    _request(client, email)
    before = _user(uid)
    r, cookie = _set(client, email, _code_from(door))
    assert r.status_code == 200, r.text
    assert r.json()["email"] == email and r.json()["studentId"]
    assert "reep_session=" in cookie["Cookie"]
    assert client.get(ME, headers=cookie).status_code == 200
    client.cookies.clear()
    after = _user(uid)
    assert after.password_hash.startswith("scrypt:") and after.google_sub == before.google_sub
    assert after.token_version == before.token_version + 1
    (row,) = _otp_rows(uid)
    assert row.consumed_at is not None
    with SessionLocal() as db:
        assert db.scalar(select(LoginDay).where(LoginDay.user_id == uid)) is not None


def test_the_new_password_works_on_the_login_door_and_a_code_is_single_use(
    client, door, roster_user
):
    uid, email = roster_user()
    _request(client, email)
    code = _code_from(door)
    assert _set(client, email, code)[0].status_code == 200
    r, cookie = _login(client, email, GOOD_PASSWORD)
    assert r.status_code == 200 and client.get(ME, headers=cookie).status_code == 200
    client.cookies.clear()
    assert _login(client, email, "wrong-password-here")[0].status_code == 401
    assert _set(client, email, code, "another-fine-password")[0].status_code == 400


def test_set_revokes_every_other_session_and_the_new_cookie_survives(
    client, door, roster_user, monkeypatch
):
    monkeypatch.setattr(settings, "auth_revocation_cache_seconds", 0)
    uid, email = roster_user()
    _request(client, email)
    assert _set(client, email, _code_from(door))[0].status_code == 200
    _, cookie_a = _login(client, email, GOOD_PASSWORD)
    assert client.get(ME, headers=cookie_a).status_code == 200
    client.cookies.clear()
    _request(client, email)
    r, cookie_b = _set(client, email, _code_from(door), "a-brand-new-password")
    assert r.status_code == 200
    assert client.get(ME, headers=cookie_a).status_code == 401
    client.cookies.clear()
    assert client.get(ME, headers=cookie_b).status_code == 200
    client.cookies.clear()
    assert _login(client, email, GOOD_PASSWORD)[0].status_code == 401
    assert _login(client, email, "a-brand-new-password")[0].status_code == 200


def test_a_wrong_code_counts_an_attempt_and_five_wrong_burn_it(client, door, roster_user):
    uid, email = roster_user()
    _request(client, email)
    code = _code_from(door)
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(5):
        r, _ = _set(client, email, wrong)
        assert r.status_code == 400 and "newest code" in r.json()["detail"]
    (row,) = _otp_rows(uid)
    assert row.attempts == 5
    assert _set(client, email, code)[0].status_code == 400  # burned, even though right


def test_an_expired_code_is_refused(client, door, roster_user):
    uid, email = roster_user()
    _request(client, email)
    code = _code_from(door)
    with SessionLocal() as db:
        db.execute(text("update auth_email_otps set expires_at = now() - interval '1 second' where user_id = :u"), {"u": uid})
        db.commit()
    assert _set(client, email, code)[0].status_code == 400


def test_a_weak_password_or_the_email_as_password_is_refused_before_spending_an_attempt(
    client, door, roster_user
):
    uid, email = roster_user()
    _request(client, email)
    code = _code_from(door)
    for bad, fragment in ((" short ", "at least"), (email, "email address"), ("x" * 201, "at most")):
        r, _ = _set(client, email, code, bad)
        assert r.status_code == 422 and fragment in r.json()["detail"]
    assert _otp_rows(uid)[0].attempts == 0
    assert _set(client, email, code)[0].status_code == 200


def test_set_for_an_unknown_or_off_domain_address_is_the_same_400(client, door):
    for address in ("nobody@bgscet.ac.in", "someone@gmail.com"):
        r, _ = _set(client, address, "123456")
        assert r.status_code == 400 and "newest code" in r.json()["detail"]


def test_a_malformed_code_is_422_and_never_reaches_the_table(client, door, roster_user):
    uid, email = roster_user()
    for code in ("12345", "abcdef", "1234567", ""):
        r, _ = _set(client, email, code)
        assert r.status_code == 422, (code, r.text)


# --- the change-password flow (a session bound to the address) ----------------


def test_change_password_with_a_matching_session_keeps_the_caller_signed_in(
    client, door, roster_user, monkeypatch
):
    monkeypatch.setattr(settings, "auth_revocation_cache_seconds", 0)
    uid, email = roster_user(password=GOOD_PASSWORD)
    _, cookie_a = _login(client, email, GOOD_PASSWORD)
    _, cookie_other_device = _login(client, email, GOOD_PASSWORD)
    r = _request(client, email, cookies=cookie_a)
    assert r.status_code == 202
    r, cookie_c = _set(client, email, _code_from(door), "changed-password-now", cookies=cookie_a)
    assert r.status_code == 200, r.text
    assert client.get(ME, headers=cookie_c).status_code == 200
    client.cookies.clear()
    assert client.get(ME, headers=cookie_a).status_code == 401
    client.cookies.clear()
    assert client.get(ME, headers=cookie_other_device).status_code == 401
    client.cookies.clear()


def test_a_session_for_user_a_cannot_request_or_set_for_user_b(client, door, roster_user):
    _, email_a = roster_user(password=GOOD_PASSWORD)
    uid_b, email_b = roster_user()
    _, cookie_a = _login(client, email_a, GOOD_PASSWORD)
    r = _request(client, email_b, cookies=cookie_a)
    assert r.status_code == 403 and "different address" in r.json()["detail"]
    assert door == [] and _otp_rows(uid_b) == []
    r, _ = _set(client, email_b, "123456", cookies=cookie_a)
    assert r.status_code == 403


# --- the login door -----------------------------------------------------------


def test_login_refuses_an_off_domain_account_with_the_uniform_401(client, door, roster_user):
    _, email = roster_user("granted-staff@gmail.com", role=Role.MENTOR, password=GOOD_PASSWORD)
    r, _ = _login(client, email, GOOD_PASSWORD)
    assert r.status_code == 401 and r.json()["detail"] == "Invalid email or password."


def test_login_refuses_the_sentinel_with_the_uniform_401_and_burns_the_equaliser(
    client, door, roster_user, monkeypatch
):
    from app.routers import auth as auth_router

    calls: list[str] = []
    real = auth_router.verify_password

    def _recording(password, stored):
        calls.append(stored)
        return real(password, stored)

    monkeypatch.setattr(auth_router, "verify_password", _recording)
    _, email = roster_user()  # sentinel
    assert _login(client, email, GOOD_PASSWORD)[0].status_code == 401
    assert _login(client, "nobody@bgscet.ac.in", GOOD_PASSWORD)[0].status_code == 401
    assert calls == [auth_router._TIMING_EQUALIZER_HASH, auth_router._TIMING_EQUALIZER_HASH]


def test_login_lookup_is_case_insensitive(client, door, roster_user):
    _, email = roster_user(password=GOOD_PASSWORD)
    r, cookie = _login(client, email.upper(), GOOD_PASSWORD)
    assert r.status_code == 200 and r.json()["email"] == email


def test_login_failures_are_rate_limited_per_address_and_successes_clear_it(
    client, door, roster_user, monkeypatch
):
    monkeypatch.setattr(local_auth, "LOGIN_ADDRESS_FAILURES", FixedWindow(900, 2))
    monkeypatch.setattr(local_auth, "LOGIN_IP_FAILURES", FixedWindow(600, 1000))
    _, email = roster_user(password=GOOD_PASSWORD)
    _, other = roster_user(password=GOOD_PASSWORD)
    assert _login(client, email, "nope-nope-nope")[0].status_code == 401
    assert _login(client, email, "nope-nope-nope")[0].status_code == 401
    r, _ = _login(client, email, GOOD_PASSWORD)
    assert r.status_code == 429 and r.headers.get("Retry-After") and "emailed code" in r.json()["detail"]
    assert _login(client, other, GOOD_PASSWORD)[0].status_code == 200  # a different address still answers
    local_auth.LOGIN_ADDRESS_FAILURES.clear(email)
    assert _login(client, email, GOOD_PASSWORD)[0].status_code == 200
    assert _login(client, email, "nope-nope-nope")[0].status_code == 401  # success cleared the count


def test_login_failures_are_rate_limited_per_ip(client, door, roster_user, monkeypatch):
    monkeypatch.setattr(local_auth, "LOGIN_IP_FAILURES", FixedWindow(600, 2))
    monkeypatch.setattr(local_auth, "LOGIN_ADDRESS_FAILURES", FixedWindow(900, 1000))
    _, email = roster_user(password=GOOD_PASSWORD)
    for _ in range(2):
        assert _login(client, "ghost@bgscet.ac.in", "x" * 12)[0].status_code == 401
    assert _login(client, email, GOOD_PASSWORD)[0].status_code == 429


def test_otp_request_and_set_are_rate_limited_per_ip(client, door, roster_user, monkeypatch):
    monkeypatch.setattr(local_auth, "OTP_REQUESTS_PER_IP", FixedWindow(600, 2))
    monkeypatch.setattr(local_auth, "OTP_SET_PER_IP", FixedWindow(900, 2))
    _, email = roster_user()
    assert _request(client, email).status_code == 202
    assert _request(client, email).status_code == 202
    r = _request(client, email)
    assert r.status_code == 429 and r.headers.get("Retry-After")
    assert _set(client, email, "123456")[0].status_code == 400
    assert _set(client, email, "123456")[0].status_code == 400
    assert _set(client, email, "123456")[0].status_code == 429


# --- the primitives -----------------------------------------------------------


def test_otp_hash_is_keyed_on_auth_secret_and_bound_to_the_row(monkeypatch):
    a = local_auth.otp_hash("user-1", "password", "123456")
    assert a == local_auth.otp_hash("user-1", "password", "123456")
    assert a != local_auth.otp_hash("user-2", "password", "123456")
    assert a != local_auth.otp_hash("user-1", "login", "123456")
    monkeypatch.setattr(settings, "auth_secret", "a-rotated-secret-of-sufficient-length!!")
    assert a != local_auth.otp_hash("user-1", "password", "123456")


def test_stale_rows_and_old_mail_logs_are_purged_by_retention(client, door, roster_user):
    uid, email = roster_user()
    _request(client, email)
    with SessionLocal() as db:
        db.execute(text("update auth_email_otps set created_at = now() - interval '25 hours' where user_id = :u"), {"u": uid})
        db.execute(text("update mail_logs set sent_at = now() - interval '181 days' where recipient = :e"), {"e": email})
        db.commit()
        summary = retention.purge_expired(db)
    assert summary["otp_rows_deleted"] >= 1 and summary["otp_mail_logs_deleted"] >= 1
    assert _otp_rows(uid) == []


def test_password_endpoints_also_answer_under_api_v1(client, door):
    assert client.post("/api/v1/auth/password/otp", json={"email": "x@bgscet.ac.in"}).status_code == 202
    r = client.post("/api/v1/auth/password/set", json={"email": "x@bgscet.ac.in", "code": "123456", "new_password": GOOD_PASSWORD})
    assert r.status_code == 400


# --- the review's findings, pinned ---------------------------------------------


def test_concurrent_wrong_guesses_each_count(client, door, roster_user):
    """Eight threads guess wrong behind a barrier; the cap must hold at 5, not collapse to 1."""
    uid, email = roster_user()
    _request(client, email)
    with SessionLocal() as db:
        user = db.get(User, uid)
        db.expunge(user)
    barrier = threading.Barrier(8)

    def _guess():
        with SessionLocal() as db:
            barrier.wait()
            local_auth.verify_code(db, user, local_auth.PURPOSE_PASSWORD, "000000")

    threads = [threading.Thread(target=_guess) for _ in range(8)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    # Under the row lock the guesses serialise: five count, the rest meet a dead
    # code and count nothing. Before the lock the finder measured 1 of 10.
    (row,) = _otp_rows(uid)
    assert row.attempts == local_auth.OTP_MAX_ATTEMPTS
    assert _set(client, email, _code_from(door))[0].status_code == 400  # burned


def test_concurrent_requests_issue_one_code_inside_the_cooldown(client, door, roster_user, monkeypatch):
    monkeypatch.setattr(local_auth, "OTP_RESEND_SECONDS", 60)
    uid, email = roster_user()
    with SessionLocal() as db:
        user = db.get(User, uid)
        db.expunge(user)
    barrier = threading.Barrier(6)
    issued: list[bool] = []

    def _issue():
        with SessionLocal() as db:
            barrier.wait()
            issued.append(local_auth.issue_code(db, user, local_auth.PURPOSE_PASSWORD) is not None)

    threads = [threading.Thread(target=_issue) for _ in range(6)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert sum(issued) == 1 and len(_otp_rows(uid)) == 1


def test_the_send_failure_line_never_carries_the_address_even_when_the_provider_does(
    client, door, roster_user, monkeypatch, caplog
):
    uid, email = roster_user()

    def _boom(message):
        raise email_mod.EmailError(
            "ses: MessageRejected: Email address is not verified. The following identities "
            f"failed the check in region AP-SOUTH-1: {message.to}"
        )

    monkeypatch.setattr(email_mod, "send", _boom)
    with caplog.at_level(logging.ERROR):
        assert _request(client, email).status_code == 202
    errors = [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR]
    assert any(local_auth.SEND_FAILED_LOG in m and "<address>" in m for m in errors)
    assert all(email not in m for m in errors)
    with SessionLocal() as db:
        row = db.scalar(select(MailLog).where(MailLog.recipient == email))
    assert email in row.error  # verbatim beside the recipient column, on purpose


def test_set_still_signs_in_when_the_streak_row_cannot_be_written(client, door, roster_user, monkeypatch):
    from sqlalchemy.exc import OperationalError

    from app.routers import local_auth as router_module

    uid, email = roster_user()
    _request(client, email)

    def _down(db, user):
        raise OperationalError("insert into login_days", {}, Exception("connection lost"))

    monkeypatch.setattr(router_module, "_record_login", _down)
    r, cookie = _set(client, email, _code_from(door))
    assert r.status_code == 200, r.text
    assert client.get(ME, headers=cookie).status_code == 200
    client.cookies.clear()
    assert _user(uid).password_hash.startswith("scrypt:")


def test_redact_addresses():
    assert local_auth.redact_addresses("failed: a.b@c.d, <x@y.z>; done") == "failed: <address>, <<address>>; done"
    assert local_auth.redact_addresses(None) == ""
