"""Assistant V2 Phase C — VOICE consent + worker transcript ingest.

Two endpoints, two audiences:

  POST /api/voice/consent     STUDENT-only; flips the caller's own
                              conversation.consent_state ('voice' | 'none').
  POST /api/voice/transcript  WORKER endpoint (X-Voice-Worker-Secret when set,
                              open in dev); persists FINAL turns only, deduped
                              on (conversation_id, provider_turn_id).

These pin the contract end-to-end via TestClient. Every row a test creates is
torn down, so the suite stays independent and re-runnable.
"""

import types
import uuid

import pytest
from sqlalchemy import delete, select

from conftest import requires_db

from app import conversations as convo
from app.db import SessionLocal
from app.models.conversation import Conversation, Message
from app.models.user import LoginDay, Role, Student, User
from app.security import hash_password


# ---------------------------------------------------------------------------
# Helpers (make_user now lives in conftest.py — it is shared with
# test_voice_gates.py, which covers /status and /token)
# ---------------------------------------------------------------------------
def _new_conversation(user_id: str) -> str:
    with SessionLocal() as db:
        return convo.get_or_create(db, user_id, Role.STUDENT).id


def _messages(conversation_id: str) -> list[Message]:
    with SessionLocal() as db:
        return list(
            db.scalars(
                select(Message).where(Message.conversation_id == conversation_id)
            ).all()
        )


def _consent_state(conversation_id: str) -> str:
    with SessionLocal() as db:
        return db.get(Conversation, conversation_id).consent_state


# ---------------------------------------------------------------------------
# Consent — STUDENT-only, flips consent_state on the caller's own conversation
# ---------------------------------------------------------------------------
@requires_db
def test_consent_flips_consent_state(client, make_user):
    s = make_user("consent")

    # Grant -> 'voice'.
    r = client.post("/api/voice/consent", headers=s.headers, json={"consent": True})
    assert r.status_code == 200, r.text
    assert r.json() == {"consent_state": "voice"}

    # The state landed on the student's own current conversation.
    with SessionLocal() as db:
        conv = convo.current_conversation(db, s.user_id)
        assert conv is not None and conv.consent_state == "voice"

    # Revoke -> 'none' (general guidance only).
    r2 = client.post("/api/voice/consent", headers=s.headers, json={"consent": False})
    assert r2.status_code == 200, r2.text
    assert r2.json() == {"consent_state": "none"}
    assert _consent_state(conv.id) == "none"


@requires_db
def test_consent_is_student_only(client, make_user):
    staff = make_user("director", role=Role.DIRECTOR)
    r = client.post(
        "/api/voice/consent", headers=staff.headers, json={"consent": True}
    )
    assert r.status_code == 403, r.text


@requires_db
def test_consent_requires_auth(client):
    r = client.post("/api/voice/consent", json={"consent": True})
    assert r.status_code == 401, r.text


# ---------------------------------------------------------------------------
# Transcript — WORKER endpoint: final-only persistence + dedup
# ---------------------------------------------------------------------------
@requires_db
def test_transcript_stores_final_once_and_dedups_repeat(client, make_user):
    s = make_user("txn")
    cid = _new_conversation(s.user_id)

    payload = {
        "conversation_id": cid,
        "speaker": "user",
        "text": "what placements are open?",
        "is_final": True,
        "provider_turn_id": "turn-1",
    }

    # First final turn is stored.
    r1 = client.post("/api/voice/transcript", json=payload)
    assert r1.status_code == 200, r1.text
    assert r1.json() == {"stored": True}

    # Same provider_turn_id again -> no-op (dedup).
    r2 = client.post("/api/voice/transcript", json=payload)
    assert r2.status_code == 200, r2.text
    assert r2.json() == {"stored": False}

    msgs = _messages(cid)
    assert len(msgs) == 1
    assert msgs[0].channel == "voice"
    assert msgs[0].sender == "user"
    assert msgs[0].is_final is True
    assert msgs[0].content == "what placements are open?"


