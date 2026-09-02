"""The guards around the email & password door, as a truth table.

ENV x LOCAL_AUTH_ENABLED x email_ready decides two things: whether
POST /api/auth/login answers at all (`password_login_allowed`) and whether the
code endpoints answer (`local_auth_ready`). This file pins every cell that
matters, in the test_voice_gates idiom: pure Settings(_env_file=None, ...)
constructions where a property is the subject, and the live singleton
monkeypatched (reverted at teardown) where an HTTP status is.

The one rule underneath: the dev/CI allowlist is untouched, so the `login`
fixture and CI keep working with no configuration; outside it, NOTHING opens
the door except the explicit opt-in with a transport that can deliver a code.
"""

from __future__ import annotations

import pytest

from app.config import _DEV_ENV_NAMES, Settings, settings
from app.db import get_db
from app.main import app

NON_DEV_ENVS = ["staging", "uat", "demo", "", "prod", "Production", "dvelopment"]

_GOOD_SECRET = "x" * 48
_GOOD_DB = "postgresql+psycopg://reep_app:not-the-repo-password@db.internal:5432/reep"


def _cfg(**values) -> Settings:
    return Settings(_env_file=None, **values)


# --- the login door -----------------------------------------------------------


@pytest.mark.parametrize("env", sorted(_DEV_ENV_NAMES))
def test_password_login_stays_open_on_every_dev_env_with_no_configuration(env):
    cfg = _cfg(env=env)
    assert cfg.local_auth_enabled is False
    assert cfg.password_login_allowed is True


@pytest.mark.parametrize("env", NON_DEV_ENVS)
def test_password_login_is_refused_on_a_non_dev_env_unless_opted_in(env, client, monkeypatch):
    monkeypatch.setattr(settings, "env", env)
    monkeypatch.setattr(settings, "local_auth_enabled", False)
    r = client.post("/api/auth/login", json={"email": "a@bgscet.ac.in", "password": "x"})
    assert r.status_code == 403, r.text
    assert "Google" in r.json()["detail"]
    for path in ("/api/auth/password/otp", "/api/auth/password/set"):
        r = client.post(path, json={"email": "a@bgscet.ac.in", "code": "123456", "new_password": "p" * 12})
        assert r.status_code == 503, (path, r.text)
        assert "LOCAL_AUTH_ENABLED" in r.json()["detail"]


def test_the_403_and_503_fire_before_the_database_is_touched(client, monkeypatch):
    """FastAPI resolves `Depends(get_db)` before the handler body, so a Session
    object EXISTS for /login and /set; what must not happen is a query. The
    override yields a session that fails on any read or write."""

    class _Untouchable:
        def _touched(self, *_a, **_k):
            raise AssertionError("the database was queried before the guard")

        scalar = scalars = execute = get = add = commit = flush = _touched

    def _no_queries():
        yield _Untouchable()

    monkeypatch.setattr(settings, "env", "prod")
    monkeypatch.setattr(settings, "local_auth_enabled", False)
    app.dependency_overrides[get_db] = _no_queries
    try:
        assert client.post("/api/auth/login", json={"email": "a@b.c", "password": "x"}).status_code == 403
        assert client.post("/api/auth/password/otp", json={"email": "a@b.c"}).status_code == 503
        assert (
            client.post(
                "/api/auth/password/set",
                json={"email": "a@b.c", "code": "123456", "new_password": "p" * 12},
            ).status_code
            == 503
        )
    finally:
        app.dependency_overrides.pop(get_db, None)


@pytest.mark.parametrize("env", ["prod", "staging"])
def test_an_explicit_opt_in_with_a_ready_transport_opens_the_door(env):
    ses = _cfg(
        env=env,
        local_auth_enabled=True,
        email_transport="ses",
        email_from="REEP <no-reply@bgscet.ac.in>",
        ses_region="ap-south-1",
    )
    smtp = _cfg(
        env=env,
        local_auth_enabled=True,
        email_transport="smtp",
        email_from="no-reply@bgscet.ac.in",
        smtp_host="smtp-relay.gmail.com",
    )
    for cfg in (ses, smtp):
        assert cfg.email_ready is True
        assert cfg.local_auth_ready is True
        assert cfg.local_auth_unready_reason is None
        assert cfg.password_login_allowed is True


