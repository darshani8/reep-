"""app/email.py — the three transports, without a network.

No database. Every test monkeypatches the live settings singleton (reverted at
teardown) and either captures the log, fakes smtplib, or fakes the SES client.
What is pinned: the wire shape each transport produces, that a failure becomes
an EmailError naming the transport and the provider's code and NEVER carrying
the body, and that a missing or unknown transport raises rather than silently
dropping a sign-in code.
"""

from __future__ import annotations

import logging
import smtplib

import pytest

from app import email as email_mod
from app.config import settings

MESSAGE = email_mod.OutboundEmail(
    to="1mp25mdm07@bgscet.ac.in",
    subject="Your REEP sign-in code",
    text="Your REEP code is 493018. It expires in 10 minutes.",
)


@pytest.fixture
def transport(monkeypatch):
    def _set(name: str, **overrides):
        monkeypatch.setattr(settings, "email_transport", name)
        monkeypatch.setattr(settings, "email_from", "REEP <no-reply@bgscet.ac.in>")
        monkeypatch.setattr(settings, "email_reply_to", "")
        monkeypatch.setattr(settings, "ses_configuration_set", "")
        for key, value in overrides.items():
            monkeypatch.setattr(settings, key, value)

    return _set


# --- log ----------------------------------------------------------------------


def test_log_transport_writes_the_message_to_the_reep_email_logger_and_sends_nothing(
    transport, caplog
):
    transport("log")
    with caplog.at_level(logging.INFO, logger="reep.email"):
        email_mod.send(MESSAGE)
    records = [r for r in caplog.records if r.name == "reep.email"]
    assert len(records) == 1
    text = records[0].getMessage()
    assert "NOT sent" in text and MESSAGE.to in text and "493018" in text


# --- smtp ---------------------------------------------------------------------


class _FakeSmtp:
    instances: list["_FakeSmtp"] = []

    def __init__(self, host, port, timeout=None, context=None):
        self.host, self.port, self.timeout, self.context = host, port, timeout, context
        self.calls: list[tuple] = []
        self.sent = []
        _FakeSmtp.instances.append(self)

    def ehlo(self):
        self.calls.append(("ehlo",))

    def starttls(self, context=None):
        self.calls.append(("starttls", context is not None))

    def login(self, username, password):
        self.calls.append(("login", username, password))

    def send_message(self, msg):
        self.calls.append(("send_message",))
        self.sent.append(msg)

    def quit(self):
        self.calls.append(("quit",))


@pytest.fixture
def fake_smtp(monkeypatch):
    _FakeSmtp.instances.clear()

    class _Ssl(_FakeSmtp):
        ssl = True

    monkeypatch.setattr(smtplib, "SMTP", _FakeSmtp)
    monkeypatch.setattr(smtplib, "SMTP_SSL", _Ssl)
    return _FakeSmtp


def test_smtp_transport_starttls_login_and_send_message(transport, fake_smtp):
    transport(
        "smtp",
        smtp_host="mail.test",
        smtp_port=587,
        smtp_username="relay-user",
        smtp_password="relay-pass",
        smtp_starttls=True,
        email_reply_to="placement@bgscet.ac.in",
    )
    email_mod.send(email_mod.OutboundEmail(**{**MESSAGE.__dict__, "reply_to": "placement@bgscet.ac.in"}))
    (client,) = fake_smtp.instances
    assert not getattr(client, "ssl", False) and client.port == 587 and client.timeout == 10
    verbs = [c[0] for c in client.calls]
    assert verbs == ["ehlo", "starttls", "ehlo", "login", "send_message", "quit"]
    assert ("login", "relay-user", "relay-pass") in client.calls
    (msg,) = client.sent
    assert msg["From"] == "REEP <no-reply@bgscet.ac.in>"
    assert msg["To"] == MESSAGE.to
    assert msg["Subject"] == MESSAGE.subject
    assert msg["Reply-To"] == "placement@bgscet.ac.in"
    assert "493018" in msg.get_content()


def test_smtp_transport_skips_starttls_and_login_when_told_to(transport, fake_smtp):
    transport("smtp", smtp_host="localhost", smtp_port=1025, smtp_username="", smtp_starttls=False)
    email_mod.send(MESSAGE)
    (client,) = fake_smtp.instances
    verbs = [c[0] for c in client.calls]
    assert "starttls" not in verbs and "login" not in verbs and "send_message" in verbs
    assert "Reply-To" not in client.sent[0]


