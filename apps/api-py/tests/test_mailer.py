"""The send-exactly-once mailer over the MailLog dedupe store. Needs the DB;
uses a unique dedupe_key per run so it never collides with prior data.
"""

import uuid

from app.db import SessionLocal
from app.platform.mailer import deliver_once
from app.models.mail import MailStatus

from conftest import requires_db


@requires_db
def test_first_send_then_dedupe_hit():
    key = f"test:{uuid.uuid4().hex}"
    with SessionLocal() as db:
        first = deliver_once(db, kind="test", recipient="a@x.com", dedupe_key=key)
        assert first.status is MailStatus.SENT
        # Same key again → same row, no second delivery.
        again = deliver_once(db, kind="test", recipient="a@x.com", dedupe_key=key)
        assert again.id == first.id
        assert again.status is MailStatus.SENT


@requires_db
def test_suppressed_records_without_sending():
    key = f"test:{uuid.uuid4().hex}"
    with SessionLocal() as db:
        row = deliver_once(db, kind="test", recipient="opt@x.com", dedupe_key=key, suppress=True)
        assert row.status is MailStatus.SUPPRESSED


@requires_db
def test_driver_failure_recorded_not_raised():
    key = f"test:{uuid.uuid4().hex}"

    def boom(recipient, subject):
        raise RuntimeError("SMTP 550")

    with SessionLocal() as db:
        row = deliver_once(db, kind="test", recipient="b@x.com", dedupe_key=key, send=boom)
        assert row.status is MailStatus.FAILED
        assert row.error and "550" in row.error
