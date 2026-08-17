"""Transcript ingest semantics — the dedup and one-memory contract.

`POST /api/voice/transcript` is where a spoken turn becomes a row. The policy
that makes voice and text share ONE conversation memory lives here rather than in
the worker, so it is worth pinning precisely: only final turns persist, dedup is
scoped per conversation, and a repeat is a no-op rather than an update.

Companion to test_voice.py (consent + the basic store/dedup path) and
test_voice_gates.py (/status and /token).
"""

import pytest
from sqlalchemy import select

from conftest import requires_db

from app import conversations as convo
from app.db import SessionLocal
from app.models.conversation import Conversation, Message
from app.models.user import Role


def _new_conversation(user_id: str) -> str:
    with SessionLocal() as db:
        return convo.get_or_create(db, user_id, Role.STUDENT).id


def _messages(conversation_id: str) -> list[Message]:
    with SessionLocal() as db:
        return list(
            db.scalars(
                select(Message)
                .where(Message.conversation_id == conversation_id)
                .order_by(Message.created_at)
            ).all()
        )


@requires_db
def test_voice_turns_join_the_conversation_the_text_chat_reads(client, make_user):
    """ONE memory across text and voice — the point of server-owned conversations.

    Two spoken turns must come back from GET /api/agent/history, in order, on the
    caller's own conversation. If they did not, voice would be a parallel
    transcript the assistant cannot see, and asking "what did I just say?" after
    speaking would draw a blank.
    """
    s = make_user("onememory")
    cid = _new_conversation(s.user_id)

    spoken = [("user", "what jobs am I eligible for?"), ("assistant", "Two of three.")]
    for i, (speaker, text) in enumerate(spoken):
        r = client.post(
            "/api/voice/transcript",
            json={
                "conversation_id": cid,
                "speaker": speaker,
                "text": text,
                "is_final": True,
                "provider_turn_id": f"mem-{i}",
            },
        )
        assert r.status_code == 200, r.text
        assert r.json() == {"stored": True}

    history = client.get("/api/agent/history", headers=s.headers)
    assert history.status_code == 200, history.text
    body = history.json()
    assert body["conversation_id"] == cid
    assert [(t["role"], t["content"]) for t in body["turns"]] == spoken


@requires_db
def test_a_voice_turn_counts_as_activity(client, make_user):
    """Retention keys off last_activity_at.

    A conversation used heavily by voice and never typed into must not look
    abandoned, or it can be aged out from under the student who was using it.
    """
    s = make_user("activity")
    cid = _new_conversation(s.user_id)

    with SessionLocal() as db:
        before = db.get(Conversation, cid).last_activity_at

    r = client.post(
        "/api/voice/transcript",
        json={
            "conversation_id": cid,
            "speaker": "user",
            "text": "hello",
            "is_final": True,
            "provider_turn_id": "act-1",
        },
    )
    assert r.status_code == 200, r.text

    with SessionLocal() as db:
        after = db.get(Conversation, cid).last_activity_at
    assert after > before


@requires_db
def test_dedup_is_scoped_to_one_conversation(client, make_user):
    """provider_turn_id is unique PER CONVERSATION, not globally.

    Nothing promises a provider's turn ids are unique across sessions, so a
    global dedup would silently drop one student's turn because another
    student's concurrent call produced the same id — data loss that gets more
    likely the busier the worker is.
    """
    a = make_user("dedup-a")
    b = make_user("dedup-b")
    cid_a = _new_conversation(a.user_id)
    cid_b = _new_conversation(b.user_id)
    assert cid_a != cid_b

    for cid in (cid_a, cid_b):
        r = client.post(
            "/api/voice/transcript",
            json={
                "conversation_id": cid,
                "speaker": "user",
                "text": "same id, different call",
                "is_final": True,
                "provider_turn_id": "turn-collision",
            },
        )
        assert r.status_code == 200, r.text
        assert r.json() == {"stored": True}, f"{cid} was wrongly deduped"

    assert len(_messages(cid_a)) == 1
    assert len(_messages(cid_b)) == 1


@requires_db
def test_a_null_provider_turn_id_never_dedups(client, make_user):
    """No id means no dedup key, so every such turn stores.

    Treating null as a value would collapse every unidentified turn in a
    conversation into a single row — a student whose provider omits ids would
    keep only the first thing they ever said.
    """
    s = make_user("nullid")
    cid = _new_conversation(s.user_id)

    for text in ("first thing", "second thing"):
        r = client.post(
            "/api/voice/transcript",
            json={
                "conversation_id": cid,
                "speaker": "user",
                "text": text,
                "is_final": True,
                "provider_turn_id": None,
            },
        )
        assert r.status_code == 200, r.text
        assert r.json() == {"stored": True}

    assert [m.content for m in _messages(cid)] == ["first thing", "second thing"]


@requires_db
def test_a_re_emitted_turn_keeps_the_first_text(client, make_user):
    """Dedup is a no-op, NOT an update-in-place.

    A provider re-emitting a turn with revised wording must not rewrite what is
    stored. The transcript records what was said at the time; silently mutating a
    persisted turn makes the saved history disagree with what the student read on
    screen during the call.
    """
    s = make_user("reemit")
    cid = _new_conversation(s.user_id)
    payload = {
        "conversation_id": cid,
        "speaker": "user",
        "text": "the original wording",
        "is_final": True,
        "provider_turn_id": "reemit-1",
    }

    assert client.post("/api/voice/transcript", json=payload).json() == {"stored": True}

    revised = dict(payload, text="a completely different revision")
    assert client.post("/api/voice/transcript", json=revised).json() == {"stored": False}

    assert [m.content for m in _messages(cid)] == ["the original wording"]


@requires_db
def test_an_interim_turn_for_an_unknown_conversation_is_a_quiet_no_op(client):
    """Interim is dropped BEFORE the existence check, and that ordering matters.

    Interim transcripts are high-frequency and inherently racy — they can still
    be in flight when a conversation is cleared. Checking existence first would
    turn routine noise into a stream of 404s in the worker's log, burying the one
    404 that carries meaning: the conversation was cleared, so end the call.
    """
    r = client.post(
        "/api/voice/transcript",
        json={
            "conversation_id": "no-such-conversation",
            "speaker": "user",
            "text": "half a sen",
            "is_final": False,
            "provider_turn_id": None,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"stored": False}


@requires_db
@pytest.mark.parametrize("speaker", ["agent", "model", "system", ""])
def test_transcript_rejects_an_unknown_speaker(client, make_user, speaker):
    """Only 'user' and 'assistant'.

    The speaker becomes the message's role, and stored turns are replayed into
    later prompts. An unconstrained value would let the worker invent roles the
    conversation layer does not understand — 'system' most of all, since a stored
    system turn is a prompt-injection vector on every subsequent request.
    """
    s = make_user(f"speaker-{speaker or 'blank'}")
    cid = _new_conversation(s.user_id)

    r = client.post(
        "/api/voice/transcript",
        json={
            "conversation_id": cid,
            "speaker": speaker,
            "text": "hello",
            "is_final": True,
            "provider_turn_id": None,
        },
    )
    assert r.status_code == 422, r.text


@requires_db
def test_transcript_rejects_a_blank_conversation_id(client):
    r = client.post(
        "/api/voice/transcript",
        json={
            "conversation_id": "",
            "speaker": "user",
            "text": "hello",
            "is_final": True,
            "provider_turn_id": None,
        },
    )
    assert r.status_code == 422, r.text
