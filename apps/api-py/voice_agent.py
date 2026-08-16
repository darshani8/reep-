"""Background LiveKit voice worker — Gemini Live (native speech-to-speech).

Runs as a SEPARATE process from the FastAPI server, in its own environment (the
audio/ML deps are heavy and usually want Python 3.12):

    pip install -r requirements-voice.txt
    python voice_agent.py dev            # `start` in production

Configuration is read from apps/api-py/.env — the SAME file the FastAPI server
uses, so the LiveKit and Gemini credentials are entered once and both processes
see them (GEMINI_API_KEY, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
VOICE_WORKER_SECRET). A real environment variable always wins over the file, so
REEP_API_URL (default http://localhost:3300, the port the API serves on) and
VOICE_WORKER_ID can still be overridden per-process.

Flow: it joins the LiveKit room the browser connected to, resolves the
conversation_id (the room is named reep-conversation-<id> and the participant
identity IS the conversation_id), and streams both sides' FINAL transcripts to
the FastAPI server via POST /api/voice/transcript. It never touches the DB
directly: persistence policy (final-only + dedup) lives on the server, so the
worker stays thin and DB-free. It also POSTs /api/voice/heartbeat every ~15s so
GET /api/voice/status can report worker_healthy.

Consent: a PERSONAL, record-aware voice session requires the conversation's
consent_state == 'voice' (set by the student via POST /api/voice/consent before
connecting). Absent that, the worker offers only GENERAL guidance — it does not
read the student's records into the prompt. The server is the source of truth
for consent; this worker defaults to general guidance.

Version: targets livekit-agents ~1.5 (see requirements-voice.txt) with the
Google Gemini Live plugin. The SDK event/participant contract can shift between
minor versions; the two spots marked "VERIFY" are isolated in _extract_turn()
and _resolve_conversation_id() so a version bump touches one adapter each. This
worker needs live LiveKit + Gemini credentials to run and so is NOT exercised by
the repo's tests.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, NamedTuple

from livekit import agents
from livekit.agents import Agent, AgentServer, AgentSession, JobContext
from livekit.plugins import google

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("reep-voice")


def _load_env_file() -> None:
    """Read apps/api-py/.env into the environment (stdlib only, no dotenv dep).

    The worker runs in its OWN venv but must agree with the FastAPI server on the
    LiveKit/Gemini credentials, so it reads the server's env file rather than
    asking the operator to export the same four values twice. A real environment
    variable always wins — `setdefault`, never overwrite — so per-process
    overrides (REEP_API_URL, VOICE_WORKER_ID) still work.

    Pinned to THIS file's directory for the same reason app/config.py pins its
    own: a bare ".env" resolves against the process CWD and would pick up the
    wrong file when the worker is started from the repo root.
    """
    env_path = Path(__file__).resolve().parent / ".env"
    try:
        text = env_path.read_text(encoding="utf-8")
    except OSError:
        return  # no .env — rely entirely on the real environment
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        # Values may be bare or quoted (the file is shared with pydantic-settings).
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env_file()

# Gemini Live reads the Google/Gemini key from the environment.
os.environ.setdefault("GOOGLE_API_KEY", os.getenv("GEMINI_API_KEY", ""))

GEMINI_LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"

# Where the FastAPI server lives. The worker talks to it over HTTP only — it
# holds no DB connection and no DB deps.
API_BASE = os.getenv("REEP_API_URL", "http://localhost:3300").rstrip("/")
# Presented as X-Voice-Worker-Secret on the worker endpoints. Blank -> the
# server treats the endpoints as open (dev).
WORKER_SECRET = os.getenv("VOICE_WORKER_SECRET", "")
# A stable-per-process id so GET /status can attribute the heartbeat.
WORKER_ID = os.getenv("VOICE_WORKER_ID") or f"voice-agent-{uuid.uuid4().hex[:8]}"
HEARTBEAT_INTERVAL_SECONDS = 15

ROOM_PREFIX = "reep-conversation-"

BASE_INSTRUCTIONS = (
    "You are the REEP student voice assistant for a college placement dashboard. "
    "Speak naturally and concisely. Give general placement, resume and career "
    "guidance. Do not invent specifics about the student's own records unless "
    "they are provided to you below."
)


# --------------------------------------------------------------------------- #
# HTTP to the FastAPI server (stdlib only — no extra worker deps)             #
# --------------------------------------------------------------------------- #


def _post_sync(path: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    """Blocking POST of JSON to the server. Runs off the event loop via
    asyncio.to_thread. Returns the decoded JSON body, or None on any error
    (never raises — persistence/heartbeat must not kill the call)."""
    url = f"{API_BASE}{path}"
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if WORKER_SECRET:
        headers["X-Voice-Worker-Secret"] = WORKER_SECRET
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8") or "{}"
            return json.loads(body)
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        log.warning("POST %s failed: %s", path, exc)
        return None


async def _post(path: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    return await asyncio.to_thread(_post_sync, path, payload)


async def _heartbeat_loop() -> None:
    """Ping /api/voice/heartbeat every ~15s so /status reports worker_healthy."""
    while True:
        await _post("/api/voice/heartbeat", {"worker_id": WORKER_ID})
        await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)


async def _persist_turn(
    conversation_id: str, role: str, text: str, provider_turn_id: str | None
) -> None:
    """Send a FINAL turn to the server. The server enforces final-only + dedup;
    we always mark is_final=True here because _extract_turn only surfaces final
    turns to this call."""
    await _post(
        "/api/voice/transcript",
        {
            "conversation_id": conversation_id,
            "speaker": role,
            "text": text,
            "is_final": True,
            "provider_turn_id": provider_turn_id,
        },
    )


# --------------------------------------------------------------------------- #
# SDK adapters — isolate the version-sensitive contract (the "VERIFY" spots)  #
# --------------------------------------------------------------------------- #


class Turn(NamedTuple):
    role: str  # 'user' | 'assistant'
    text: str
    is_final: bool
    turn_id: str | None


def _resolve_conversation_id(ctx: JobContext) -> str:
    """The token sets identity = conversation_id and room =
    reep-conversation-<id>; prefer the identity, fall back to the room name.

    VERIFY (livekit-agents ~1.5): remote_participants is a mapping on
    ctx.room; a participant's server-issued id is `.identity`. Both can shift
    across minor versions — keep the tolerant access below."""
    room = getattr(ctx, "room", None)
    participants = getattr(room, "remote_participants", None) or {}
    try:
        for participant in participants.values():
            identity = getattr(participant, "identity", None)
            if identity:
                return identity
    except Exception:  # noqa: BLE001 — never let discovery kill the session
        log.exception("participant discovery failed; falling back to room name")
    name = getattr(room, "name", "") or ""
    return name[len(ROOM_PREFIX):] if name.startswith(ROOM_PREFIX) else name


def _extract_turn(ev: Any) -> Turn | None:
    """Tolerantly extract (role, text, is_final, turn_id) from a
    conversation-item event across livekit-agents minor versions.

    VERIFY (livekit-agents ~1.5): the event carries the item as `.item`; an
    item exposes `.role`, its text as one of `.text_content` / `.content` /
    `.text`, a finality flag as one of `.is_final` / `.final` / `.interim`
    (inverted), and a stable id as one of `.id` / `.item_id` / `.turn_id`.
    Absent a finality flag we assume the item is final (many versions only emit
    committed items on this event). Returns None when there is no usable text."""
    item = getattr(ev, "item", ev)

    role = getattr(item, "role", None)
    if role not in ("user", "assistant"):
        return None

    text = (
        getattr(item, "text_content", None)
        or getattr(item, "content", None)
        or getattr(item, "text", None)
    )
    if not text:
        return None
    if not isinstance(text, str):
        text = str(text)

    # Finality: prefer an explicit positive flag; else invert an interim flag;
    # else assume final.
    is_final = getattr(item, "is_final", None)
    if is_final is None:
        is_final = getattr(item, "final", None)
    if is_final is None:
        interim = getattr(item, "interim", None)
        is_final = (not interim) if interim is not None else True

    turn_id = (
        getattr(item, "id", None)
        or getattr(item, "item_id", None)
        or getattr(item, "turn_id", None)
    )
    if turn_id is not None and not isinstance(turn_id, str):
        turn_id = str(turn_id)

    return Turn(role=role, text=text, is_final=bool(is_final), turn_id=turn_id)


server = AgentServer()


@server.rtc_session(agent_name="reep-voice")
async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    conversation_id = _resolve_conversation_id(ctx)
    log.info(
        "voice session for conversation_id=%s (room=%s)",
        conversation_id,
        getattr(ctx.room, "name", "?"),
    )

    # Heartbeat for the lifetime of this session so /status stays healthy.
    heartbeat_task = asyncio.create_task(_heartbeat_loop())

    # NOTE on consent: a personal, record-aware session requires the
    # conversation's consent_state == 'voice' on the server. This worker defaults
    # to GENERAL guidance and does NOT pull the student's records into the prompt.
    # (When a record-aware prompt is added later, gate it on a server check of
    # consent_state before seeding any student data here.)
    instructions = BASE_INSTRUCTIONS

    session = AgentSession(
        llm=google.realtime.RealtimeModel(
            model=GEMINI_LIVE_MODEL,
            voice="Puck",
            temperature=0.8,
        )
    )

    @session.on("conversation_item_added")
    def _on_item(ev: Any) -> None:
        turn = _extract_turn(ev)
        if turn is None or not turn.is_final:
            return  # interim / non-text items are dropped; server never sees them
        # Fire-and-forget: persistence must never block or crash the call. The
        # server dedups on (conversation_id, provider_turn_id).
        asyncio.create_task(
            _persist_turn(conversation_id, turn.role, turn.text, turn.turn_id)
        )

    try:
        await session.start(agent=Agent(instructions=instructions), room=ctx.room)
    finally:
        heartbeat_task.cancel()


if __name__ == "__main__":
    agents.cli.run_app(server)
