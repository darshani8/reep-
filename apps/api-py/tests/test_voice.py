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
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture
def make_user(client):
    """Factory that creates a throwaway User (STUDENT gets a Student row too),
    logs it in, and returns email/user_id/headers. All rows are torn down."""
    created: list[str] = []

    def _make(label: str, role: Role = Role.STUDENT):
        email = f"voicetest-{label}-{uuid.uuid4().hex[:8]}@bgscet.ac.in"
        password = "voicepass123"
        with SessionLocal() as db:
            user = User(
                email=email,
                name=f"Voice Test {label}",
                role=role,
                password_hash=hash_password(password),
            )
            db.add(user)
            db.flush()
            if role == Role.STUDENT:
                db.add(Student(user_id=user.id))
            db.commit()
            uid = user.id
        created.append(uid)

        r = client.post("/api/auth/login", json={"email": email, "password": password})
        assert r.status_code == 200, r.text
        headers = {"Cookie": r.headers.get("set-cookie", "")}
        client.cookies.clear()
        return types.SimpleNamespace(email=email, user_id=uid, headers=headers)

    yield _make

    with SessionLocal() as db:
        for uid in created:
            db.execute(delete(Conversation).where(Conversation.owner_user_id == uid))
            db.execute(delete(LoginDay).where(LoginDay.user_id == uid))
            db.execute(delete(Student).where(Student.user_id == uid))
            db.execute(delete(User).where(User.id == uid))
        db.commit()


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