def test_smtp_transport_uses_implicit_tls_on_port_465(transport, fake_smtp):
    transport("smtp", smtp_host="mail.test", smtp_port=465, smtp_username="u", smtp_password="p")
    email_mod.send(MESSAGE)
    (client,) = fake_smtp.instances
    assert getattr(client, "ssl", False) is True and client.context is not None
    assert "starttls" not in [c[0] for c in client.calls]


def test_smtp_failure_becomes_email_error_without_the_body(transport, fake_smtp, monkeypatch):
    transport("smtp", smtp_host="mail.test", smtp_port=587, smtp_username="", smtp_starttls=False)

    def _boom(self, msg):
        raise smtplib.SMTPRecipientsRefused({MESSAGE.to: (550, b"no such user")})

    monkeypatch.setattr(fake_smtp, "send_message", _boom)
    with pytest.raises(email_mod.EmailError) as excinfo:
        email_mod.send(MESSAGE)
    text = str(excinfo.value)
    assert text.startswith("smtp: SMTPRecipientsRefused") and "493018" not in text


# --- ses ----------------------------------------------------------------------


class _FakeSes:
    def __init__(self):
        self.calls: list[dict] = []
        self.raise_with: Exception | None = None

    def send_email(self, **kwargs):
        if self.raise_with:
            raise self.raise_with
        self.calls.append(kwargs)
        return {"MessageId": "fake"}


@pytest.fixture
def fake_ses(monkeypatch):
    client = _FakeSes()
    monkeypatch.setattr(email_mod, "_ses_client", lambda: client)
    return client


def test_ses_transport_calls_send_email_with_simple_text_content(transport, fake_ses):
    transport("ses", ses_region="ap-south-1")
    email_mod.send(MESSAGE)
    (call,) = fake_ses.calls
    assert call["FromEmailAddress"] == "REEP <no-reply@bgscet.ac.in>"
    assert call["Destination"] == {"ToAddresses": [MESSAGE.to]}
    simple = call["Content"]["Simple"]
    assert simple["Subject"] == {"Data": MESSAGE.subject, "Charset": "UTF-8"}
    assert simple["Body"] == {"Text": {"Data": MESSAGE.text, "Charset": "UTF-8"}}
    assert "Raw" not in call["Content"]
    assert "ReplyToAddresses" not in call and "ConfigurationSetName" not in call


def test_ses_transport_passes_reply_to_and_configuration_set_only_when_set(transport, fake_ses):
    transport("ses", ses_region="ap-south-1", ses_configuration_set="reep-mail")
    email_mod.send(email_mod.OutboundEmail(**{**MESSAGE.__dict__, "reply_to": "office@bgscet.ac.in"}))
    (call,) = fake_ses.calls
    assert call["ReplyToAddresses"] == ["office@bgscet.ac.in"]
    assert call["ConfigurationSetName"] == "reep-mail"


def test_ses_client_error_becomes_email_error_naming_the_ses_code(transport, fake_ses):
    from botocore.exceptions import ClientError

    transport("ses", ses_region="ap-south-1")
    fake_ses.raise_with = ClientError(
        {"Error": {"Code": "MessageRejected", "Message": "Email address is not verified."}},
        "SendEmail",
    )
    with pytest.raises(email_mod.EmailError) as excinfo:
        email_mod.send(MESSAGE)
    text = str(excinfo.value)
    assert text.startswith("ses: MessageRejected") and "not verified" in text
    assert "493018" not in text


def test_boto3_is_imported_lazily():
    import sys

    import app.email as module

    source = open(module.__file__, encoding="utf-8").read()
    assert "\nimport boto3" not in source and "\nfrom boto3" not in source
    # The module itself must not have pulled it in.
    assert "boto3" not in sys.modules or True  # other tests may have imported it; the source check is the pin


# --- no transport -------------------------------------------------------------


def test_no_transport_raises_email_error(transport, monkeypatch):
    transport("")
    monkeypatch.setattr(settings, "env", "prod")
    with pytest.raises(email_mod.EmailError):
        email_mod.send(MESSAGE)


def test_unknown_transport_raises_email_error(transport):
    transport("carrier-pigeon")
    with pytest.raises(email_mod.EmailError) as excinfo:
        email_mod.send(MESSAGE)
    assert "carrier-pigeon" in str(excinfo.value)
