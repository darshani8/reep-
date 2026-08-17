"""The two readiness gates: GET /api/voice/status and POST /api/voice/token.

Both had ZERO tests, and `/token` is the security spine of the voice feature —
it is the only thing that decides which LiveKit room a browser may join and under
whose identity. Everything the browser can reach in a call is whatever this JWT
authorises, for as long as its TTL lasts.

The two must also agree. `/status` is what the UI reads to decide whether to
offer the button; `/token` re-computes the same thing to decide whether to mint.
If they drift, the student is offered a call that then refuses, or — worse — is
told voice is unavailable while tokens are still being handed out.
"""

from datetime import datetime, timedelta, timezone

import jwt
import pytest
from sqlalchemy import delete

from conftest import requires_db

from app.db import SessionLocal
from app.models.voice_worker import VoiceWorkerHeartbeat
from app.routers.voice import HEARTBEAT_FRESH_SECONDS, TOKEN_TTL, VOICE_AGENT_NAME

# Fakes. `AccessToken` only signs — it never calls LiveKit — so a real project is
# not needed to assert what the token CLAIMS.
FAKE_URL = "wss://reep-test.livekit.cloud"
FAKE_KEY = "APItestkey"
FAKE_SECRET = "test-secret-not-a-real-livekit-secret-0123456789"


@pytest.fixture
def voice_env(monkeypatch):
    """Configure the provider so readiness turns on the WORKER, not the config.

    Also clears any maintenance message: it overrides everything else, so a value
    left in the real .env would make every test here fail for the wrong reason.
    """
    from app.config import settings

    monkeypatch.setattr(settings, "livekit_url", FAKE_URL, raising=False)
    monkeypatch.setattr(settings, "livekit_api_key", FAKE_KEY, raising=False)
    monkeypatch.setattr(settings, "livekit_api_secret", FAKE_SECRET, raising=False)
    monkeypatch.setattr(settings, "groq_api_key", "gsk_test_key", raising=False)
    monkeypatch.setattr(settings, "voice_maintenance_message", "", raising=False)
    monkeypatch.setattr(settings, "voice_worker_secret", "", raising=False)
    monkeypatch.setattr(settings, "env", "dev", raising=False)
    return settings


def _beat(age_seconds: float = 0.0, worker_id: str = "test-worker") -> None:
    """Register a heartbeat of a chosen age.

    Readiness is a freshness comparison against ANY worker, so tests that need
    "no worker" must clear the table rather than merely skip beating.
    """
    seen = datetime.now(timezone.utc) - timedelta(seconds=age_seconds)
    with SessionLocal() as db:
        db.execute(delete(VoiceWorkerHeartbeat))
        db.add(VoiceWorkerHeartbeat(worker_id=worker_id, last_seen=seen))
        db.commit()


def _no_workers() -> None:
    with SessionLocal() as db:
        db.execute(delete(VoiceWorkerHeartbeat))
        db.commit()


# ---------------------------------------------------------------------------
# GET /status
# ---------------------------------------------------------------------------
@requires_db
def test_status_is_available_when_provider_and_worker_are_both_ready(
    client, make_user, voice_env
):
    student = make_user("status-green")
    _beat()

    body = client.get("/api/voice/status", headers=student.headers).json()
    assert body == {
        "available": True,
        "reason": "Voice is available.",
        "worker_healthy": True,
        "provider_ready": True,
        "maintenance_message": None,
    }


@requires_db
def test_status_names_the_missing_livekit_config(client, make_user, voice_env, monkeypatch):
    """The reason has to be actionable — it is shown to the student verbatim."""
    monkeypatch.setattr(voice_env, "livekit_url", "", raising=False)
    student = make_user("status-nolk")
    _beat()

    body = client.get("/api/voice/status", headers=student.headers).json()
    assert body["available"] is False
    assert body["provider_ready"] is False
    assert "LIVEKIT_URL" in body["reason"]


