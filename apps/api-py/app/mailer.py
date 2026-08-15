"""Send-exactly-once mailer over the MailLog dedupe store.

The catalogue of messages and the actual SMTP/API driver are out of scope here
(no mail transport is configured in this environment). What this module ports is
the guarantee the Next.js mailer gives: a message with a given `dedupe_key` is
delivered at most once, no matter how many times the sending job is re-run or how
many workers race. The unique index on `dedupe_key` is the arbiter — a losing
racer catches an IntegrityError and reports the existing row rather than sending
a second copy.

Keep this module free of request/`get_db` concerns so a background worker can call
it with its own Session, exactly as the Next.js mailer is callable off a cron.
"""

from collections.abc import Callable

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models.mail import MailLog, MailStatus

# A driver takes (recipient, subject) and raises on failure. None = no-op stub
# that records the intent without a transport (dev/default).
Driver = Callable[[str, str | None], None]


def deliver_once(
    db: Session,
    *,
    kind: str,
    recipient: str,
    dedupe_key: str,
    subject: str | None = None,
    suppress: bool = False,
    send: Driver | None = None,
) -> MailLog:
    """Deliver `kind` to `recipient` at most once for `dedupe_key`.

    - If the key was already used, returns the existing row and sends nothing —
      the entire point of the table.
    - `suppress=True` records a SUPPRESSED row (recipient opted out) without
      sending.
    - Otherwise reserves the key, attempts the send, and records SENT or FAILED.
    """
    existing = db.scalar(select(MailLog).where(MailLog.dedupe_key == dedupe_key))
    if existing is not None:
        return existing  # dedupe hit — no second delivery

    row = MailLog(
        kind=kind,
        recipient=recipient,
        dedupe_key=dedupe_key,
        subject=subject,
        status=MailStatus.SUPPRESSED if suppress else MailStatus.SENT,
    )
    db.add(row)
    try:
        db.flush()  # hit the unique index now, before doing any real work
    except IntegrityError:
        db.rollback()
        # A concurrent worker reserved the key between our read and flush; defer
        # to their row and send nothing.
        return db.scalar(select(MailLog).where(MailLog.dedupe_key == dedupe_key))

    if not suppress:
        try:
            if send is not None:
                send(recipient, subject)
            row.status = MailStatus.SENT
        except Exception as exc:  # driver failure — recorded, never raised to the caller
            row.status = MailStatus.FAILED
            row.error = str(exc)[:1000]

    db.commit()
    db.refresh(row)
    return row
