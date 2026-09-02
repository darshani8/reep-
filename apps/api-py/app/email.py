"""Outbound email — the ONLY module that knows how a message leaves the process.

Three transports, one `send()`, chosen by EMAIL_TRANSPORT:

  log    dev/CI. The message is written to the `reep.email` logger and NEVER
         sent. That prints a sign-in code into the process log by design, which
         is exactly why config.py's `email_ready` refuses this transport on
         every non-development ENV — a code in CloudWatch is a code.
  smtp   any relay, stdlib smtplib. Port 465 is implicit TLS (SMTP_SSL);
         anything else is STARTTLS when SMTP_STARTTLS is true. Credentials are
         only ever sent when a username is set, and `email_ready` refuses a
         username without TLS so they cannot go over the wire in the clear.
  ses    AWS SESv2, signed by the task role through the standard credential
         chain — no key, no secret, exactly like Nova on Bedrock. boto3 is
         imported lazily so a deployment on another transport does not pay for
         it at boot; it is declared in requirements.txt regardless.

The caller's type is `OutboundEmail`; the stdlib's `EmailMessage` is imported
under a private alias because this module is `app.email` and a reader may
wonder whether `from email.message import ...` finds the stdlib. It does —
absolute imports resolve from sys.path, on which `app/` itself is never placed,
and tools/ci/check_api_imports.py imports this module as `app.email` to prove
it.

Plain text only. A sign-in code email with markup and links is what phishing
looks like, and the one thing the message has to say fits in four sentences.

Failures raise `EmailError`, whose `str()` is safe to store in mail_logs.error
and to log: it carries the transport and the provider's code and message, never
the body and never a credential.
"""

from __future__ import annotations

import logging
import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage as _MimeMessage
from functools import lru_cache

from .config import settings

log = logging.getLogger("reep.email")

_TIMEOUT_SECONDS = 10


@dataclass(frozen=True)
class OutboundEmail:
    to: str
    subject: str
    text: str
    reply_to: str | None = None


class EmailError(RuntimeError):
    """A transport could not deliver. The text names the transport and the
    provider's complaint — never the message body, never a credential."""


def transport_name() -> str:
    return settings.email_transport_effective


def send(message: OutboundEmail) -> None:
    name = settings.email_transport_effective
    if name == "log":
        _send_log(message)
    elif name == "smtp":
        _send_smtp(message)
    elif name == "ses":
        _send_ses(message)
    else:
        raise EmailError(f"no email transport is configured (EMAIL_TRANSPORT={name!r})")


# --- log ----------------------------------------------------------------------


def _send_log(message: OutboundEmail) -> None:
    log.info(
        "EMAIL (log transport, NOT sent) to=%s subject=%r\n%s",
        message.to,
        message.subject,
        message.text,
    )


# --- smtp ---------------------------------------------------------------------


def _mime(message: OutboundEmail) -> _MimeMessage:
    msg = _MimeMessage()
    msg["From"] = settings.email_from.strip()
    msg["To"] = message.to
    msg["Subject"] = message.subject
    if message.reply_to:
        msg["Reply-To"] = message.reply_to
    msg.set_content(message.text)
    return msg


def _send_smtp(message: OutboundEmail) -> None:
    host = settings.smtp_host.strip()
    port = int(settings.smtp_port)
    username = settings.smtp_username.strip()
    try:
        if port == 465:
            client: smtplib.SMTP = smtplib.SMTP_SSL(
                host, port, timeout=_TIMEOUT_SECONDS, context=ssl.create_default_context()
            )
        else:
            client = smtplib.SMTP(host, port, timeout=_TIMEOUT_SECONDS)
        try:
            client.ehlo()
            if port != 465 and settings.smtp_starttls:
                client.starttls(context=ssl.create_default_context())
                client.ehlo()
            if username:
                client.login(username, settings.smtp_password)
            client.send_message(_mime(message))
        finally:
            try:
                client.quit()
            except Exception:  # noqa: BLE001 — the send already happened or already failed
                pass
    except (smtplib.SMTPException, OSError, ssl.SSLError) as exc:
        raise EmailError(f"smtp: {type(exc).__name__}: {exc}") from exc


# --- ses ----------------------------------------------------------------------


@lru_cache(maxsize=1)
def _ses_client():
    """One client per process. Lazy import, the app/ai/llm.py pattern: only a
    deployment that actually sends through SES pays for boto3 at first use.
    Tests call `_ses_client.cache_clear()` after monkeypatching."""
    import boto3  # noqa: PLC0415

    region = settings.ses_region_resolved or None
    return boto3.client("sesv2", region_name=region)


def _send_ses(message: OutboundEmail) -> None:
    from botocore.exceptions import BotoCoreError, ClientError  # noqa: PLC0415

    kwargs: dict = {
        "FromEmailAddress": settings.email_from.strip(),
        "Destination": {"ToAddresses": [message.to]},
        "Content": {
            "Simple": {
                "Subject": {"Data": message.subject, "Charset": "UTF-8"},
                "Body": {"Text": {"Data": message.text, "Charset": "UTF-8"}},
            }
        },
    }
    if message.reply_to:
        kwargs["ReplyToAddresses"] = [message.reply_to]
    configuration_set = settings.ses_configuration_set.strip()
    if configuration_set:
        kwargs["ConfigurationSetName"] = configuration_set
    try:
        _ses_client().send_email(**kwargs)
    except ClientError as exc:
        err = exc.response.get("Error", {}) if hasattr(exc, "response") else {}
        # MessageRejected = sandbox / unverified recipient or identity;
        # AccessDeniedException = the IAM grant does not match the identity or
        # the From address; Throttling / quota = sandbox limits;
        # AccountSendingPausedException = a reputation pause. The runbook in
        # docs/email-password-sign-in.md maps each.
        raise EmailError(
            f"ses: {err.get('Code', 'ClientError')}: {err.get('Message', str(exc))}"
        ) from exc
    except BotoCoreError as exc:
        raise EmailError(f"ses: {type(exc).__name__}: {exc}") from exc