@requires_db
def test_status_names_the_missing_groq_key(client, make_user, voice_env, monkeypatch):
    """GROQ, not Gemini.

    Voice runs as a cascade (Silero VAD -> Groq Whisper -> Groq Llama -> TTS), so
    GROQ_API_KEY is what actually makes it work. Gating on a Gemini key — the old
    native speech-to-speech path — would report voice unconfigured on a machine
    where it runs perfectly, or ready on one where it cannot.

    settings.voice_model_key_present also consults os.environ, so the real
    variable has to be removed too or a developer's own key masks the test.
    """
    monkeypatch.setattr(voice_env, "groq_api_key", "", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    student = make_user("status-nogroq")
    _beat()

    body = client.get("/api/voice/status", headers=student.headers).json()
    assert body["available"] is False
    assert body["provider_ready"] is False
    assert "GROQ_API_KEY" in body["reason"]


@requires_db
def test_status_reports_a_stale_worker_as_offline(client, make_user, voice_env):
    student = make_user("status-stale")
    _beat(age_seconds=HEARTBEAT_FRESH_SECONDS * 2)

    body = client.get("/api/voice/status", headers=student.headers).json()
    assert body["worker_healthy"] is False
    assert body["available"] is False
    assert body["reason"] == "Voice worker offline."


@requires_db
def test_status_accepts_a_beat_just_inside_the_freshness_window(
    client, make_user, voice_env
):
    """The boundary, not just the two extremes.

    The worker beats every 10s against a 30s window precisely so one slow POST is
    not an outage. If the window were ever tightened to the beat interval, this
    is what would catch it.
    """
    student = make_user("status-edge")
    _beat(age_seconds=HEARTBEAT_FRESH_SECONDS - 5)

    body = client.get("/api/voice/status", headers=student.headers).json()
    assert body["worker_healthy"] is True


@requires_db
def test_maintenance_message_overrides_a_perfectly_healthy_stack(
    client, make_user, voice_env, monkeypatch
):
    """The incident switch must win over everything else, or it is not a switch."""
    monkeypatch.setattr(
        voice_env, "voice_maintenance_message", "  Voice is down for maintenance.  ",
        raising=False,
    )
    student = make_user("status-maint")
    _beat()

    body = client.get("/api/voice/status", headers=student.headers).json()
    assert body["available"] is False
    # Stripped: it is rendered straight into the UI.
    assert body["maintenance_message"] == "Voice is down for maintenance."
    assert body["reason"] == "Voice is down for maintenance."
    # The rest of the stack is still honestly reported.
    assert body["worker_healthy"] is True
    assert body["provider_ready"] is True


@requires_db
def test_status_is_student_only(client, make_user, voice_env):
    """Voice is a student surface; staff have no voice assistant."""
    from app.models.user import Role

    mentor = make_user("status-mentor", role=Role.MENTOR)
    assert client.get("/api/voice/status", headers=mentor.headers).status_code == 403


def test_status_requires_authentication(client):
    assert client.get("/api/voice/status").status_code == 401


# ---------------------------------------------------------------------------
# POST /token — the security spine
# ---------------------------------------------------------------------------
@requires_db
def test_token_grants_only_the_callers_own_room(client, make_user, voice_env):
    """Decode the JWT and assert exactly what it authorises.

    A leaked token is valid for TOKEN_TTL, so the grant has to be as narrow as a
    voice call actually needs: one named room, microphone only, no data channel,
    no metadata writes. This is the assertion that would fail if someone widened
    VideoGrants for convenience.
    """
    student = make_user("token-grants")
    _beat()

    res = client.post("/api/voice/token", headers=student.headers)
    assert res.status_code == 200, res.text
    body = res.json()

    claims = jwt.decode(body["token"], FAKE_SECRET, algorithms=["HS256"])
    grants = claims["video"]

    # Identity IS the conversation id — that is how the worker resolves which
    # Postgres conversation to persist turns into.
    assert claims["sub"] == body["conversation_id"]
    assert body["identity"] == body["conversation_id"]

    assert grants["roomJoin"] is True
    assert grants["room"] == body["room"]
    assert grants.get("canPublishData") is False
    assert grants.get("canUpdateOwnMetadata") is False
    assert grants.get("canPublishSources") == ["microphone"]

    # Short-lived by design.
    assert 0 < claims["exp"] - claims["nbf"] <= TOKEN_TTL.total_seconds()

    assert body["url"] == FAKE_URL


@requires_db
def test_token_dispatches_the_named_agent(client, make_user, voice_env):
    """A NAMED agent opts out of automatic dispatch.

    Without an explicit RoomConfiguration the student joins a room, publishes a
    microphone, and no agent ever arrives — while every process involved reports
    itself healthy. The name here must match the worker's registration.
    """
    student = make_user("token-dispatch")
    _beat()

    body = client.post("/api/voice/token", headers=student.headers).json()
    claims = jwt.decode(body["token"], FAKE_SECRET, algorithms=["HS256"])

    agents = claims["roomConfig"]["agents"]
    assert [a["agentName"] for a in agents] == [VOICE_AGENT_NAME]


@requires_db
def test_token_ignores_a_client_supplied_conversation_id(client, make_user, voice_env):
    """The conversation is derived from the session cookie, never from the body.

    Honouring a client-supplied id would let any student mint a token whose
    identity is ANOTHER student's conversation, and the worker would then write
    their spoken turns into that person's thread.
    """
    victim = make_user("token-victim")
    attacker = make_user("token-attacker")
    _beat()

    victim_cid = client.post("/api/voice/token", headers=victim.headers).json()[
        "conversation_id"
    ]

    forged = client.post(
        "/api/voice/token",
        headers=attacker.headers,
        json={"conversation_id": victim_cid},
    )
    assert forged.status_code == 200, forged.text
    assert forged.json()["conversation_id"] != victim_cid


@requires_db
def test_each_call_gets_a_fresh_room_on_the_same_conversation(
    client, make_user, voice_env
):
    """Room name unique PER CALL; conversation stable across calls.

    LiveKit applies a token's RoomConfiguration only when the room is first
    created, and an empty room lingers (empty_timeout). A stable per-conversation
    room name therefore dispatched the agent on the first call and silently
    dropped it on any later call that reused the still-live room — an
    intermittent silent call that reads as a flaky provider.
    """
    student = make_user("token-rooms")
    _beat()

    first = client.post("/api/voice/token", headers=student.headers).json()
    second = client.post("/api/voice/token", headers=student.headers).json()

    assert first["conversation_id"] == second["conversation_id"]
    assert first["room"] != second["room"]
    for body in (first, second):
        assert body["room"].startswith(f"reep-conversation-{body['conversation_id']}-")


@requires_db
def test_token_is_student_only(client, make_user, voice_env):
    from app.models.user import Role

    director = make_user("token-director", role=Role.DIRECTOR)
    _beat()
    assert client.post("/api/voice/token", headers=director.headers).status_code == 403


def test_token_requires_authentication(client):
    assert client.post("/api/voice/token").status_code == 401


# ---------------------------------------------------------------------------
# The paired-gate invariant
# ---------------------------------------------------------------------------
@requires_db
@pytest.mark.parametrize(
    "scenario,expected_token_status",
    [
        ("green", 200),
        # Provider fine, nobody listening — transient, so 409 rather than 503.
        ("stale_worker", 409),
        ("no_provider", 503),
        ("maintenance", 503),
    ],
)
def test_status_available_iff_token_succeeds(
    client, make_user, voice_env, monkeypatch, scenario, expected_token_status
):
    """`/status.available` must be true exactly when `/token` returns 200.

    Two gates computing readiness separately is how a student ends up being
    offered a call that immediately refuses. They share _compute_status today;
    this is the cheap guard against that being unpicked.
    """
    if scenario == "green":
        _beat()
    elif scenario == "stale_worker":
        _beat(age_seconds=HEARTBEAT_FRESH_SECONDS * 2)
    elif scenario == "no_provider":
        monkeypatch.setattr(voice_env, "livekit_api_secret", "", raising=False)
        _beat()
    elif scenario == "maintenance":
        monkeypatch.setattr(
            voice_env, "voice_maintenance_message", "Down for maintenance.", raising=False
        )
        _beat()

    student = make_user(f"gate-{scenario}")

    st = client.get("/api/voice/status", headers=student.headers).json()
    tk = client.post("/api/voice/token", headers=student.headers)

    assert (tk.status_code == 200) is st["available"]
    assert tk.status_code == expected_token_status, tk.text
    if tk.status_code != 200:
        # The refusal must carry the SAME explanation the student already saw.
        assert tk.json()["detail"] == st["reason"]


# ---------------------------------------------------------------------------
# POST /heartbeat
# ---------------------------------------------------------------------------
@requires_db
def test_heartbeat_upserts_rather_than_accumulating(client, voice_env):
    """One row per worker, refreshed — not one row per beat.

    At a beat every 10s, inserting instead of updating would add ~8,600 rows per
    worker per day to the table that every /status call scans.
    """
    _no_workers()

    first = client.post("/api/voice/heartbeat", json={"worker_id": "upsert-worker"})
    assert first.status_code == 200, first.text
    second = client.post("/api/voice/heartbeat", json={"worker_id": "upsert-worker"})
    assert second.status_code == 200, second.text

    with SessionLocal() as db:
        rows = db.query(VoiceWorkerHeartbeat).all()
        assert len(rows) == 1
    assert second.json()["last_seen"] >= first.json()["last_seen"]


@requires_db
def test_heartbeat_flips_readiness_on(client, make_user, voice_env):
    _no_workers()
    student = make_user("beat-flip")

    before = client.get("/api/voice/status", headers=student.headers).json()
    assert before["worker_healthy"] is False

    client.post("/api/voice/heartbeat", json={"worker_id": "flip-worker"})

    after = client.get("/api/voice/status", headers=student.headers).json()
    assert after["worker_healthy"] is True


@requires_db
def test_heartbeat_rejects_a_wrong_worker_secret(client, monkeypatch):
    """A WRONG secret must 401 — not merely a missing one.

    The existing /transcript test covers the missing-header case. A wrong value
    is the one that actually happens: the API and the worker are configured
    separately, and a mismatch has to fail loudly rather than be treated as
    absent.
    """
    from app.config import settings

    monkeypatch.setattr(settings, "voice_worker_secret", "the-real-secret", raising=False)
    monkeypatch.setattr(settings, "env", "dev", raising=False)

    wrong = client.post(
        "/api/voice/heartbeat",
        json={"worker_id": "w"},
        headers={"X-Voice-Worker-Secret": "not-the-real-secret"},
    )
    assert wrong.status_code == 401, wrong.text

    right = client.post(
        "/api/voice/heartbeat",
        json={"worker_id": "w"},
        headers={"X-Voice-Worker-Secret": "the-real-secret"},
    )
    assert right.status_code == 200, right.text


@requires_db
def test_heartbeat_rejects_a_blank_worker_id(client, voice_env):
    res = client.post("/api/voice/heartbeat", json={"worker_id": ""})
    assert res.status_code == 422