@requires_db
def test_transcript_ignores_interim(client, make_user):
    s = make_user("interim")
    cid = _new_conversation(s.user_id)

    r = client.post(
        "/api/voice/transcript",
        json={
            "conversation_id": cid,
            "speaker": "assistant",
            "text": "partial...",
            "is_final": False,
            "provider_turn_id": "turn-x",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"stored": False}
    assert _messages(cid) == []


@requires_db
def test_transcript_unknown_conversation_is_404(client):
    r = client.post(
        "/api/voice/transcript",
        json={
            "conversation_id": "does-not-exist-" + uuid.uuid4().hex,
            "speaker": "user",
            "text": "hi",
            "is_final": True,
            "provider_turn_id": None,
        },
    )
    assert r.status_code == 404, r.text


@requires_db
def test_transcript_worker_secret_enforced(client, make_user, monkeypatch):
    """When VOICE_WORKER_SECRET is set, a caller without the header is refused."""
    import app.config as config
    import app.routers.voice as voice

    s = make_user("secret")
    cid = _new_conversation(s.user_id)

    monkeypatch.setattr(config.settings, "voice_worker_secret", "s3cr3t")
    monkeypatch.setattr(voice.settings, "voice_worker_secret", "s3cr3t")

    body = {
        "conversation_id": cid,
        "speaker": "user",
        "text": "hello",
        "is_final": True,
        "provider_turn_id": "turn-secret-1",
    }

    # No secret header -> 401.
    r_no = client.post("/api/voice/transcript", json=body)
    assert r_no.status_code == 401, r_no.text

    # Correct secret header -> stored.
    r_ok = client.post(
        "/api/voice/transcript",
        json=body,
        headers={"X-Voice-Worker-Secret": "s3cr3t"},
    )
    assert r_ok.status_code == 200, r_ok.text
    assert r_ok.json() == {"stored": True}


# ---------------------------------------------------------------------------
# Production hardening (senior-architecture review)
# ---------------------------------------------------------------------------
def test_worker_auth_fails_closed_in_production(client, monkeypatch):
    """A blank VOICE_WORKER_SECRET must NOT leave the worker endpoints open in
    production. Dev keeps them open (documented in .env.example); prod turns the
    same configuration into a hard error, because otherwise anyone who can reach
    the API could forge a heartbeat or write turns into a student's
    conversation."""
    from app.config import settings

    monkeypatch.setattr(settings, "voice_worker_secret", "", raising=False)
    monkeypatch.setattr(settings, "env", "prod", raising=False)

    r = client.post("/api/voice/heartbeat", json={"worker_id": "forged"})
    assert r.status_code == 500, r.text

    # Same configuration is deliberately permitted in dev.
    monkeypatch.setattr(settings, "env", "dev", raising=False)
    r2 = client.post("/api/voice/heartbeat", json={"worker_id": "dev-worker"})
    assert r2.status_code in (200, 503), r2.text


def test_transcript_rejects_oversized_text(client, monkeypatch):
    """Transcript text is bounded. It is replayed into later LLM prompts and
    rendered in the UI, so an unbounded field is a storage AND prompt-injection
    surface, not just a size question."""
    from app.config import settings
    from app.routers.voice import MAX_TRANSCRIPT_CHARS

    monkeypatch.setattr(settings, "voice_worker_secret", "", raising=False)
    monkeypatch.setattr(settings, "env", "dev", raising=False)

    r = client.post(
        "/api/voice/transcript",
        json={
            "conversation_id": "x" * 32,
            "speaker": "user",
            "text": "a" * (MAX_TRANSCRIPT_CHARS + 1),
            "is_final": True,
        },
    )
    assert r.status_code == 422, r.text


def test_readiness_reports_dependencies_separately(client):
    """/ready must name WHICH dependency is unhealthy, and must not fail the
    whole probe just because voice is unconfigured — the dashboard works fine
    without voice, so it must not pull the API out of rotation."""
    r = client.get("/ready")
    body = r.json()
    assert "database" in body["checks"]
    voice = body["checks"]["voice"]
    assert {"livekit_configured", "speech_key_configured", "worker_auth_configured"} <= set(voice)


def test_liveness_touches_no_dependencies(client):
    """/health stays dependency-free: if liveness checked Postgres, one DB blip
    would restart every API container at once and turn a recoverable wobble into
    an outage."""
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_database_url_preserves_sslmode():
    """sslmode must survive URL normalisation.

    This used to `url.split("?", 1)[0]`, discarding the whole query string while
    the docstring claimed it only dropped Prisma leftovers. Every managed
    Postgres hands out `?sslmode=require`, so connections silently fell back to
    libpq's default `prefer` — opportunistic TLS with no certificate
    verification, nothing logged, nothing failed. Student records would have
    crossed the network unauthenticated while the operator's secret said
    otherwise."""
    from app.config import Settings

    s = Settings(database_url="postgresql://u:p@h:5432/db?sslmode=verify-full")
    assert "sslmode=verify-full" in s.sqlalchemy_url
    assert s.sqlalchemy_url.startswith("postgresql+psycopg://")

    # Prisma leftovers are still dropped, and dropping them must not take
    # sslmode with them.
    mixed = Settings(database_url="postgresql://u:p@h/db?schema=public&sslmode=require")
    assert "schema=public" not in mixed.sqlalchemy_url
    assert "sslmode=require" in mixed.sqlalchemy_url

    # A URL with no query string is unchanged apart from the driver.
    plain = Settings(database_url="postgresql://u:p@h/db")
    assert plain.sqlalchemy_url == "postgresql+psycopg://u:p@h/db"


def test_draining_heartbeat_withdraws_readiness_immediately(client, make_user, monkeypatch):
    """A worker that says it is draining must stop counting as available AT ONCE.

    Readiness is a freshness comparison against HEARTBEAT_FRESH_SECONDS, so a
    worker that merely goes quiet on SIGTERM still reads as healthy for that
    whole window. During it, POST /api/voice/token happily mints tokens and
    dispatches calls to a process that is shutting down — the student joins a
    room, waits, and no agent ever arrives.

    So the last thing the beat loop does is post `draining: true`, which
    deregisters the worker outright.
    """
    from app.config import settings

    monkeypatch.setattr(settings, "voice_worker_secret", "", raising=False)
    monkeypatch.setattr(settings, "env", "dev", raising=False)

    # /status is STUDENT-only, so readiness has to be read as a student.
    student = make_user("drain")

    # _worker_healthy asks whether ANY worker is fresh — correct in production,
    # where several workers share the fleet, but it means a stale row left by
    # another test would mask this one. Own the table for the duration.
    from app.models.voice_worker import VoiceWorkerHeartbeat

    with SessionLocal() as db:
        db.execute(delete(VoiceWorkerHeartbeat))
        db.commit()

    worker_id = "drain-test-worker"
    r = client.post("/api/voice/heartbeat", json={"worker_id": worker_id})
    if r.status_code == 503:
        pytest.skip("voice endpoints unavailable in this environment")
    assert r.status_code == 200, r.text
    healthy = client.get("/api/voice/status", headers=student.headers)
    assert healthy.status_code == 200, healthy.text
    assert healthy.json()["worker_healthy"] is True

    # The final beat of a draining worker.
    r_drain = client.post(
        "/api/voice/heartbeat", json={"worker_id": worker_id, "draining": True}
    )
    assert r_drain.status_code == 200, r_drain.text
    assert r_drain.json().get("deregistered") is True

    # No waiting out the freshness window — it is gone now.
    after = client.get("/api/voice/status", headers=student.headers)
    assert after.status_code == 200, after.text
    assert after.json()["worker_healthy"] is False

    with SessionLocal() as db:
        db.execute(delete(VoiceWorkerHeartbeat))
        db.commit()


def test_heartbeat_draining_defaults_to_false(client, make_user, monkeypatch):
    """Omitting the field must refresh the row, not delete it.

    `draining` was added to an existing request body, so every worker built
    before it — and any rolling deploy mid-upgrade — posts without the field. If
    it defaulted to true, or the endpoint required it, a healthy worker would
    deregister itself on its very first beat.
    """
    from app.config import settings

    monkeypatch.setattr(settings, "voice_worker_secret", "", raising=False)
    monkeypatch.setattr(settings, "env", "dev", raising=False)

    student = make_user("legacy")

    r = client.post("/api/voice/heartbeat", json={"worker_id": "legacy-worker"})
    if r.status_code == 503:
        pytest.skip("voice endpoints unavailable in this environment")
    assert r.status_code == 200, r.text
    assert "last_seen" in r.json()

    still_here = client.get("/api/voice/status", headers=student.headers)
    assert still_here.status_code == 200, still_here.text
    assert still_here.json()["worker_healthy"] is True


@requires_db
def test_transcript_refuses_a_cleared_conversation(client, make_user):
    """"Clear conversation" must actually stop new voice turns landing in it.

    The lookup had no deleted_at filter, so a call already in progress kept
    appending to the thread the student had just discarded. Those rows were
    invisible in the UI — history reads only live conversations — and
    retention.purge_expired would not re-scrub them either, so a student's spoken
    words outlived the single action the product offers for removing them.

    404, not 409: from the worker's side "this thread no longer accepts writes"
    is one situation with one correct response. The worker ends the call, which
    is why this could not ship on its own — a bare 404 with an unchanged worker
    would silently discard the rest of a live call.
    """
    from datetime import datetime, timezone

    s = make_user("cleared")
    cid = _new_conversation(s.user_id)

    ok = client.post(
        "/api/voice/transcript",
        json={
            "conversation_id": cid,
            "speaker": "user",
            "text": "before clearing",
            "is_final": True,
            "provider_turn_id": "pre-clear",
        },
    )
    assert ok.status_code == 200, ok.text
    assert ok.json() == {"stored": True}

    # Soft-delete it, exactly as "Clear conversation" does.
    with SessionLocal() as db:
        conversation = db.get(Conversation, cid)
        conversation.deleted_at = datetime.now(timezone.utc)
        db.commit()

    refused = client.post(
        "/api/voice/transcript",
        json={
            "conversation_id": cid,
            "speaker": "user",
            "text": "after clearing",
            "is_final": True,
            "provider_turn_id": "post-clear",
        },
    )
    assert refused.status_code == 404, refused.text

    # And nothing was written.
    texts = [m.content for m in _messages(cid)]
    assert "after clearing" not in texts
    assert texts == ["before clearing"]
