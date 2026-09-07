"""How an email actually leaves the building. Amazon SES, or the console.

THE DRIVER `app/mailer.py` LEFT A HOLE FOR. That module guarantees a message is
sent at most once per dedupe key and takes a `send(recipient, subject)`
callable; it says plainly that the transport is out of its scope. This is the
transport. The whole choice of provider lives in `send()` — swapping SES for
the college's SMTP relay later is this file, not a project.

WHY SES. The deciding factor is not price (at a college's volume every option
is effectively free); it is that SES needs NO CREDENTIAL. It authenticates
through the same task role that already reaches Bedrock for the interviewer,
so there is nothing to paste, leak or rotate — where every other provider adds
an API key someone has to store, and puts student email addresses in a third
party's systems. `SES_FROM_ADDRESS` is the only setting; the region falls back
to the AWS environment like everything else here.

THE SES SANDBOX. A new SES account can only send to addresses it has verified.
Leaving the sandbox means verifying the bgscet.ac.in domain (DKIM/SPF — an IT
task) and requesting production access, which takes a day or two. Start that
early. Nothing here is blocked on it: the on-screen activation link and the
console transport below both work without SES.

THE CONSOLE TRANSPORT IS NOT A STUB. With `SES_FROM_ADDRESS` blank — every
development machine, CI, and a fresh deployment before IT has answered — a
message is logged in full and kept in `outbox`, a bounded in-memory list. A
developer reads the activation link out of the uvicorn log; the test suite
reads it out of `outbox`. It is bounded and only ever filled when no real
transport exists, so it never becomes a copy of student mail sitting in a
production process.

RULE 1 (student data must not leave the machine unbidden) is not engaged: an
activation or reset email carries a name and a link, never a mark, a USN or a
transcript. Keep it that way — do not put a student's record in an email.
"""

from __future__ import annotations

import logging
from collections import deque
from dataclasses import dataclass

from .config import settings

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class OutboxEntry:
    to: str
    subject: str
    text: str


#: What the console transport delivered, newest last. Bounded: this is a
#: development and test affordance, not a mail archive. Empty whenever a real
#: transport is configured.
outbox: deque[OutboxEntry] = deque(maxlen=200)


def configured() -> bool:
    """Is there a real transport? Read per call so a test can flip it."""
    return bool(settings.ses_from_address.strip())


def _region() -> str:
    import os

    return (
        settings.ses_region.strip()
        or os.environ.get("AWS_REGION", "").strip()
        or os.environ.get("AWS_DEFAULT_REGION", "").strip()
        or "ap-south-1"
    )


def send(to: str, subject: str, text: str) -> None:
    """Deliver one plain-text message, or record it if there is no transport.

    Raises on an SES failure so `mailer.deliver_once` records FAILED — that
    row is how an operator learns a student never got their link.
    """
    if not configured():
        outbox.append(OutboxEntry(to=to, subject=subject, text=text))
        log.info("MAIL (no transport configured) to=%s subject=%r\n%s", to, subject, text)
        return

    # Imported here, not at module scope: boto3 is on every install (the resume
    # builder needs it) but nothing else in this module does, and the console
    # path above must stay importable on a machine with no AWS credentials.
    import boto3

    client = boto3.client("sesv2", region_name=_region())
    client.send_email(
        FromEmailAddress=settings.ses_from_address.strip(),
        Destination={"ToAddresses": [to]},
        Content={
            "Simple": {
                "Subject": {"Data": subject, "Charset": "UTF-8"},
                "Body": {"Text": {"Data": text, "Charset": "UTF-8"}},
            }
        },
    )
