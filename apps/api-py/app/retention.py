"""Assistant retention & aged-data redaction (Assistant V2 Phase D, review #9).

Memory does not live forever. Two jobs keep the assistant's stored data on a
lifecycle instead of letting it accumulate indefinitely:

* ``purge_expired`` walks conversations: one whose ``retention_until`` has passed
  is SOFT-deleted (``deleted_at`` stamped) — recoverable-shaped but hidden — and
  the free text it still carries through the grace window is PII-scrubbed with
  ``app.redaction.redact_pii``. A conversation that has been soft-deleted for
  longer than the grace window is HARD-deleted together with its messages.
* ``redact_expired_runs`` walks the ``AgentRun`` audit trail: a run older than the
  window keeps its METRICS (status, intent, resolved, duration_ms, model) but has
  its free text (question, answer, trace, citations) replaced with the redaction
  sentinel — so long-run analytics survive without holding a student's words.

Both are IDEMPOTENT (a second pass is a no-op) and pure functions of ``now`` so a
test can pin the clock. They are intended to be driven from a scheduled job or a
management call — NOT wired to a cron here; wiring them is a deployment concern.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .models.agent_run import AgentRun
from .models.conversation import Conversation, Message
from .redaction import REDACTED, redact_pii

# A soft-deleted conversation is kept this long (so a mistaken clear is
# recoverable) before it is destroyed for good.
SOFT_DELETE_GRACE_DAYS = 30


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def purge_expired(db: Session, now: datetime | None = None) -> dict[str, int]:
    """Advance every conversation one step along its retention lifecycle.

    * retention_until in the past and not yet soft-deleted -> soft-delete now and
      PII-scrub the messages it keeps through the grace window.
    * soft-deleted more than ``SOFT_DELETE_GRACE_DAYS`` ago -> hard-delete the
      conversation and its messages.

    Returns a summary ``{soft_deleted, messages_redacted, hard_deleted,
    messages_deleted}``. Idempotent: a run with nothing due changes nothing.
    """
    now = now or _utcnow()
    grace_cutoff = now - timedelta(days=SOFT_DELETE_GRACE_DAYS)

    summary = {
        "soft_deleted": 0,
        "messages_redacted": 0,
        "hard_deleted": 0,
        "messages_deleted": 0,
    }

    # --- 1) Soft-delete conversations whose retention window has closed. -------
    expired = db.scalars(
        select(Conversation).where(
            Conversation.retention_until.is_not(None),
            Conversation.retention_until < now,
            Conversation.deleted_at.is_(None),
        )
    ).all()
    for conv in expired:
        conv.deleted_at = now
        summary["soft_deleted"] += 1
        # Free text retained through the grace window is scrubbed of obvious PII.
        for msg in db.scalars(
            select(Message).where(Message.conversation_id == conv.id)
        ).all():
            scrubbed = redact_pii(msg.content)
            if scrubbed != msg.content:
                msg.content = scrubbed
                summary["messages_redacted"] += 1

    # --- 2) Hard-delete conversations soft-deleted past the grace window. ------
    doomed_ids = db.scalars(
        select(Conversation.id).where(
            Conversation.deleted_at.is_not(None),
            Conversation.deleted_at < grace_cutoff,
        )
    ).all()
    if doomed_ids:
        summary["messages_deleted"] = (
            db.query(Message)
            .filter(Message.conversation_id.in_(doomed_ids))
            .count()
        )
        db.execute(
            delete(Message).where(Message.conversation_id.in_(doomed_ids))
        )
        db.execute(
            delete(Conversation).where(Conversation.id.in_(doomed_ids))
        )
        summary["hard_deleted"] = len(doomed_ids)

    db.commit()
    return summary


def redact_expired_runs(
    db: Session, older_than_days: int = 90, now: datetime | None = None
) -> int:
    """Redact the free text of ``AgentRun`` rows older than the window while
    keeping every metrics field, and return how many rows were redacted.

    Kept: status, intent, resolved, duration_ms, steps, model, timestamps.
    Cleared: question -> sentinel, answer -> sentinel, trace -> [], citations ->
    []. Idempotent — a row already carrying the sentinel question is skipped, so a
    second pass returns 0.
    """
    now = now or _utcnow()
    cutoff = now - timedelta(days=older_than_days)

    stale = db.scalars(
        select(AgentRun).where(
            AgentRun.created_at < cutoff,
            AgentRun.question != REDACTED,  # idempotent: skip already-redacted
        )
    ).all()

    for run in stale:
        run.question = REDACTED
        run.answer = REDACTED
        run.trace = []
        run.citations = []

    if stale:
        db.commit()
    return len(stale)
