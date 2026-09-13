"""B10.5 — leave notifications, and the fact that they ship OFF.

Four things, and the first is the one that matters most.

1. OFF BY DEFAULT. B3.7 (SES in production) has not shipped, so
   `mail_transport.send` logs the message into a bounded in-memory `outbox` that
   reaches NOBODY. A notification switched on over that transport writes a
   `mail_logs` row reading SENT for a message the applicant never received — and
   that row is the only thing anyone looks at afterwards. It is the shape of the
   failure that killed `PENDING_VERIFICATION`, and `test_it_is_off_by_default`
   is what keeps the default honest. No screen may say "the applicant has been
   emailed" while it is false.
2. THE `reason` NEVER TRAVELS. It is the form's "Purpose" cell — free text,
   routinely medical, the whole subject of rule 2's fence over this area. The
   tests below search the entire outbound message, subject and body, for the
   applicant's own sentence.
3. EXACTLY ONCE PER TRANSITION. These fire on state changes that can be retried;
   `mailer.deliver_once` is the arbiter and the key is `leave:{id}:{status}` —
   stable per transition, different per transition. Keyed on the request alone
   the sanction mail would be silent because the submission mail had gone.
4. NOT EVERY STATUS IS NOTIFIED. A CANCELLED request sends nothing: the
   applicant withdrew it themselves and does not need to be told what they just
   did.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import delete, select

from conftest import requires_db

from app import leave_mail, mail_transport
from app.config import settings
from app.db import SessionLocal
from app.leave_mail import MAIL_KIND, dedupe_key, notify_transition
from app.models.leave import LeaveRequest, LeaveStatus
from app.models.mail import MailLog
from app.models.user import Role

LEAVES = "/api/leaves"
REASON = "Post-operative review at Manipal, second cycle."


@pytest.fixture
def request_row(client, make_user):
    """One submitted request, through the real endpoint, and its MailLog rows
    removed afterwards — a `mail_logs` row outlives the account that named it."""
    applicant = make_user("mail-app", Role.MENTOR)
    r = client.post(
        LEAVES,
        headers=applicant.headers,
        json={
            "from_date": date.today().isoformat(),
            "to_date": (date.today() + timedelta(days=1)).isoformat(),
            "reason": REASON,
            "leave_kind": "CASUAL",
        },
    )
    assert r.status_code == 201, r.text
    leave_id = r.json()["id"]
    mail_transport.outbox.clear()
    yield leave_id
    with SessionLocal() as db:
        db.execute(delete(MailLog).where(MailLog.dedupe_key.like(f"leave:{leave_id}:%")))
        db.commit()


def _load(db, leave_id: str) -> LeaveRequest:
    return db.get(LeaveRequest, leave_id)


@requires_db
def test_it_is_off_by_default_and_writes_nothing(request_row):
    """The state of every deployment until an operator turns it on WITH a
    transport behind it."""
    assert settings.leave_mail_enabled is False, (
        "B3.7 has not shipped; mail turned on here lands in an in-memory outbox "
        "and the MailLog row says SENT about a message nobody received"
    )
    with SessionLocal() as db:
        assert notify_transition(db, _load(db, request_row)) is None
    assert list(mail_transport.outbox) == []
    with SessionLocal() as db:
        assert db.scalars(
            select(MailLog).where(MailLog.dedupe_key.like(f"leave:{request_row}:%"))
        ).all() == []


@requires_db
def test_when_it_is_on_it_sends_once_per_transition_and_carries_no_reason(
    request_row, monkeypatch
):
    monkeypatch.setattr(settings, "leave_mail_enabled", True)
    with SessionLocal() as db:
        lr = _load(db, request_row)
        first = notify_transition(db, lr)
        assert first is not None
        assert first.kind == MAIL_KIND
        assert first.dedupe_key == f"leave:{request_row}:SUBMITTED" == dedupe_key(lr)
        assert first.status.value == "SENT"

        # Retried — the same transition, the same key, no second copy.
        second = notify_transition(db, _load(db, request_row))
        assert second.id == first.id

    assert len(mail_transport.outbox) == 1
    sent = mail_transport.outbox[0]
    assert REASON not in sent.text and REASON not in sent.subject
    assert "casual leave" in sent.text, "the printed option says nothing about the person"
    assert date.today().isoformat() in sent.text

    # A DIFFERENT transition is a different key and does go out.
    with SessionLocal() as db:
        lr = _load(db, request_row)
        lr.status = LeaveStatus.APPROVED
        db.commit()
        third = notify_transition(db, _load(db, request_row))
        assert third.dedupe_key == f"leave:{request_row}:APPROVED"
    assert len(mail_transport.outbox) == 2
    assert "sanctioned" in mail_transport.outbox[1].subject
    assert REASON not in mail_transport.outbox[1].text


@requires_db
def test_a_withdrawal_notifies_nobody(request_row, monkeypatch):
    monkeypatch.setattr(settings, "leave_mail_enabled", True)
    with SessionLocal() as db:
        lr = _load(db, request_row)
        lr.status = LeaveStatus.CANCELLED
        db.commit()
        assert notify_transition(db, _load(db, request_row)) is None
    assert list(mail_transport.outbox) == []


def test_the_logger_is_muted_from_sentry() -> None:
    """A module whose whole job is composing text about a leave request is the
    one that grows a debug line under pressure, and `app.mail_transport` — one
    frame down — already logs the complete body at INFO."""
    from app.telemetry_scrub import MUTED_LOGGERS, scrub_breadcrumb

    assert leave_mail.log.name == "app.leave_mail"
    assert leave_mail.log.name in MUTED_LOGGERS
    assert scrub_breadcrumb({"category": "app.leave_mail", "message": REASON}) is None


def test_the_notified_statuses_are_the_three_transitions_04_names() -> None:
    """SUBMITTED, FIRST_APPROVED and a decision. Anything else sends nothing at
    all, which is what makes "not notified" a decision rather than an omission."""
    assert set(leave_mail._BODIES) == {
        LeaveStatus.SUBMITTED,
        LeaveStatus.FIRST_APPROVED,
        LeaveStatus.APPROVED,
        LeaveStatus.REJECTED,
    }
    assert LeaveStatus.CANCELLED not in leave_mail._BODIES
