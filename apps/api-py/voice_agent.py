"""Background LiveKit voice worker — a four-stage speech CASCADE.

    py -3.12 -m venv .venv-voice
    .venv-voice/Scripts/pip install -r requirements-voice.txt
    python voice_agent.py dev            # `start` in production

PIPELINE (this is NOT native speech-to-speech):

    student audio
      -> LiveKit BVC noise cancellation   (strips the agent's own echo)
      -> Silero VAD                       (local, decides when they stopped)
      -> Groq Whisper  whisper-large-v3-turbo      (speech -> text)
      -> Groq Llama    llama-3.3-70b-versatile     (text -> reply)
      -> Groq TTS (default) or Edge TTS   (reply -> speech)
    -> student hears it

Gemini Live was the original design and is NO LONGER USED: this Google project
is denied access to the Live API (WebSocket close 1008, "project has been denied
access"), confirmed by connecting to Google directly with LiveKit out of the
path. Nothing here imports the Gemini plugin. GEMINI_API_KEY is not required.

Costs of the cascade, so nobody rediscovers them: roughly a second more latency
than a native model, and Groq Whisper is a BATCH call — it does not stream and
carries no word alignment, which is why endpointing must wait ~1.5s and why
adaptive interruption is unavailable (see AgentSession below).

Configuration is read from apps/api-py/.env — the SAME file the FastAPI server
uses, so credentials are entered once and both processes see them (GROQ_API_KEY,
LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, VOICE_TTS,
VOICE_WORKER_SECRET). A real environment variable always wins over the file, so
REEP_API_URL (default http://localhost:3300) and VOICE_WORKER_ID can still be
overridden per-process.

VOICE_MAX_CALL_SECONDS (default 900) is ENFORCED here and nowhere else, because
only this process knows a call is still running — the LiveKit token's TTL bounds
the JOIN, never the call. It is the same .env key the API reads into
settings.voice_max_call_seconds, so the two agree without anyone syncing them;
the API's half of the same guard rail is the per-student token cap (audit H2).
VOICE_LOG_TRANSCRIPTS is a debugging opt-in that writes spoken words to this log;
leave it off (audit M10).

Flow: it joins the LiveKit room the browser connected to, resolves the
conversation_id from the room name, and posts both sides' FINAL transcripts to
POST /api/voice/transcript. It never touches the DB directly: persistence policy
(final-only + dedup) lives on the server, so the worker stays thin and DB-free.
A daemon thread POSTs /api/voice/heartbeat every ~15s for the lifetime of the
PROCESS — not per session — because GET /api/voice/status must report
worker_healthy before any token can be minted.

Consent: POST /api/voice/consent records consent_state on the conversation, but
this worker does NOT read it and always runs the same general prompt. No student
record is ever placed in the prompt, so nothing personal reaches the providers;
the consent flag is scaffolding for a record-aware mode that does not exist yet.
Do not read it as an enforced runtime control.

Version: pinned to livekit-agents 1.6.10. The SDK contract shifts between minor
versions — see requirements-voice.txt for exactly what was verified and how, and
re-run that introspection before the first live call after any bump.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from collections.abc import Callable
from typing import Any, NamedTuple

import edge_tts
from livekit import agents
from livekit.agents import (
    DEFAULT_API_CONNECT_OPTIONS,
    Agent,
    AgentServer,
    AgentSession,
    APIConnectOptions,
    JobContext,
    tts as lk_tts,
    utils as lk_utils,
)
from livekit.agents.voice.room_io import AudioInputOptions, RoomOptions
from livekit.plugins import groq, noise_cancellation, silero

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


def _int_env(name: str, default: int, *, minimum: int = 1) -> int:
    """An int from the environment that cannot kill the process at IMPORT.

    `int(os.getenv(NAME, "10"))` looks safe and is not: os.getenv returns the
    default only when the key is ABSENT, and a bare `VOICE_HEARTBEAT_INTERVAL_SECONDS=`
    line sets it to the empty string. int("") raises ValueError at module import,
    before the worker has registered with LiveKit or logged anything useful --
    and apps/api-py/.env is shared by four processes, any of which may leave a
    key with no value while someone is editing it. app/config.py solves exactly
    this for the API process (`_blank_is_default`); the worker gets no
    pydantic-settings, so it gets this.

    A value below `minimum` also falls back rather than being honoured. These
    numbers are caps and intervals: `VOICE_MAX_CALL_SECONDS=0` read literally
    means "hang up on every student the instant they connect", and a typo must
    not be able to mean that. Same reasoning as config.py's `_must_be_positive`,
    except that refusing to boot is the wrong answer out here -- the worker is
    the only thing standing between a student and a silent room.
    """
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        log.warning("%s=%r is not a whole number - using %d", name, raw, default)
        return default
    if value < minimum:
        log.warning(
            "%s=%d is below the minimum of %d - using %d", name, value, minimum, default
        )
        return default
    return value


def _flag_env(name: str) -> bool:
    """An OPT-IN boolean: only an explicit yes is true, everything else is false.

    A string rather than a real bool for the same reason config.py keeps
    llm_allow_remote_student_data as one: a blank line in the shared .env must be
    legal. Unrecognised spellings read as OFF, deliberately -- every flag this
    reads guards something that is safer left off.
    """
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


# --- Cascade model choices -------------------------------------------------- #
# Groq serves BOTH stages this worker needs from one free key: Whisper for
# speech-to-text and Llama for the reply. GROQ_API_KEY is read from the same .env
# the FastAPI server uses.
GROQ_STT_MODEL = "whisper-large-v3-turbo"
GROQ_LLM_MODEL = "llama-3.3-70b-versatile"

# Which text-to-speech speaks to the student.
#
# DEFAULT IS "groq", AND THAT IS A PRIVACY DECISION, NOT A PREFERENCE. It used to
# default to "edge", which routes every word the assistant says to an
# UNOFFICIAL Microsoft endpoint: no terms of service, no privacy undertaking, no
# SLA, no quota. requirements-voice.txt has said in writing that this is unfit
# for a student cohort since edge-tts was added -- and it was still what a fresh
# checkout, a demo, and any deployment that never set VOICE_TTS actually used.
# A default is what runs, so a documented warning next to a dangerous default is
# just a record of the decision nobody made.
#
# Groq TTS is an officially supported plugin on the SAME key as the other two
# cascade stages, so choosing it adds no new vendor to the trust boundary. Its
# one cost is a one-off terms acceptance in the Groq console, which is a person
# reading terms -- the thing edge-tts does not offer at all.
#
# "edge" remains available and is now OPT-IN, with a loud warning every time it
# is selected (see _warn_if_unofficial_tts). Anything ELSE -- a typo, "grok",
# "elevenlabs" -- falls back to groq rather than to edge: an unrecognised value
# must not be able to silently route student-facing audio to the endpoint we
# just stopped defaulting to.
VOICE_TTS = os.getenv("VOICE_TTS", "groq").strip().lower()
GROQ_TTS_MODEL = os.getenv("GROQ_TTS_MODEL", "canopylabs/orpheus-v1-english")
GROQ_TTS_VOICE = os.getenv("GROQ_TTS_VOICE", "autumn")
# Indian-English voice, chosen for LATENCY as much as accent. Measured
# time-to-first-audio on this machine: Prabhat 0.75s, Neerja 1.30s,
# en-GB-Sonia 2.08s. In a spoken conversation that half-second is the
# difference between a reply and an awkward pause, and a slower voice also
# starves the audio emitter mid-sentence — which is what "the voice keeps
# breaking" actually sounds like.
EDGE_TTS_VOICE = os.getenv("EDGE_TTS_VOICE", "en-IN-PrabhatNeural")
# edge-tts returns MPEG at 24 kHz mono; the emitter is told the same below.
EDGE_TTS_SAMPLE_RATE = 24000

# Where the FastAPI server lives. The worker talks to it over HTTP only — it
# holds no DB connection and no DB deps.
API_BASE = os.getenv("REEP_API_URL", "http://localhost:3300").rstrip("/")
# Presented as X-Voice-Worker-Secret on the worker endpoints. Blank -> the
# server treats the endpoints as open (dev).
WORKER_SECRET = os.getenv("VOICE_WORKER_SECRET", "")
# A stable-per-process id so GET /status can attribute the heartbeat.
WORKER_ID = os.getenv("VOICE_WORKER_ID") or f"voice-agent-{uuid.uuid4().hex[:8]}"
# Was 15, which the server asks to be "well inside" its 30s freshness window —
# and _post_sync blocks for up to 10s, so 15 + a slow POST already exceeded it
# and one stalled beat read as an outage.
HEARTBEAT_INTERVAL_SECONDS = _int_env("VOICE_HEARTBEAT_INTERVAL_SECONDS", 10)
# Poll the SDK's draining flag far more often than we beat, so a SIGTERM is
# noticed within a second rather than after a full beat interval.
DRAIN_POLL_SECONDS = 1.0

# Hard ceiling on ONE call, in seconds. Mirrors settings.voice_max_call_seconds
# on the API side; they are two processes reading the same .env, so they are kept
# equal by configuration rather than by an import (this worker imports nothing
# from app/ -- see tests/test_voice_worker_source.py).
#
# THE LIVEKIT TOKEN'S TTL IS NOT THIS. app/routers/voice.py mints a token valid
# for 10 minutes, but LiveKit validates it once, at JOIN, and never again: a
# student admitted at 9m59s keeps the room, this worker process, and a
# Groq-billed STT+LLM+TTS cascade for as long as the tab stays open. Before this
# cap the only thing that ended a forgotten call was the student closing the tab.
# The API cannot enforce it -- it never learns a call started, let alone ended --
# so it lives here, where the session actually is.
VOICE_MAX_CALL_SECONDS = _int_env("VOICE_MAX_CALL_SECONDS", 900)

# OFF by default, and it must stay that way. When on, spoken turns are written to
# THIS PROCESS'S LOG, which is outside every retention control the product
# offers: "Clear conversation" soft-deletes rows in Postgres, retention.purge
# scrubs rows in Postgres, and neither has ever touched a log file. A student who
# used the one control we give them for erasing their words would still leave
# them here, indefinitely, wherever this log is shipped. Turn it on to debug a
# specific transcription fault, and turn it off again.
VOICE_LOG_TRANSCRIPTS = _flag_env("VOICE_LOG_TRANSCRIPTS")

ROOM_PREFIX = "reep-conversation-"

# A GENERAL assistant that happens to live inside REEP — not a placement-only
# bot. It may answer anything it knows, the way any general assistant would.
#
# The privacy guarantee is ARCHITECTURAL, not a matter of asking the model
# nicely: no student record is ever placed in this prompt, so there is nothing
# personal for the remote model to receive, memorise or leak. Widening what the
# assistant may TALK about therefore does not widen what REEP DISCLOSES. If a
# record-aware voice mode is ever added, that gate is the thing to reason about
# (AGENTS.md rule 1) — not this text.
BASE_INSTRUCTIONS = (
    "You are a helpful voice assistant. You are speaking with a student at "
    "BGS College of Engineering and Technology through the REEP dashboard, but "
    "you are a general assistant — answer whatever they ask, on any topic, "
    "exactly as a knowledgeable friend would. Do not deflect a question just "
    "because it is unrelated to college, placements or careers.\n"
    "\n"
    "You are SPEAKING, not writing. Keep replies short — usually one to three "
    "sentences. Use plain spoken language: no markdown, no bullet points, no "
    "headings, no emoji, no code blocks. Say numbers and dates the way a person "
    "would say them out loud. If something genuinely needs a long answer, give "
    "the short version first and offer to go deeper.\n"
    "\n"
    "Be direct and natural. Skip filler like 'That's a great question'. Ask a "
    "brief clarifying question when the request is ambiguous rather than "
    "guessing at length.\n"
    "\n"
    "You cannot see this student's marks, attendance, CGPA or any other record "
    "from their dashboard — those are not available to you. If they ask about "
    "their own figures, say plainly that you cannot see them here and point "
    "them to their records page or their mentor. Never invent them.\n"
    "\n"
    "This community greets with 'Jai Shri Gurudev'. If the student greets you "
    "with it, return the greeting warmly rather than treating it as a question."
)

# The exact opening words. Spoken via session.say() rather than asked of the LLM
# so the phrase is guaranteed verbatim — a compulsory greeting must not be
# paraphrased, translated or dropped because the model felt creative.
GREETING = "Jai Shri Gurudev! How can I help you today?"


# --------------------------------------------------------------------------- #
# HTTP to the FastAPI server (stdlib only — no extra worker deps)             #
# --------------------------------------------------------------------------- #


class PostResult(NamedTuple):
    """Outcome of one POST.

    `status` is the HTTP code when the server answered, None when it could not
    be reached. Callers need it because not every failure means the same thing:
    a 404 from /transcript says the conversation is gone and the call should
    END, while a connection error is transient and must be ignored.
    """

    ok: bool
    status: int | None
    body: dict[str, Any] | None


def _post_sync(path: str, payload: dict[str, Any]) -> PostResult:
    """Blocking POST of JSON to the server. Runs off the event loop via
    asyncio.to_thread. NEVER raises — persistence/heartbeat must not kill the
    call — so failures come back as ok=False with the status when there is one."""
    url = f"{API_BASE}{path}"
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if WORKER_SECRET:
        headers["X-Voice-Worker-Secret"] = WORKER_SECRET
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8") or "{}"
            return PostResult(True, resp.status, json.loads(body))
    except urllib.error.HTTPError as exc:
        # MUST be caught before URLError (it is a subclass) and logged at ERROR,
        # not WARNING. A rejected POST is the quietest serious failure in this
        # stack: a 401 from a VOICE_WORKER_SECRET mismatch, or a 404 on a
        # conversation, produces a call that sounds completely normal to the
        # student and writes ZERO rows to `messages`. The status code is the only
        # thing that distinguishes "misconfigured" from "server down", and it was
        # being folded into a generic warning nobody tails.
        try:
            detail = exc.read()[:200].decode("utf-8", "replace")
        except Exception:  # noqa: BLE001 - body already consumed or unreadable
            detail = "<no body>"
        log.error("POST %s -> HTTP %s: %s", path, exc.code, detail)
        return PostResult(False, exc.code, None)
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        log.warning("POST %s failed: %s", path, exc)
        return PostResult(False, None, None)


async def _post(path: str, payload: dict[str, Any]) -> PostResult:
    return await asyncio.to_thread(_post_sync, path, payload)


def _start_heartbeat_thread(server: "AgentServer | None" = None) -> threading.Thread:
    """Beat for the lifetime of the WORKER PROCESS — not per session.

    This MUST NOT be tied to a session. GET /api/voice/status only reports
    `available` when a heartbeat is fresh, and POST /api/voice/token refuses to
    mint a token unless status is available. A session-scoped heartbeat is
    therefore a deadlock: no token without a session, no session without a
    token, no heartbeat without a session — voice never becomes available and
    the student is told "Voice worker offline" forever, even though the worker
    is registered with LiveKit and idle-waiting for a job.

    A daemon thread rather than an asyncio task: it must be beating before
    agents.cli.run_app() takes over the main thread, i.e. while the worker sits
    idle with no event loop of its own to schedule onto.

    GRACEFUL DRAIN. On SIGTERM the SDK drains itself — cli.py runs
    `server.drain()` (DRAIN_TIMEOUT 3600s), which marks the worker draining,
    tells LiveKit to stop dispatching, and waits for in-flight jobs to finish.
    That part is NOT reimplemented here.

    What the SDK cannot know about is this heartbeat. Left alone it keeps
    posting for the whole drain, so /api/voice/status still reports the worker
    healthy and POST /api/voice/token keeps minting tokens that dispatch calls
    to a process that is shutting down — students would join rooms no agent ever
    joins.

    Simply STOPPING the beat is not enough. Readiness is a freshness comparison
    on the server (HEARTBEAT_FRESH_SECONDS), so going quiet means unavailability
    lags SIGTERM by up to that whole window, and tokens keep being minted at a
    draining worker for the length of it. So the loop exits on `server.draining`
    and then posts one final `draining: true` beat, which deregisters the worker
    outright. Withdrawal drops from ~30s to ~1s. In-flight calls are untouched.

    Reading the SDK's flag rather than installing a SIGTERM handler is
    deliberate — cli.py installs its own handlers for the signals we would want,
    and racing it would be fragile.
    """
    stop = threading.Event()

    def beat() -> None:
        def draining() -> bool:
            return server is not None and server.draining

        while not stop.is_set() and not draining():
            _post_sync("/api/voice/heartbeat", {"worker_id": WORKER_ID})
            # Sleep in DRAIN_POLL_SECONDS slices rather than one long wait: a
            # drain must be noticed within a second, not a full beat interval.
            waited = 0.0
            while waited < HEARTBEAT_INTERVAL_SECONDS and not stop.is_set() and not draining():
                stop.wait(DRAIN_POLL_SECONDS)
                waited += DRAIN_POLL_SECONDS

        if draining():
            # Safe because the beat loop has already EXITED — nothing can race in
            # and resurrect the row, since the server deletes it rather than
            # tombstoning it. The thread is a daemon, but the process stays alive
            # for the whole drain, so there is ample time for this POST.
            _post_sync("/api/voice/heartbeat", {"worker_id": WORKER_ID, "draining": True})
            log.info("worker draining — deregistered; no new calls will be dispatched, "
                     "in-flight calls are left to finish")

    thread = threading.Thread(target=beat, name="reep-voice-heartbeat", daemon=True)
    thread.start()
    return thread


# Background tasks this module starts and never awaits. asyncio keeps only a
# WEAK reference to a running task, so a bare create_task() can be collected
# mid-flight and simply stop existing -- the hazard this file already guards on
# transcript writes, and the one the disconnect call below used to have.
#
# Process-wide rather than per-session, unlike `pending_writes` in entrypoint().
# The distinction matters and is not an oversight: pending_writes is AWAITED at
# end of call, so sharing it across sessions coupled one student's hang-up to
# every other call on the worker. Nothing ever waits on this set -- it exists
# only to hold references -- so there is no coupling to create.
_BACKGROUND_TASKS: set[asyncio.Task[Any]] = set()


def _spawn(coro: Any, *, what: str) -> "asyncio.Task[Any]":
    """create_task() with the two things a bare create_task() does not give you.

    1. A STRONG REFERENCE, held until the task completes (see above).
    2. The exception OBSERVED. An un-awaited task that raises is silent until
       the garbage collector eventually prints "Task exception was never
       retrieved", detached from the call it belonged to and often after the job
       process is gone. Every caller here is doing something whose failure is
       invisible from the outside -- hanging up a room that is discarding turns,
       or enforcing the call-duration cap -- so a failure that logs nothing means
       the guard silently is not there.

    CancelledError is not an error: shutting the session down cancels these on
    purpose.
    """
    task = asyncio.create_task(coro)
    _BACKGROUND_TASKS.add(task)

    def _done(finished: "asyncio.Task[Any]") -> None:
        _BACKGROUND_TASKS.discard(finished)
        if finished.cancelled():
            return
        exc = finished.exception()
        if exc is not None:
            log.error("%s failed: %r", what, exc)

    task.add_done_callback(_done)
    return task


async def _persist_turn(
    conversation_id: str, role: str, text: str, provider_turn_id: str | None,
    on_conversation_gone: "Callable[[], None] | None" = None,
) -> None:
    """Send a FINAL turn to the server. The server enforces final-only + dedup;
    we always mark is_final=True here because _extract_turn only surfaces final
    turns to this call.

    `on_conversation_gone` fires when the server answers 404 — the student
    pressed "Clear conversation" mid-call, so the thread this room is pinned to
    no longer accepts writes. The room and identity are fixed for the token's
    whole TTL and there is no re-resolve path, so continuing would mean speaking
    into a call whose every remaining word is discarded. The caller ends it.
    """
    # Log both the attempt and the outcome. Persistence failures are otherwise
    # completely invisible: _post_sync swallows errors so a bad write can never
    # kill a live call, which means a misconfigured REEP_API_URL or a stray
    # conversation id would silently drop every transcript while the call itself
    # looks perfect.
    result = await _post(
        "/api/voice/transcript",
        {
            "conversation_id": conversation_id,
            "speaker": role,
            "text": text,
            "is_final": True,
            "provider_turn_id": provider_turn_id,
        },
    )
    if result.ok and result.body is not None:
        log.info(
            "transcript persisted: %s (%d chars) stored=%s",
            role, len(text), result.body.get("stored"),
        )
        return

    if result.status == 404:
        log.warning(
            "conversation %s no longer accepts writes (cleared mid-call) — ending the session",
            conversation_id,
        )
        if on_conversation_gone is not None:
            on_conversation_gone()
        return

    log.warning("transcript NOT persisted (%s, %d chars) — POST failed", role, len(text))


# --------------------------------------------------------------------------- #
# SDK adapters — isolate the version-sensitive contract (the "VERIFY" spots)  #
# --------------------------------------------------------------------------- #


class Turn(NamedTuple):
    role: str  # 'user' | 'assistant'
    text: str
    is_final: bool
    turn_id: str | None


def _resolve_conversation_id(ctx: JobContext) -> str:
    """The token sets BOTH room = reep-conversation-<id> and identity = <id>.

    The ROOM NAME is the authoritative source, not the participant identity:
      * it is available the moment ctx.connect() returns, whereas
        remote_participants races the browser's join — an empty mapping here
        would silently mis-resolve the conversation;
      * it cannot be confused by a second participant (another agent, a staff
        observer) — picking "the first remote participant" would take whichever
        identity the mapping happened to yield first.

    Participant identity is kept only as a fallback for a room whose name does
    not carry the prefix."""
    room = getattr(ctx, "room", None)

    name = getattr(room, "name", "") or ""
    if name.startswith(ROOM_PREFIX):
        # Rooms are named reep-conversation-<conversation_id>-<per-call nonce>
        # (the nonce keeps each call a NEW room so LiveKit honours the token's
        # agent dispatch). Conversation ids are dash-free uuid4 hex, so the
        # first dash after the prefix separates id from nonce.
        return name[len(ROOM_PREFIX):].split("-", 1)[0]

    participants = getattr(room, "remote_participants", None) or {}
    try:
        for participant in participants.values():
            identity = getattr(participant, "identity", None)
            if identity:
                return identity
    except Exception:  # noqa: BLE001 — never let discovery kill the session
        log.exception("participant discovery failed; falling back to room name")
    return name


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

    # VERIFIED against livekit-agents 1.6.10: ChatMessage.text_content is a
    # property returning `str | None` — the joined text parts, with the model's
    # <expr/> markup stripped on assistant turns. Take ONLY that.
    #
    # Do NOT fall back to `.content`: it is a LIST of content parts, so a turn
    # carrying no text (audio- or image-only) would stringify to a Python repr
    # — "[ImageContent(id='img_…', …)]" — and get persisted as the student's
    # transcript turn, polluting the conversation the text chat also reads.
    text = getattr(item, "text_content", None)
    if not isinstance(text, str) or not text.strip():
        return None

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


# --------------------------------------------------------------------------- #
# edge-tts adapter — the free, no-account voice                               #
# --------------------------------------------------------------------------- #


class EdgeTTS(lk_tts.TTS):
    """Speak through Microsoft Edge's TTS voices.

    There is no official livekit plugin for edge-tts, so this implements the
    two-class contract the SDK expects (verified against livekit-agents 1.6.10):
    a TTS that hands back a ChunkedStream, and a ChunkedStream whose _run pushes
    encoded audio into the supplied AudioEmitter.

    OPT-IN ONLY (VOICE_TTS=edge). It needs no API key and no terms acceptance,
    which is exactly why it was the default and exactly why it must not be:
    an endpoint with no terms has made no undertaking about the audio it is
    sent. Kept for local development on a checkout with no Groq TTS access —
    prefer VOICE_TTS=groq for anything students actually use.
    """

    def __init__(self, *, voice: str = EDGE_TTS_VOICE) -> None:
        super().__init__(
            # No streaming synthesis: edge-tts wants the whole sentence before
            # it starts, so the SDK should chunk text for us rather than expect
            # a token-by-token socket.
            capabilities=lk_tts.TTSCapabilities(streaming=False, aligned_transcript=False),
            sample_rate=EDGE_TTS_SAMPLE_RATE,
            num_channels=1,
        )
        self._voice = voice

    def synthesize(
        self,
        text: str,
        *,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> "EdgeChunkedStream":
        return EdgeChunkedStream(
            tts=self, input_text=text, conn_options=conn_options, voice=self._voice
        )


class EdgeChunkedStream(lk_tts.ChunkedStream):
    """One synthesis request. `_run` is called by the SDK with an emitter."""

    def __init__(
        self,
        *,
        tts: EdgeTTS,
        input_text: str,
        conn_options: APIConnectOptions,
        voice: str,
    ) -> None:
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._voice = voice

    async def _run(self, output_emitter: lk_tts.AudioEmitter) -> None:
        output_emitter.initialize(
            request_id=lk_utils.shortuuid(),
            sample_rate=EDGE_TTS_SAMPLE_RATE,
            num_channels=1,
            # edge-tts streams MPEG frames; the emitter decodes from the mime type.
            mime_type="audio/mp3",
        )
        communicate = edge_tts.Communicate(self.input_text, self._voice)
        async for chunk in communicate.stream():
            # The stream yields WordBoundary metadata alongside audio — push only
            # the audio, or the emitter gets fed timing dicts it cannot decode.
            if chunk["type"] == "audio" and chunk.get("data"):
                output_emitter.push(chunk["data"])
        output_emitter.flush()


def _warn_if_unofficial_tts() -> None:
    """Say out loud, every time, that student audio is leaving via edge-tts.

    Called at worker startup AND from _build_tts, because they land in different
    logs: startup runs in the parent process, _build_tts inside each forked job.
    An operator tailing either one must see it.

    A WARNING and not a refusal: edge is a legitimate choice on a laptop with no
    Groq TTS access, and refusing to speak would break local development to
    protect nobody. What it must not be is quiet.
    """
    if VOICE_TTS != "edge":
        return
    log.warning(
        "VOICE_TTS=edge: every reply is being synthesised by an UNOFFICIAL "
        "Microsoft endpoint with no terms of service, no privacy undertaking and "
        "no SLA. Acceptable for development; NOT acceptable for a student "
        "cohort. Set VOICE_TTS=groq (same GROQ_API_KEY as STT and the LLM) "
        "before students use this."
    )


def _build_tts() -> lk_tts.TTS:
    """Pick the voice.

    Groq is the default and keeps the whole cascade on one key and one vendor.
    Edge is opt-in and warns (see _warn_if_unofficial_tts).

    An UNRECOGNISED value resolves to groq, not to edge. This used to be an
    `if groq / else edge` pair, so `VOICE_TTS=grok` -- or "Groq " from a
    copy-paste, before .strip().lower() -- quietly routed student-facing audio to
    the unofficial endpoint. A typo must fail toward the supported provider.
    """
    if VOICE_TTS == "edge":
        _warn_if_unofficial_tts()
        log.info("TTS: edge-tts (voice=%s)", EDGE_TTS_VOICE)
        return EdgeTTS()
    if VOICE_TTS not in ("", "groq"):
        log.warning("VOICE_TTS=%r is not a known provider - using groq", VOICE_TTS)
    log.info("TTS: groq %s (voice=%s)", GROQ_TTS_MODEL, GROQ_TTS_VOICE)
    return groq.TTS(model=GROQ_TTS_MODEL, voice=GROQ_TTS_VOICE)


async def _speak_greeting(session: AgentSession) -> bool:
    """Speak the compulsory opening greeting and CONFIRM it was actually heard.

    say() rather than generate_reply(): the phrase must come out verbatim every
    time, and an LLM asked to "greet with Jai Shri Gurudev" will eventually
    paraphrase, translate or skip it. allow_interruptions=False because the one
    required utterance is also the most exposed — the student has not settled
    and a cough in the first second would swallow it.

    The awaiting matters as much as the saying. A TTS failure inside the SDK's
    speech task is caught by its own @log_exceptions decorator and the handle
    still resolves, so a bare `await session.say(...)` returns cleanly having
    played NOTHING: the student hears silence, no transcript row is written, and
    the model has already been told it greeted so it never self-corrects. That
    is a compulsory requirement failing with no error anywhere. Here the handle
    is inspected afterwards and a miss is logged at ERROR with the reason.

    Returns True only when the greeting genuinely played."""
    try:
        handle = session.say(GREETING, allow_interruptions=False, add_to_chat_ctx=True)
        await handle.wait_for_playout()
    except Exception:  # noqa: BLE001 — a failed greeting must not kill the call
        log.exception("GREETING FAILED — the student heard no opening greeting")
        return False

    exc = handle.exception() if handle.done() else None
    if exc is not None:
        log.error("GREETING FAILED during playout: %r", exc)
        return False
    if handle.interrupted:
        # Should be unreachable with allow_interruptions=False; log rather than
        # assume, because a silent greeting is the failure being guarded here.
        log.error("GREETING was interrupted despite allow_interruptions=False")
        return False

    log.info("greeting spoken: %r", GREETING)
    return True


# Every one of these overrides a default that is wrong for this deployment.
# Pinned here rather than in a manifest so the values are versioned with the code
# that depends on them; the CLI's --drain-timeout default is None, so `start`
# does not clobber this.
server = AgentServer(
    # SDK default is 3600 — a full HOUR. On SIGTERM the worker would sit draining
    # for up to an hour, which means stop_grace_period would have to be an hour
    # too or the orchestrator SIGKILLs mid-drain and cuts off a live call anyway.
    # 15 minutes is a POLICY choice about the longest call worth waiting out. It
    # is deliberately NOT derived from TOKEN_TTL (voice.py, 10 min): that bounds
    # token validity at JOIN time, not how long a call may then run.
    drain_timeout=900,
    # Default 10.0. Must stay strictly ABOVE the 5s bound in the transcript
    # shutdown callback below, or the parent SIGKILLs the job process while the
    # last turns are still being written.
    shutdown_process_timeout=20.0,
    # Default in prod is 24 PREFORKED processes. Each one carries this module's
    # import set (livekit-agents + onnxruntime + Silero, ~2 GB resident), so on a
    # container sized for a college cohort the worker OOMs during startup —
    # before it has taken a single call. One idle process still gives a warm
    # fork for the next student.
    num_idle_processes=1,
    # Default 0 = no limit, so one runaway job takes the whole container down
    # with it. Measured against PSS/USS rather than RSS, so pages shared with the
    # forkserver are not double-counted.
    job_memory_limit_mb=1500,
)

# Silero is loaded ONCE per worker process, not per call. Loading it inside the
# session added model-load time to every student's first turn, and a worker
# handling concurrent calls paid it repeatedly for an identical read-only model.
_VAD = None


def _get_vad():
    """Process-wide VAD singleton, loaded lazily on the first session."""
    global _VAD
    if _VAD is None:
        log.info("loading silero VAD (once per worker process)")
        _VAD = silero.VAD.load()
    return _VAD


@server.rtc_session(agent_name="reep-voice")
async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    conversation_id = _resolve_conversation_id(ctx)
    log.info(
        "voice session for conversation_id=%s (room=%s)",
        conversation_id,
        getattr(ctx.room, "name", "?"),
    )

    # NOTE: the heartbeat is NOT started here — it runs for the lifetime of the
    # worker process (see _start_heartbeat_thread), because readiness has to be
    # true BEFORE a token is minted, i.e. before any session can exist.

    # NOTE on consent: a personal, record-aware session requires the
    # conversation's consent_state == 'voice' on the server. This worker defaults
    # to GENERAL guidance and does NOT pull the student's records into the prompt.
    # (When a record-aware prompt is added later, gate it on a server check of
    # consent_state before seeding any student data here.)
    instructions = BASE_INSTRUCTIONS

    # A CASCADE, not a native speech-to-speech model: silero decides when the
    # student has stopped talking, Whisper turns that audio into text, Llama
    # writes the reply, and the TTS speaks it. Gemini Live would collapse these
    # four into one model, but this project's Google account is denied access to
    # it (WebSocket 1008), and no provider offers native speech-to-speech on a
    # free tier. From the student's side the experience is the same — they talk,
    # a voice answers — with roughly a second more latency.
    # Transcript writes are tracked PER SESSION, not process-wide. A global set
    # made one student's hang-up wait on writes belonging to every other call in
    # flight on this worker — unbounded cross-session coupling that got worse
    # exactly when the worker was busiest.
    pending_writes: set[asyncio.Task[None]] = set()

    # Set once, if the server ever says this conversation is gone. Guards against
    # several in-flight writes each racing to shut the room down.
    conversation_gone = False

    def _end_call_conversation_gone() -> None:
        """The student cleared the conversation mid-call — stop the call.

        Carrying on would be worse than ending: the room and identity are pinned
        to a conversation that now refuses writes for the token's whole TTL, so
        the student would keep talking to an assistant whose every reply is
        discarded, with nothing on screen to say so. Deleting the room ends it
        for the browser too, which surfaces as a normal end-of-call.
        """
        nonlocal conversation_gone
        if conversation_gone:
            return
        conversation_gone = True
        # _spawn, not create_task: a bare task here is held only weakly and
        # can be collected before the room actually disconnects, and a
        # disconnect that RAISES would be swallowed entirely -- either way the
        # room stays up and the student keeps talking into a call whose every
        # word is discarded, which is the exact outcome this function exists
        # to prevent.
        _spawn(ctx.room.disconnect(), what="disconnect after cleared conversation")

    async def _end_call_at_max_duration() -> None:
        """Hang up once the call has run for VOICE_MAX_CALL_SECONDS.

        The LiveKit token cannot do this. Its 10-minute TTL (TOKEN_TTL in
        app/routers/voice.py) bounds how long the JWT may be used to JOIN; the
        room checks it once and never again, so a tab left open holds this
        process and a billed STT+LLM+TTS cascade indefinitely. The API cannot do
        it either -- it never hears that a call started, let alone that it is
        still running. Only this process knows, so this is where the ceiling
        lives.

        Disconnecting rather than announcing first, to match
        _end_call_conversation_gone: the browser surfaces a room disconnect as a
        normal end of call, and a farewell utterance would mean an extra TTS
        round-trip on the path we are trying to stop paying for -- one that can
        itself hang, leaving the cap unenforced.
        """
        await asyncio.sleep(VOICE_MAX_CALL_SECONDS)
        log.warning(
            "call for conversation_id=%s hit the %ds duration cap - disconnecting",
            conversation_id,
            VOICE_MAX_CALL_SECONDS,
        )
        await ctx.room.disconnect()

    # Armed at room join, not at first audio: the cost being capped is the room
    # and this process, both of which exist from here.
    call_deadline = _spawn(_end_call_at_max_duration(), what="call duration cap")

    session = AgentSession(
        vad=_get_vad(),
        stt=groq.STT(model=GROQ_STT_MODEL),
        # Cap the reply length. A long answer is bad twice over in voice: the
        # student waits through synthesis they did not ask for, and the emitter
        # is more likely to starve part-way and stutter. The prompt asks for
        # brevity; this enforces it even when the model gets carried away.
        llm=groq.LLM(model=GROQ_LLM_MODEL, temperature=0.6, max_completion_tokens=220),
        tts=_build_tts(),
        # Endpointing must outwait the STT round-trip. Whisper here is a NETWORK
        # call to Groq, not a local model, so the default min_delay of 0.5s
        # commits the turn before the transcript comes back — the SDK then logs
        # "transcript arrives after turn has been committed" and DISCARDS it.
        # The user's words vanish, no LLM call is made, and the agent answers
        # with silence: a total failure that looks like a dead microphone.
        # 1.5s comfortably covers the round-trip at the cost of a slightly
        # longer pause before the reply.
        turn_handling={
            "endpointing": {"min_delay": 1.5, "max_delay": 6.0},
            # Why the agent kept breaking off mid-sentence: any detected speech
            # counted as the student barging in, and on laptop speakers the
            # loudest thing the microphone hears IS the agent. It interrupted
            # itself. Coughs, chair scrapes and lab chatter did the same.
            #
            # Per LiveKit's guidance for noisy lines / echo:
            #   min_words           require real transcribed WORDS, not just a
            #                       sound — the single most effective filter
            #   min_duration        ignore short bursts
            #   resume_false_...    if the "interruption" produced no words,
            #                       pick the sentence back up instead of
            #                       abandoning the answer half-spoken
            # mode MUST be "vad" here, not "adaptive". Adaptive interruption
            # gatekeeps by holding and flushing STREAMING transcripts, so the
            # SDK requires stt.capabilities.streaming AND aligned_transcript —
            # Groq Whisper is a batch HTTP call and has neither. Asking for
            # adaptive logs "interruption_detection ... will be disabled" and
            # silently drops the whole detector, which is how the first version
            # of this fix shipped inert.
            #
            # min_words is likewise STT-gated and cannot work without streaming
            # transcripts, so it is omitted rather than left in as decoration.
            # What actually protects against the agent cutting itself off here:
            # min_duration, resume_false_interruption, server-side BVC noise
            # cancellation, and browser echo cancellation.
            "interruption": {
                "mode": "vad",
                "min_duration": 0.8,
                "resume_false_interruption": True,
                "false_interruption_timeout": 2.0,
                # MUST be False here. LiveKit recommends True to stop buffered
                # noise replaying at the agent, but the opening greeting is
                # deliberately uninterruptible — so True silently DISCARDS
                # everything the student says over it. Observed: a full spoken
                # question arrived as "at Foundations." because the first three
                # seconds were dropped under the greeting. Buffering instead
                # costs a little stale audio; discarding costs the student's
                # opening words and makes them repeat themselves.
                "discard_audio_if_uninterruptible": False,
            },
        },
    )

    # An assistant ChatMessage is added to the context as soon as generation
    # STARTS and is then filled in as the LLM streams, so reading text_content
    # inside the event handler captures a half-written sentence — transcripts
    # came out as "Jai Shri Gurudev. How can I assist". The item object is
    # mutated in place, so the fix is to hold the reference and read it once the
    # agent has stopped speaking. User turns need no such wait: their text comes
    # from a committed STT transcript and is complete when the event fires.
    pending_assistant: dict[str, Any] = {"item": None}

    def _flush_assistant() -> None:
        item = pending_assistant.get("item")
        if item is None:
            return
        pending_assistant["item"] = None
        turn = _extract_turn(item)  # re-read AFTER streaming finished
        if turn is None:
            return
        task = asyncio.create_task(
            _persist_turn(
                conversation_id, turn.role, turn.text, turn.turn_id,
                on_conversation_gone=_end_call_conversation_gone,
            )
        )
        pending_writes.add(task)
        task.add_done_callback(pending_writes.discard)

    async def _drain_transcripts(reason: str = "") -> None:
        """Wait for in-flight transcript POSTs at the REAL end of the call.

        This MUST be a shutdown callback, not a `finally:` after session.start().
        `AgentSession.start()` only sets the session up and returns — it awaits
        its RunResult solely when called with `capture_run=True`, which this is
        not — so a `finally:` there ran about two seconds into the call, right
        after the greeting. Every turn the student actually had was written by a
        fire-and-forget task created LATER, awaited by nothing and absent from
        `ctx._pending_tasks`; when the job process was torn down those writes
        died silently. The conversation looked fine on screen during the call and
        was missing its turns afterwards, with no error logged anywhere.

        Shutdown callbacks run after session.aclose() and room.disconnect(),
        which is genuinely end-of-call.

        Bounded at 5s, strictly under the AgentServer's shutdown_process_timeout
        (20.0): the parent waits only that long after sending ShuttingDown before
        SIGKILL, so an unbounded wait here would just be killed mid-write.
        """
        # The call is already over, so the duration cap has nothing left to
        # enforce. Left running it would sit on its sleep for the rest of the
        # window holding a reference to a dead room, then disconnect it again.
        call_deadline.cancel()
        # A call that ends while the agent is still mid-utterance never emits the
        # state change, so flush whatever is held rather than dropping the last
        # thing the agent said.
        _flush_assistant()
        if not pending_writes:
            return
        pending = set(pending_writes)
        log.info("draining %d transcript write(s) before exit (%s)", len(pending), reason)
        _done, timed_out = await asyncio.wait(pending, timeout=5)
        if timed_out:
            log.warning("%d transcript write(s) did not finish", len(timed_out))

    ctx.add_shutdown_callback(_drain_transcripts)

    @session.on("agent_state_changed")
    def _on_state(ev: Any) -> None:
        # Leaving "speaking" means the utterance is complete and its text is
        # final. Flush the held assistant item now.
        if getattr(ev, "old_state", None) == "speaking":
            _flush_assistant()

    @session.on("conversation_item_added")
    def _on_item(ev: Any) -> None:
        item = getattr(ev, "item", ev)
        # LENGTH AND ID, NEVER THE WORDS. This line used to log the first 60
        # characters of every spoken turn, which made the worker log a second,
        # parallel transcript that no retention control can reach: "Clear
        # conversation" soft-deletes rows in Postgres, retention.purge scrubs
        # rows in Postgres, and a log file is neither. A student who used the one
        # erasure control the product offers still left their words here, in
        # whatever aggregator this log ships to, indefinitely.
        #
        # What is kept is what the log was actually useful for -- did a turn
        # arrive, was it the role expected, and does its id match the row that
        # did or did not get persisted. VOICE_LOG_TRANSCRIPTS re-enables the text
        # for someone debugging a specific transcription fault, as a deliberate
        # act with the consequence written next to the flag.
        text = getattr(item, "text_content", None) or ""
        log.info(
            "conversation_item_added: role=%s chars=%d id=%s",
            getattr(item, "role", None),
            len(text),
            getattr(item, "id", None),
        )
        if VOICE_LOG_TRANSCRIPTS and text:
            log.info("conversation_item_added TEXT (VOICE_LOG_TRANSCRIPTS): %r", text)
        if getattr(item, "role", None) == "assistant":
            # Hold it; a previous one still pending means that utterance ended
            # without a state change, so flush it first rather than lose it.
            _flush_assistant()
            pending_assistant["item"] = item
            return

        turn = _extract_turn(ev)
        if turn is None or not turn.is_final:
            return  # interim / non-text items are dropped; server never sees them
        # Fire-and-forget: persistence must never block or crash the call. The
        # server dedups on (conversation_id, provider_turn_id).
        #
        # Keep a strong reference until the task completes. asyncio only holds a
        # WEAK reference to a running task, so a bare create_task() can be
        # garbage-collected mid-flight — the turn would vanish with no error, and
        # transcripts would go missing under exactly the load that makes it hard
        # to notice.
        task = asyncio.create_task(
            _persist_turn(
                conversation_id, turn.role, turn.text, turn.turn_id,
                on_conversation_gone=_end_call_conversation_gone,
            )
        )
        pending_writes.add(task)
        task.add_done_callback(pending_writes.discard)

    agent = Agent(instructions=instructions)

    # Deliberately NOT wrapped in try/finally. Both awaits below return within a
    # couple of seconds — start() sets the session up and hands back, the
    # greeting plays — so a `finally:` here would fire while the student is still
    # saying hello. End-of-call work belongs in _drain_transcripts above, which
    # is registered as a shutdown callback.
    await session.start(
        agent=agent,
        room=ctx.room,
        # Server-side background voice cancellation. Students use this on
        # laptop speakers in a shared lab, so the microphone picks up the
        # agent's own reply plus everyone else's conversation — both of
        # which otherwise read as the student speaking and cut the agent
        # off. This runs on LiveKit's side and also cleans the audio
        # Whisper transcribes, so it improves accuracy as well as turn-taking.
        room_options=RoomOptions(
            audio_input=AudioInputOptions(
                noise_cancellation=noise_cancellation.BVC(),
            ),
        ),
    )

    # No "you already greeted" instruction is needed, and deliberately so.
    # say(add_to_chat_ctx=True) appends the greeting to the chat context ONLY
    # when the speech actually produced text, so the context is a truthful
    # record either way: greeting played -> the model sees it and will not
    # repeat it; greeting failed -> the model sees no greeting and opens with
    # one naturally. Asserting it in the prompt instead would lie to the
    # model exactly when the greeting was missed, which is the one case that
    # needs recovering.
    await _speak_greeting(session)


if __name__ == "__main__":
    # Start beating BEFORE run_app takes the main thread: /api/voice/status must
    # report worker_healthy while the worker is idle, or no token is ever minted
    # and no session can start.
    _warn_if_unofficial_tts()
    _start_heartbeat_thread(server)
    log.info("heartbeat started (worker_id=%s -> %s)", WORKER_ID, API_BASE)
    agents.cli.run_app(server)
