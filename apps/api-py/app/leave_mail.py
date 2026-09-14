"""Leave notifications (B10.5) — and they SHIP OFF.

One function, `notify_transition(db, lr)`, which mails the APPLICANT that their
request has moved. Three transitions are worth a message and they are the three
04 names: it was submitted, somebody gave the first signature, somebody decided
it.

==============================================================================
OFF BY DEFAULT, AND THE DEFAULT IS THE DESIGN
==============================================================================

`settings.leave_mail_enabled` is false, and until B3.7 (SES in production) ships
it must stay false on every deployment. With `SES_FROM_ADDRESS` blank —
which is every machine this has ever run on — `mail_transport.send` logs the
message and appends it to a bounded in-memory `outbox` that reaches NOBODY. A
notification switched on over that transport writes a `mail_logs` row reading
SENT for a message the applicant never received, and that row is the only thing
anybody looks at afterwards. It is the exact shape of the failure that killed
`PENDING_VERIFICATION`: a step nobody could pass, reported as a step that
worked.

So while the flag is false NO SCREEN MAY SAY "the applicant has been emailed" —
04 §B3.7 names that trap for the Add-faculty wizard and it is the same trap
here. `notify_transition` returns None when it is off, so a caller that wants to
tell the user something has an honest value to branch on.

==============================================================================
`deliver_once`, NEVER `mail_transport.send` DIRECTLY
==============================================================================

These messages fire on STATE TRANSITIONS, and a state transition can be retried:
a request that 500s after the commit, a console that double-taps Sanction, a
background retry somebody adds later. `app/mailer.py::deliver_once` is the
send-exactly-once wrapper over `mail_logs`, whose unique index on `dedupe_key`
is the arbiter — a losing racer catches the IntegrityError and reports the
existing row rather than sending a second copy.

The key is `leave:{id}:{status}`, which is stable per transition and different
per transition. Keying on the request alone would make the sanction mail silent
because the submission mail had already gone; keying on a timestamp would send
one copy per retry, which is the thing being prevented.

==============================================================================
THE `reason` NEVER TRAVELS. NOT ONCE, NOT SUMMARISED.
==============================================================================

`leave_requests.reason` is the form's "Purpose" cell: free text, routinely
medical ("post-operative review", "chemotherapy — day 2"), and the whole subject
of rule 2's fence over this area. An email leaves the building through a third
party's infrastructure and lands in a mailbox this product does not control, so
a `reason` in a mail body is a medical disclosure REEP made on the applicant's
behalf without asking. The dates, the printed option and the state are enough to
say what happened; `_BODIES` below carries no other field and a reviewer should
refuse any patch that adds one.

For the same reason this module's LOGGER is muted from Sentry
(`app/telemetry_scrub.py::MUTED_LOGGERS`) alongside `app.mail_transport`. It
does not log a body today — but `mail_transport` does, one frame down, and a
module whose whole job is composing text about a leave request is exactly the
one that grows a debug line under pressure. The cost is honest: a failure here
is visible in the `mail_logs` row and the CloudWatch line, not as a Sentry
breadcrumb.

RULE 1 is not in play (nothing here reaches a model), and rule 2 is satisfied by
construction: the only recipient this module can address is the applicant's own
account.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from sqlalchemy.orm import Session

from .config import settings
from .mail_transport import send as transport_send
from .mailer import deliver_once
from .models.leave import LeaveRequest, LeaveStatus
from .models.mail import MailLog
from .models.user import User

log = logging.getLogger(__name__)

#: `kind` on the MailLog row, so the office can count leave mail apart from
#: activation and reset mail in one query.
MAIL_KIND = "leave-status"


def _span(lr: LeaveRequest) -> str:
    if lr.from_date == lr.to_date:
        return lr.from_date.isoformat()
    return f"{lr.from_date.isoformat()} to {lr.to_date.isoformat()}"


def _kind_phrase(lr: LeaveRequest) -> str:
    """"Casual leave", or just "leave" when no printed option was named. The
    option is one of five words on the college's own form and says nothing about
    the person; the `reason` says everything and never appears."""
    if not lr.leave_kind:
        return "leave"
    return {
        "CASUAL": "casual leave",
        "PERMISSION": "permission",
        "OOD": "on-official-duty leave",
        "RH": "restricted holiday",
        "LOP": "loss-of-pay leave",
    }.get(lr.leave_kind, "leave")


def _submitted(user: User, lr: LeaveRequest) -> tuple[str, str]:
    return (
        "Your leave request has been received",
        f"Hello {user.name},\n\n"
        f"REEP has recorded your application for {_kind_phrase(lr)} covering "
        f"{_span(lr)}. It is now waiting for the first signature.\n\n"
        f"You can follow it, or withdraw it while it is still unsigned, on your "
        f"Leave Requests screen.\n",
    )


def _first_approved(user: User, lr: LeaveRequest) -> tuple[str, str]:
    return (
        "Your leave request has its first signature",
        f"Hello {user.name},\n\n"
        f"Your application for {_kind_phrase(lr)} covering {_span(lr)} has been "
        f"signed once. It still needs a second signature before it is "
        f"sanctioned.\n",
    )


def _approved(user: User, lr: LeaveRequest) -> tuple[str, str]:
    return (
        "Your leave request has been sanctioned",
        f"Hello {user.name},\n\n"
        f"Your application for {_kind_phrase(lr)} covering {_span(lr)} has been "
        f"sanctioned. The signed form is on your Leave Requests screen.\n",
    )


def _rejected(user: User, lr: LeaveRequest) -> tuple[str, str]:
    # THE APPROVER'S NOTE IS NOT IN HERE EITHER. `first_note`/`second_note` are
    # free text written by a member of staff ABOUT this person, and a note
    # written for the office's file is not a note written to the applicant.
    # The screen shows it to them in context; the mail sends them to the screen.
    return (
        "A decision has been made on your leave request",
        f"Hello {user.name},\n\n"
        f"Your application for {_kind_phrase(lr)} covering {_span(lr)} was not "
        f"approved. Your Leave Requests screen carries the decision and any note "
        f"the approver left.\n",
    )


#: Which transitions are worth a message. A status that is not here sends
#: nothing at all — CANCELLED especially: the applicant withdrew it themselves
#: and does not need to be told what they just did.
_BODIES: dict[LeaveStatus, Callable[[User, LeaveRequest], tuple[str, str]]] = {
    LeaveStatus.SUBMITTED: _submitted,
    LeaveStatus.FIRST_APPROVED: _first_approved,
    LeaveStatus.APPROVED: _approved,
    LeaveStatus.REJECTED: _rejected,
}


def dedupe_key(lr: LeaveRequest) -> str:
    """`leave:{id}:{status}` — stable per transition, different per transition.
    Exported so a test can assert the key without composing a message."""
    return f"leave:{lr.id}:{lr.status.value}"


def notify_transition(db: Session, lr: LeaveRequest) -> MailLog | None:
    """Tell the applicant their request has moved. Returns the `mail_logs` row,
    or None when nothing was sent.

    None means one of three things and the caller must not read it as failure:
    the feature is off (the default), this status is not one that is notified,
    or the applicant's account is gone. It NEVER raises — `deliver_once` records
    a FAILED row rather than propagating a transport error, because a mail that
    did not go out must never be the reason a sanctioned leave fails to save.

    IT DOES NOT COMMIT THE LEAVE ROW. `deliver_once` commits its own MailLog, so
    call this AFTER the transition's own commit: called before, it would commit
    a half-written request, and a mail about a decision that has not landed yet
    is worse than a late one.
    """
    if not settings.leave_mail_enabled:
        return None
    builder = _BODIES.get(lr.status)
    if builder is None:
        return None
    user = db.get(User, lr.requester_user_id)
    if user is None or not (user.email or "").strip():
        # The account was removed (or has no address) between the transition and
        # this call. Nothing to do, and nothing is wrong with the leave request.
        log.info("Leave notification skipped: no recipient for request %s", lr.id)
        return None
    subject, text = builder(user, lr)
    return deliver_once(
        db,
        kind=MAIL_KIND,
        recipient=user.email,
        dedupe_key=dedupe_key(lr),
        subject=subject,
        # The transport composes nothing; it is handed the finished body, the
        # way account_links.py's `_driver` does it.
        send=lambda to, subj: transport_send(to, subj or "", text),
    )