def test_the_flag_alone_and_a_transport_alone_do_not_open_the_door():
    flag_only = _cfg(env="prod", local_auth_enabled=True)
    assert flag_only.local_auth_ready is False and flag_only.password_login_allowed is False
    assert "EMAIL_TRANSPORT" in flag_only.local_auth_unready_reason
    transport_only = _cfg(
        env="prod", email_transport="ses", email_from="a@bgscet.ac.in", ses_region="ap-south-1"
    )
    assert transport_only.email_ready is True
    assert transport_only.local_auth_ready is False and transport_only.password_login_allowed is False
    assert "LOCAL_AUTH_ENABLED" in transport_only.local_auth_unready_reason


# --- the transport readiness rules --------------------------------------------


@pytest.mark.parametrize("env", NON_DEV_ENVS)
def test_the_log_transport_is_never_ready_outside_dev(env):
    cfg = _cfg(env=env, local_auth_enabled=True, email_transport="log")
    assert cfg.email_ready is False
    assert "log" in cfg.email_unready_reason
    assert cfg.local_auth_ready is False


def test_blank_transport_means_log_on_dev_and_nothing_elsewhere():
    assert _cfg(env="dev").email_transport_effective == "log"
    assert _cfg(env="dev").email_ready is True
    assert _cfg(env="prod").email_transport_effective == ""
    assert _cfg(env="prod").email_ready is False
    assert "EMAIL_TRANSPORT is blank" in _cfg(env="prod").email_unready_reason


@pytest.mark.parametrize(
    "values, names",
    [
        ({"email_transport": "ses"}, ["EMAIL_FROM"]),
        ({"email_transport": "ses", "email_from": "not an address"}, ["EMAIL_FROM"]),
        ({"email_transport": "ses", "email_from": "a@b.c", "ses_region": ""}, ["SES_REGION"]),
        ({"email_transport": "smtp"}, ["SMTP_HOST"]),
        ({"email_transport": "smtp", "smtp_host": "h"}, ["EMAIL_FROM"]),
        ({"email_transport": "carrier"}, ["EMAIL_TRANSPORT=carrier"]),
    ],
)
def test_email_ready_names_the_variable_that_is_missing(values, names, monkeypatch):
    monkeypatch.delenv("AWS_REGION", raising=False)
    monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)
    cfg = _cfg(env="prod", **values)
    assert cfg.email_ready is False
    for name in names:
        assert name in cfg.email_unready_reason


def test_smtp_refuses_credentials_without_tls():
    clear = _cfg(
        env="prod", email_transport="smtp", smtp_host="h", email_from="a@b.c",
        smtp_username="u", smtp_starttls=False, smtp_port=587,
    )
    assert clear.email_ready is False and "SMTP_STARTTLS" in clear.email_unready_reason
    implicit = _cfg(
        env="prod", email_transport="smtp", smtp_host="h", email_from="a@b.c",
        smtp_username="u", smtp_starttls=False, smtp_port=465,
    )
    assert implicit.email_ready is True
    anonymous = _cfg(
        env="prod", email_transport="smtp", smtp_host="h", email_from="a@b.c",
        smtp_username="", smtp_starttls=False, smtp_port=1025,
    )
    assert anonymous.email_ready is True


def test_ses_region_resolves_like_nova_region(monkeypatch):
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-west-2")
    assert _cfg(ses_region="ap-south-1").ses_region_resolved == "ap-south-1"
    assert _cfg().ses_region_resolved == "us-east-1"
    monkeypatch.delenv("AWS_REGION")
    assert _cfg().ses_region_resolved == "us-west-2"
    monkeypatch.delenv("AWS_DEFAULT_REGION")
    assert _cfg().ses_region_resolved == ""


def test_blank_lines_for_the_new_fields_are_the_defaults():
    cfg = _cfg(local_auth_enabled="", smtp_port="", smtp_starttls="")
    assert cfg.local_auth_enabled is False
    assert cfg.smtp_port == 587
    assert cfg.smtp_starttls is True


def test_email_settings_are_never_a_boot_failure():
    cfg = _cfg(
        env="prod",
        auth_secret=_GOOD_SECRET,
        database_url=_GOOD_DB,
        local_auth_enabled=True,
        email_transport="nonsense",
        email_from="",
    )
    assert cfg.production_boot_failures() == []
    assert cfg.local_auth_ready is False


def test_the_status_probe_reports_the_password_door_and_its_reason(client, monkeypatch):
    monkeypatch.setattr(settings, "local_auth_enabled", False)
    body = client.get("/api/auth/sso/status").json()
    assert body["password_setup_available"] is False
    assert "LOCAL_AUTH_ENABLED" in body["password_reason"]
    monkeypatch.setattr(settings, "local_auth_enabled", True)  # dev: blank transport = log
    body = client.get("/api/auth/sso/status").json()
    assert body["password_setup_available"] is True
    assert body["password_reason"] is None
    assert body["password_login_available"] is True
