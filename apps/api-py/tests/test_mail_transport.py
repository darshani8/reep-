"""The transport itself: what reaches SES, and what reaches nobody.

`tests/test_mailer.py` covers the send-exactly-once layer ABOVE this and needs
the database. This module covers `app/mail_transport.py` alone and needs
nothing: no Postgres, no AWS, no credentials. That is the point — the two
behaviours pinned here are the ones whose failure is SILENT in production, and a
test that only runs where Postgres is up is a test that is skipped on the
machine where somebody is editing this file.

1. THE CONFIGURATION SET IS NAMED ON THE CALL. SES applies either the set named
   on the send or the one attached to the identity as its default. Production
   has both, and they are not redundant: an edit to the identity kills the
   default silently -- every send still succeeds, the event destination stops
   firing, and both reputation alarms sit at INSUFFICIENT_DATA looking exactly
   like a quiet week -- where a named set that stops existing makes SES REFUSE
   the send. Loud beats quiet, so the name travels.
2. BLANK MEANS OMIT, NEVER "". SES reads an empty ConfigurationSetName as a set
   that does not exist and refuses the send, so passing "" through would turn
   "this deployment does not name one" into a total mail outage on every
   development machine and in CI.
"""

from __future__ import annotations

import pytest

from app import mail_transport
from app.config import settings


class _FakeSes:
    """Records the one send_email call instead of making it."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def send_email(self, **kwargs) -> dict:
        self.calls.append(kwargs)
        return {"MessageId": "fake"}


@pytest.fixture
def ses(monkeypatch) -> _FakeSes:
    client = _FakeSes()
    fake_boto3 = type("boto3", (), {"client": staticmethod(lambda *a, **k: client)})
    monkeypatch.setitem(__import__("sys").modules, "boto3", fake_boto3)
    monkeypatch.setattr(settings, "ses_from_address", "no-reply@example.test")
    return client


def test_a_named_configuration_set_travels_with_every_send(ses, monkeypatch):
    monkeypatch.setattr(settings, "ses_configuration_set", "reep-transactional")
    mail_transport.send("student@example.test", "Set your password", "link")
    assert ses.calls[0]["ConfigurationSetName"] == "reep-transactional"
    assert ses.calls[0]["FromEmailAddress"] == "no-reply@example.test"
    assert ses.calls[0]["Destination"] == {"ToAddresses": ["student@example.test"]}


def test_a_blank_configuration_set_is_omitted_and_not_sent_as_empty(ses, monkeypatch):
    monkeypatch.setattr(settings, "ses_configuration_set", "")
    mail_transport.send("student@example.test", "Set your password", "link")
    assert "ConfigurationSetName" not in ses.calls[0], (
        'an empty ConfigurationSetName is a set SES cannot find; it would refuse every message on every '
        "deployment that does not name one"
    )


def test_whitespace_is_not_a_configuration_set(ses, monkeypatch):
    monkeypatch.setattr(settings, "ses_configuration_set", "   ")
    mail_transport.send("student@example.test", "Set your password", "link")
    assert "ConfigurationSetName" not in ses.calls[0]


def test_with_no_sender_nothing_reaches_ses_and_the_message_is_kept(monkeypatch):
    """The console transport, which is what every development machine runs.

    It is not a stub: the message is logged in full and kept, which is how a
    developer reads an activation link out of the uvicorn log and how the rest
    of the suite reads one out of `outbox`.
    """
    monkeypatch.setattr(settings, "ses_from_address", "")
    monkeypatch.setattr(settings, "ses_configuration_set", "reep-transactional")
    mail_transport.outbox.clear()
    mail_transport.send("student@example.test", "Set your password", "https://example.test/onboard?token=abc")
    assert len(mail_transport.outbox) == 1
    entry = mail_transport.outbox[0]
    assert entry.to == "student@example.test"
    assert "https://example.test/onboard?token=abc" in entry.text
