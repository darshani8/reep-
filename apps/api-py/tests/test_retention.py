"""Assistant retention lifecycle (Assistant V2 Phase D, review #9).

The contract these tests pin, against the seeded dev DB:

  * A conversation past its retention_until is SOFT-deleted (deleted_at stamped).
  * A conversation soft-deleted longer than the grace window is HARD-deleted
    together with its messages — memory does not live forever.
  * An AgentRun older than the redaction window has its free text replaced with
    the sentinel while every METRICS field (status, intent, resolved,
    duration_ms, model) survives.
  * Both jobs are idempotent: a second pass changes nothing.

Skipped when Postgres is unreachable.
"""

from datetime import datetime, timedelta, timezone

import pytest

from conftest import requires_db

from app import retention
from app.db import SessionLocal
from app.models.agent_run import AgentRun, AgentRunStatus
from app.models.conversation import Conversation, Message
from app.models.user import Role, User


def _a_user_id(db) -> str:
    u = db.query(User).first()
    assert u is not None, "seeded DB has no users"
    return u.id


@pytest.fixture
def cleanup():
    """Track ids created by a test and delete them afterwards so the suite's
    metrics/counts are not polluted by retention fixtures."""
    conv_ids: list[str] = []
    run_ids: list[str] = []
    yield {"conversations": conv_ids, "runs": run_ids}
    with SessionLocal() as db:
        if conv_ids:
            db.query(Message).filter(Message.conversation_id.in_(conv_ids)).delete(
                synchronize_session=False
            )
            db.query(Conversation).filter(Conversation.id.in_(conv_ids)).delete(
                synchronize_session=False
            )
        if run_ids:
            db.query(AgentRun).filter(AgentRun.id.in_(run_ids)).delete(
                synchronize_session=False
            )
        db.commit()


@requires_db
def test_past_retention_conversation_is_soft_deleted(cleanup):
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        conv = Conversation(
            owner_user_id=_a_user_id(db),
            role=Role.STUDENT,
            created_at=now - timedelta(days=100),
            last_activity_at=now - timedelta(days=100),
            retention_until=now - timedelta(days=1),  # window already closed
            deleted_at=None,
        )
        db.add(conv)
        db.commit()
        cid = conv.id
        cleanup["conversations"].append(cid)

        retention.purge_expired(db, now=now)

        refreshed = db.get(Conversation, cid)
        assert refreshed is not None, "must be soft-deleted, not hard-deleted yet"
        assert refreshed.deleted_at is not None


@requires_db
def test_old_soft_deleted_conversation_hard_deletes_with_messages(cleanup):
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        conv = Conversation(
            owner_user_id=_a_user_id(db),
            role=Role.STUDENT,
            created_at=now - timedelta(days=200),
            last_activity_at=now - timedelta(days=200),
            retention_until=now - timedelta(days=110),
            deleted_at=now - timedelta(days=40),  # past the 30-day grace
        )
        db.add(conv)
        db.flush()
        cid = conv.id
        cleanup["conversations"].append(cid)
        db.add(
            Message(
                conversation_id=cid,
                sender="user",
                content="my email is test@bgscet.ac.in",
            )
        )
        db.add(
            Message(conversation_id=cid, sender="assistant", content="Noted."),
        )
        db.commit()

        assert db.query(Message).filter(Message.conversation_id == cid).count() == 2

        summary = retention.purge_expired(db, now=now)

        assert db.get(Conversation, cid) is None, "conversation must be hard-deleted"
        assert (
            db.query(Message).filter(Message.conversation_id == cid).count() == 0
        ), "its messages must be gone too"
        assert summary["hard_deleted"] >= 1
        assert summary["messages_deleted"] >= 2


@requires_db
def test_old_agent_run_is_redacted_but_metrics_survive(cleanup):
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        run = AgentRun(
            actor_id=_a_user_id(db),
            role=Role.STUDENT,
            scope="self",
            question="Am I placement-ready? My USN is 1BG21CS001.",
            answer="You are 72/100 — on track.",
            status=AgentRunStatus.ANSWERED,
            trace=[{"step": "readiness", "tool": "placement_readiness"}],
            citations=[{"label": "Placement readiness (your record)"}],
            model="test:model",
            intent="readiness",
            resolved=True,
            steps=2,
            duration_ms=1234,
            created_at=now - timedelta(days=120),  # older than the 90-day window
        )
        db.add(run)
        db.commit()
        rid = run.id
        cleanup["runs"].append(rid)

        redacted = retention.redact_expired_runs(db, older_than_days=90, now=now)
        assert redacted >= 1

        r = db.get(AgentRun, rid)
        # Free text scrubbed to the sentinel; trace/citations emptied.
        assert r.question == "[redacted]"
        assert r.answer == "[redacted]"
        assert r.trace == []
        assert r.citations == []
        # Metrics fields survive for long-run analytics.
        assert r.status == AgentRunStatus.ANSWERED
        assert r.intent == "readiness"
        assert r.resolved is True
        assert r.duration_ms == 1234
        assert r.steps == 2
        assert r.model == "test:model"


@requires_db
def test_redaction_and_purge_are_idempotent(cleanup):
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        run = AgentRun(
            actor_id=_a_user_id(db),
            role=Role.STUDENT,
            scope="self",
            question="When is my next certification due?",
            answer="Power BI in 5 days.",
            status=AgentRunStatus.ANSWERED,
            trace=[{"step": "deadlines"}],
            citations=[],
            model="test:model",
            intent="deadlines",
            resolved=True,
            duration_ms=500,
            created_at=now - timedelta(days=200),
        )
        db.add(run)
        db.commit()
        cleanup["runs"].append(run.id)

        first = retention.redact_expired_runs(db, older_than_days=90, now=now)
        assert first >= 1
        # Second pass skips the already-redacted row -> a strict no-op.
        second = retention.redact_expired_runs(db, older_than_days=90, now=now)
        assert second == 0
        assert db.get(AgentRun, run.id).question == "[redacted]"

        # purge is likewise a no-op on a second pass (nothing new becomes due).
        retention.purge_expired(db, now=now)
        s2 = retention.purge_expired(db, now=now)
        assert s2["soft_deleted"] == 0
        assert s2["hard_deleted"] == 0
