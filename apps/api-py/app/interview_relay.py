"""The OpenAI Realtime relay behind the REEP mock interviewer.

    browser  <--WS /api/interview-->  THIS PROCESS  <--WS-->  api.openai.com

The browser never talks to OpenAI. OPENAI_API_KEY is attached to exactly one
socket -- the outbound `Authorization: Bearer` header opened in
`_upstream_connector` -- and is never serialised downstream, never echoed inside
an error the browser can see, and never logged. That containment is the entire
reason this relay exists; a browser-side ephemeral token would put a spendable
credential on a student's laptop. app/main.py pins the `websockets` logger to
INFO so a DEBUG log level cannot print that header into the API log.

RULE 1 (AGENTS.md). api.openai.com is a REMOTE provider, so NO student record
enters this session: no marks, attendance, CGPA, USN or resume text. The ONLY
thing this module authors upstream is `_INTERVIEWER_PERSONA`, which is a fixed
string with no student data in it and which tells the model plainly that it
cannot see the dashboard. Everything else on the uplink is the student's own
microphone. Nothing here imports app.assistant_tools, app.knowledge or any ORM
model, and that is the point. If the interview is ever personalised (branch,
CGPA, target company), that path must go through
complete_chat(..., carries_student_data=True) in app/ai/llm.py and degrade to
this generic persona when the gate refuses -- the same shape as
/student/resume/generate falling back to used_ai=false.

This module is the ENGINE only: one class per interview, plus the concurrency
cap and the close helper. Authentication, the STUDENT check, the conversation
and the database live in app/routers/interview.py, which is the only caller.

Wire format, both directions, deliberately asymmetric between audio and control:

    browser -> relay : BINARY frames  = raw PCM16 LE mono 24 kHz
                       TEXT frames    = JSON control ({"type": "reep.end"}, ...)
    relay -> browser : BINARY frames  = raw PCM16 LE mono 24 kHz (decoded)
                       TEXT frames    = JSON control

Audio crosses the browser link as raw bytes rather than base64-in-JSON, which
removes one encode and one decode per frame per direction. WebSocket preserves
ordering across binary and text frames on a single connection, so a control
event ("the student started speaking") cannot overtake the audio it refers to.

Ported from apps/interview-realtime/app/server.py (2026-08), which was a
standalone process with no REEP authentication and is now superseded; see the
header on that file.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import time
from binascii import Error as BinasciiError
from collections.abc import Callable
from typing import Any, Final, TypeVar

from fastapi import WebSocket, WebSocketDisconnect

# Via fastapi, not `from starlette.websockets import ...` directly: starlette is
# a TRANSITIVE dependency here and requirements.txt pins fastapi rather than
# starlette (the same convention as the rest of apps/api-py). Importing it
# directly meant this module depended on a package whose version nothing in this
# repo fixes, under fastapi's own floor of `starlette>=0.46.0`. Identical object.
from fastapi.websockets import WebSocketState
from websockets.asyncio.client import ClientConnection, connect as ws_connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

from .config import settings

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Persona
# ---------------------------------------------------------------------------

# VERBATIM -- the wording is the product spec, not a suggestion. Editing it
# changes what every student is assessed against.
#
# It is also, deliberately, the ONLY thing sent upstream that this app authors.
# AGENTS.md rule 1 gates student PII leaving the machine, and api.openai.com is
# emphatically not loopback. A fixed persona carries no marks, USN or attendance,
# so the relay sits outside that gate today. The moment anyone personalises these
# instructions (branch, CGPA, target company) or feeds a resume into the session,
# the path must be routed through student_data_egress_allowed() in
# apps/api-py/app/ai/llm.py and degrade to this generic persona when it refuses --
# the same shape as /student/resume/generate falling back to used_ai=false.
_INTERVIEWER_PERSONA: Final[str] = (
    "You are a strict yet constructive AI Mock Interviewer. Your goal is to "
    "prepare students for corporate and technical job placements. Ask one clear "
    "question at a time. Do not interrupt the student while they are speaking. "
    "After they finish answering, provide a 1-sentence micro-feedback critique "
    "focusing on their structure (STAR method), pacing, or vocabulary, then "
    "seamlessly transition to the next logical interview question.\n"
    "\n"
    # AGENTS.md rule 1, stated to the model as well as enforced by construction.
    # Nothing in this process puts a student record into this prompt, so there is
    # nothing personal here to leak -- but a model that is not TOLD it is blind
    # will cheerfully invent a CGPA and say it out loud, and the student has no
    # way to know it was fiction. Same disclosure voice_agent.py's
    # BASE_INSTRUCTIONS makes for the LiveKit worker, and it is the marker the
    # next editor meets before adding a "personalise the interview" field.
    "You cannot see this student's marks, attendance, CGPA, USN, resume or any "
    "other record from their REEP dashboard - none of that is available to you, "
    "by design. If they ask what their own figures are, say plainly that you "
    "cannot see them and ask the student to tell you, then carry on with the "
    "interview. Never guess, estimate or invent a figure about them."
)


# ---------------------------------------------------------------------------
# Upstream event vocabulary
# ---------------------------------------------------------------------------
# Two generations of the Realtime API are live and they use DIFFERENT names for
# the audio events: the beta surface emits response.audio.delta, the GA surface
# (gpt-realtime) emits response.output_audio.delta. The payloads are identical.
# Matching a set instead of a string means a model or API-date change upstream
# cannot silently mute the interviewer -- the failure mode being avoided is a
# session that connects, transcribes, bills, and plays no sound.

_AUDIO_DELTA_TYPES: Final[frozenset[str]] = frozenset(
    {"response.audio.delta", "response.output_audio.delta"}
)
_AUDIO_DONE_TYPES: Final[frozenset[str]] = frozenset(
    {"response.audio.done", "response.output_audio.done"}
)
_TRANSCRIPT_DELTA_TYPES: Final[frozenset[str]] = frozenset(
    {"response.audio_transcript.delta", "response.output_audio_transcript.delta"}
)

# The student's own transcript, returned so the UI can show what was heard.
_USER_TRANSCRIPT_DONE: Final[str] = (
    "conversation.item.input_audio_transcription.completed"
)

# Every upstream event this relay acts on. Anything outside this set is logged
# once per type per connection and dropped -- an allowlist, never a blind
# forward, so a new upstream event cannot start leaking unreviewed fields (or
# model-authored text) into the browser.
_HANDLED_UPSTREAM: Final[frozenset[str]] = (
    _AUDIO_DELTA_TYPES
    | _AUDIO_DONE_TYPES
    | _TRANSCRIPT_DELTA_TYPES
    | frozenset(
        {
            "error",
            "input_audio_buffer.speech_started",
            "input_audio_buffer.speech_stopped",
            "rate_limits.updated",
            "response.created",
            "response.done",
            _USER_TRANSCRIPT_DONE,
        }
    )
)

# Control events accepted FROM the browser. `reep.end` is the student pressing
# "End Interview"; `input_audio_buffer.clear` is the client telling us the mic
# went away (muted, tab hidden) so a half-utterance cannot be committed by VAD
# minutes later. Nothing else from the browser reaches the upstream socket.
_CLIENT_END: Final[str] = "reep.end"
_CLIENT_CLEAR: Final[str] = "input_audio_buffer.clear"

# The browser client's OTHER uplink mode (public/app.js `?uplink=base64`), which
# frames each 40 ms chunk as this JSON text event instead of a binary frame.
# Dropping it as "unsupported" presented as a working microphone with a live
# level meter that the model never heard, followed by an idle-cap close two
# minutes later -- the exact silent failure this relay is built to avoid.
_CLIENT_APPEND: Final[str] = "input_audio_buffer.append"


# ---------------------------------------------------------------------------
# Audio framing
# ---------------------------------------------------------------------------

# Raw linear PCM, signed 16-bit little-endian, mono. Both directions, no RIFF
# header. 24000 * 1 * 2 = 48000 bytes/s; base64 inflates the OpenAI-facing legs
# to ~64000 bytes/s.
_AUDIO_SAMPLE_RATE_HZ: Final[int] = 24_000
_AUDIO_FORMAT_NAME: Final[str] = "pcm16le_mono"

# Advertised to the browser in `reep.ready` rather than hard-coded there. 40 ms
# is the knee: 20 ms doubles the event rate for inaudible latency gain, while
# 100 ms adds a perceptible delay to barge-in because server VAD cannot see audio
# that has not been sent yet.
_CLIENT_CHUNK_MS_HINT: Final[int] = 40

# The append frame is assembled by string concatenation instead of json.dumps.
# Base64's alphabet (A-Z a-z 0-9 + / =) contains no character that JSON escapes,
# so the dumps() scan of every payload byte is provably redundant -- and at ~25
# frames/s/session it is the single largest avoidable CPU cost in the relay.
_APPEND_PREFIX: Final[str] = '{"type":"input_audio_buffer.append","audio":"'
_APPEND_SUFFIX: Final[str] = '"}'

# Base64's own alphabet, plus padding. This is NOT a sanity check. The append
# frame above is assembled by CONCATENATION, and on the pass-through uplink the
# payload is a string the BROWSER chose. A quote or a backslash in it closes the
# JSON string early and lets the caller write its own keys into the event -- and
# a second "type" key is last-key-wins, so a student's audio frame becomes a
# `session.update` that replaces the interviewer persona on a remote provider,
# billed to this deployment's credential. Validated rather than json.dumps'd so
# the hot path stays a concatenation; b64decode(validate=True) would also reject
# it, but at the cost of the decode this uplink mode exists to avoid.
_B64_ALPHABET: Final[frozenset[str]] = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
)


# ---------------------------------------------------------------------------
# Upstream socket tunables
# ---------------------------------------------------------------------------

# A single Realtime event can carry a large base64 audio payload; the library
# default (1 MiB) would drop the connection with 1009 mid-sentence. 16 MiB sits
# above the documented per-event ceiling with headroom.
_UPSTREAM_MAX_FRAME_BYTES: Final[int] = 16 * 1024 * 1024

# Largest client audio frame accepted, ~0.5 s of PCM16 @ 24 kHz. The browser
# sends 1920 bytes every 40 ms, so anything near this ceiling is a broken or
# hostile client, not a slow one. Without a cap the only bound is uvicorn's
# ws_max_size default of 16 MiB, and one such frame costs ~37 MiB of transient
# allocation here (the frame, its base64 expansion, and the concatenation) on a
# worker carrying up to max_concurrent_sessions students.
_MAX_CLIENT_FRAME_BYTES: Final[int] = 24_000

# The same ceiling expressed in base64's alphabet, so both uplink modes are
# bounded by one number. Base64 inflates by 4/3, rounded up to a padded quantum.
_MAX_CLIENT_APPEND_B64_CHARS: Final[int] = ((_MAX_CLIENT_FRAME_BYTES + 2) // 3) * 4

# Bounded receive queue = the backpressure boundary. When the browser is slow we
# stop draining this queue, the TCP window closes toward OpenAI, and memory stays
# flat. An unbounded queue turns one stalled student into an OOM.
_UPSTREAM_MAX_QUEUE: Final[int] = 32

# A handshake that has not completed in 10s is a dead network path, not a slow
# one; failing fast lets the student retry instead of watching a spinner.
_UPSTREAM_OPEN_TIMEOUT_S: Final[float] = 10.0

# Closing-handshake grace. Short on purpose: at teardown the session is already
# over, and a lingering half-closed socket costs a file descriptor per student.
_UPSTREAM_CLOSE_TIMEOUT_S: Final[float] = 5.0

# Keepalive. Without it a silent mid-interview death shows up only as audio that
# stops, with no exception raised until the OS TCP timeout -- minutes later.
_UPSTREAM_PING_INTERVAL_S: Final[float] = 20.0
_UPSTREAM_PING_TIMEOUT_S: Final[float] = 20.0

# Ceiling on the whole scripted startup sequence (session.created -> update ->
# updated -> response.create). Generous relative to a working handshake (~1 s)
# and far below the idle cap, so a wedged upstream surfaces as "unavailable"
# rather than as a student staring at a connected socket that never speaks.
_HANDSHAKE_TIMEOUT_S: Final[float] = 20.0


# ---------------------------------------------------------------------------
# Guardrail tunables
# ---------------------------------------------------------------------------

# Watchdog granularity. Coarse ON PURPOSE: re-arming an asyncio timer on every
# audio frame would be ~25 timer operations/s/session -- 25000/s at the fleet
# target -- to enforce a 120 s threshold. The watchdog compares monotonic
# timestamps instead, so the hot path is a single attribute assignment.
_WATCHDOG_INTERVAL_S: Final[float] = 5.0

# RFC 6455 caps the close-frame reason at 123 BYTES. Exceeding it is a protocol
# error, not a truncation: the peer then reports 1006 "abnormal closure" with no
# reason at all, which is the exact opposite of the intent.
_MAX_CLOSE_REASON_BYTES: Final[int] = 123

# How long app shutdown waits for live interviews to close their sockets after
# being asked to stop. Long enough for two close handshakes (browser and
# upstream), short enough that a deploy is not held hostage by one wedged socket.
_SHUTDOWN_DRAIN_S: Final[float] = 10.0

# How long teardown waits for in-flight turn writes to reach Postgres. Two
# seconds is far above a healthy write (~2 ms) and far below any timeout the
# student would notice, because by this point the interview is already over
# and this only delays the close frame.
_TURN_WRITE_DRAIN_S: Final[float] = 2.0

# Close codes. 4000-4999 is the private-use range reserved for applications.
_CLOSE_OK: Final[int] = 1000  # Interview complete
_CLOSE_GOING_AWAY: Final[int] = 1001  # Server shutting down
_CLOSE_INTERNAL: Final[int] = 1011  # Unexpected error on our side
_CLOSE_OVERLOADED: Final[int] = 1013  # Per-worker concurrency cap hit
_CLOSE_NOT_CONFIGURED: Final[int] = 4001  # No API key / upstream 401
_CLOSE_UPSTREAM_UNAVAILABLE: Final[int] = 4002  # Upstream 403/429/5xx/handshake
_CLOSE_FORBIDDEN_ORIGIN: Final[int] = 4003  # Origin not in WEB_ORIGIN
_CLOSE_IDLE: Final[int] = 4008  # No inbound audio
_CLOSE_SESSION_CAP: Final[int] = 4009  # Hard wall-clock cap


_E = TypeVar("_E", bound=BaseException)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def _close_reason(text: str) -> str:
    """Clip a close reason to the RFC 6455 limit on a UTF-8 character boundary."""
    raw = text.encode("utf-8")
    if len(raw) <= _MAX_CLOSE_REASON_BYTES:
        return text
    return raw[:_MAX_CLOSE_REASON_BYTES].decode("utf-8", errors="ignore")


def _humanize_seconds(seconds: int) -> str:
    """"2 minutes" / "90 seconds" -- these strings are read by students."""
    if seconds >= 60 and seconds % 60 == 0:
        minutes = seconds // 60
        return f"{minutes} minute" if minutes == 1 else f"{minutes} minutes"
    return f"{seconds} second" if seconds == 1 else f"{seconds} seconds"


def _first_leaf(group: BaseExceptionGroup[Any], kind: type[_E]) -> _E | None:
    """First leaf exception of `kind` in a possibly NESTED exception group.

    TaskGroup nests groups when a child is itself a TaskGroup, so `eg.exceptions[0]`
    is not reliably the exception you matched on -- it can be another group.
    """
    for exc in group.exceptions:
        if isinstance(exc, BaseExceptionGroup):
            found = _first_leaf(exc, kind)
            if found is not None:
                return found
        elif isinstance(exc, kind):
            return exc
    return None


def _echoed_turn_detection(session: dict[str, Any]) -> tuple[bool, Any]:
    """Read turn_detection out of an echoed session object, either generation.

    Returns (present, value). Beta keeps it flat on the session; GA nests it at
    session.audio.input.turn_detection. "Absent" and "explicitly null" are
    different answers: null means VAD is OFF and no turn will ever end, while
    absent only means this surface did not echo the field back.
    """
    if "turn_detection" in session:
        return True, session["turn_detection"]
    audio = session.get("audio")
    if isinstance(audio, dict):
        inbound = audio.get("input")
        if isinstance(inbound, dict) and "turn_detection" in inbound:
            return True, inbound["turn_detection"]
    return False, None


class _SessionEnded(Exception):
    """A deliberate end of the interview, carrying the code both sockets close with.

    Raised by the watchdog or by a client `reep.end`. Raising (rather than
    setting a flag) is what makes the TaskGroup cancel the sibling pumps.
    """

    __slots__ = ("code", "reason")

    def __init__(self, code: int, reason: str) -> None:
        super().__init__(f"{code} {reason}")
        self.code = code
        self.reason = reason


class _ConnLog(logging.LoggerAdapter):
    """Binds the connection id (and the upstream session id, once known) to every line.

    The ids also land on the LogRecord as attributes, so a JSON formatter picks
    them up as fields rather than having to re-parse the message.
    """

    def process(self, msg: Any, kwargs: Any) -> tuple[str, Any]:
        extra = self.extra or {}
        session_id = extra.get("session_id") or "-"
        # logging.LoggerAdapter.process is the ONLY hook that copies `extra` onto
        # the LogRecord. Overriding it without re-setting this key left every
        # record with no conn_id/session_id attribute at all, so the JSON
        # formatter this docstring promises to serve got nothing and the ids were
        # recoverable only by regex over the message. A caller-supplied `extra`
        # wins, so a per-call field is never clobbered by the binding.
        kwargs["extra"] = {**extra, **(kwargs.get("extra") or {})}
        return f"[conn={extra.get('conn_id')} session={session_id}] {msg}", kwargs


class _ConnectionLimiter:
    """Per-worker cap on concurrent interviews, acquired without ever blocking.

    A student who cannot start must be TOLD so (close 1013) rather than queued:
    queueing shows a spinner while their slot is not running, and the 15-minute
    cap they are waiting for has not started either.

    asyncio.Semaphore has no acquire_nowait(), so the test and the decrement are
    written out. There is no await between them and asyncio is single-threaded,
    which makes the pair atomic by construction -- no lock is needed or useful.
    """

    __slots__ = ("_limit", "_active")

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._active = 0

    def try_acquire(self) -> bool:
        if self._active >= self._limit:
            return False
        self._active += 1
        return True

    def release(self) -> None:
        # Guard against a double release turning the counter negative, which
        # would quietly raise the effective cap above the configured one.
        if self._active > 0:
            self._active -= 1

    @property
    def active(self) -> int:
        return self._active

    @property
    def limit(self) -> int:
        return self._limit


def _upstream_connector(url: str, api_key: str, beta_header: str) -> Any:
    """Build the upstream connector.

    Deliberately NOT a coroutine: the returned object is an async context
    manager, so `async with` closes the socket on every exit path including
    cancellation. Awaiting a bare connect() and closing by hand leaks a socket
    on the paths nobody tests.
    """
    headers: dict[str, str] = {"Authorization": f"Bearer {api_key}"}
    if beta_header:
        # Non-empty pins the BETA event surface (the value is "realtime=v1").
        headers["OpenAI-Beta"] = beta_header
    return ws_connect(
        url,
        # websockets >= 14 renamed this from `extra_headers`. The pin in
        # requirements.txt (websockets==15.0.1) and this keyword move together;
        # on 15.x the old name raises TypeError at CONNECT time, not import
        # time, so a mismatch survives CI and fails on the first real call.
        additional_headers=headers,
        max_size=_UPSTREAM_MAX_FRAME_BYTES,
        max_queue=_UPSTREAM_MAX_QUEUE,
        open_timeout=_UPSTREAM_OPEN_TIMEOUT_S,
        close_timeout=_UPSTREAM_CLOSE_TIMEOUT_S,
        ping_interval=_UPSTREAM_PING_INTERVAL_S,
        ping_timeout=_UPSTREAM_PING_TIMEOUT_S,
        # permessage-deflate on a 48 kB/s stream of base64-encoded near-noise
        # burns CPU on data that does not compress. At the fleet target that
        # compression is the first thing to saturate a core.
        compression=None,
    )


# ---------------------------------------------------------------------------
# The relay session
# ---------------------------------------------------------------------------


class _RelaySession:
    """One student's interview. All mutable state lives here and dies with the socket.

    Nothing about a session is stored at module level, so nothing is keyed by
    student, room or id -- which is what lets this process be replicated behind a
    load balancer without a shared session registry.
    """

    __slots__ = (
        "_ws",
        "_conn_id",
        "_log",
        "_upstream",
        "_session_id",
        "_active_response_id",
        "_event_seq",
        "_logged_unknown",
        "_pcm_carry",
        "_last_audio_at",
        "_started_at",
        "_stop_requested",
        "_stop_outcome",
        "_client_frames",
        "_client_bytes",
        "_on_turn",
        "_writes",
        "_assistant_text",
    )

    def __init__(
        self,
        websocket: WebSocket,
        conn_id: str,
        on_turn: Callable[[str, str, str], None] | None = None,
    ) -> None:
        self._ws = websocket
        self._conn_id = conn_id
        # Called (sender, text, provider_turn_id) once per FINAL turn, to persist
        # it. SYNCHRONOUS and allowed to block: this class runs it on a worker
        # thread via asyncio.to_thread, because app/conversations.py is
        # synchronous SQLAlchemy and calling it inline would stall the event loop
        # -- i.e. every other student's audio on this worker -- for a whole round
        # trip to Postgres. It is never awaited by the interview and its failures
        # never reach the pumps; see _emit_turn.
        self._on_turn = on_turn
        self._writes: set[asyncio.Task[None]] = set()
        # Assistant transcript deltas accumulated per response id, so a finished
        # turn is stored as ONE row at response.done. Popped there, so this
        # cannot grow with the length of the interview.
        self._assistant_text: dict[str, str] = {}
        self._log = _ConnLog(log, {"conn_id": conn_id, "session_id": None})
        self._upstream: ClientConnection | None = None
        self._session_id: str | None = None

        # Set from response.created, cleared at response.done or at barge-in.
        # Doubles as the drop-filter for late deltas: audio belonging to a
        # response we cancelled must never reach a browser that already flushed it.
        self._active_response_id: str | None = None

        self._event_seq = 0
        self._logged_unknown: set[str] = set()

        # At most ONE byte: a client frame with an odd length would split a PCM16
        # sample across the boundary and click. Carrying the stray byte into the
        # next frame is bounded storage, unlike buffering whole frames.
        self._pcm_carry = b""

        now = time.monotonic()
        self._started_at = now
        # Seeded at start, so a student who never speaks at all is caught by the
        # idle cap rather than only by the 15-minute one.
        self._last_audio_at = now

        self._stop_requested = asyncio.Event()
        self._stop_outcome: tuple[int, str] = (_CLOSE_OK, "Interview complete")

        self._client_frames = 0
        self._client_bytes = 0

    # -- external control ---------------------------------------------------

    def request_stop(self, code: int, reason: str) -> None:
        """Ask this session to end. Safe from another task; never blocks.

        Used by app shutdown so interviews close with a real code and reason
        instead of being torn down by task cancellation, which would reach the
        browser as a bare 1006.
        """
        if not self._stop_requested.is_set():
            self._stop_outcome = (code, reason)
            self._stop_requested.set()

    # -- ids and logging ----------------------------------------------------

    def _next_event_id(self, tag: str) -> str:
        """Client event ids are echoed back in error.event_id.

        That echo is the ONLY way to attribute a rejection to the event that
        caused it, which is why every control event carries one -- and why
        input_audio_buffer.append does not: appends flow at ~25/s, are almost
        never the thing that errors, and are not worth the bytes or the counter.
        """
        self._event_seq += 1
        return f"reep-{self._conn_id}-{self._event_seq}-{tag}"

    def _log_upstream_error(self, event: dict[str, Any], phase: str) -> None:
        """Log every field of an upstream `error` event.

        An `error` does NOT close the session -- the socket stays open and the
        interview continues -- so this is frequently the only trace that
        anything went wrong.
        """
        err = event.get("error") or {}
        self._log.error(
            "OpenAI Realtime error during %s: type=%s code=%s param=%s "
            "caused_by_event=%s: %s",
            phase,
            err.get("type"),
            err.get("code"),
            err.get("param"),
            err.get("event_id"),
            err.get("message"),
        )

    # -- downstream sends ---------------------------------------------------
    #
    # INVARIANT: exactly one task ever sends downstream. The upstream pump owns
    # every downstream write; the client pump only reads, and the watchdog only
    # raises. Starlette's WebSocket.send is not documented as safe under
    # concurrent tasks, and this invariant is why it does not need to be.

    async def _send_control(self, payload: dict[str, Any]) -> None:
        try:
            await self._ws.send_json(payload)
        except (RuntimeError, ConnectionError, OSError) as exc:
            # The browser vanished between the last receive and this send.
            # Translate to the same exception the client pump raises so both
            # pumps agree on the cause and teardown reports "client disconnected"
            # rather than an internal error.
            raise WebSocketDisconnect(code=1006, reason="Browser socket closed") from exc

    async def _send_audio(self, pcm: bytes) -> None:
        try:
            await self._ws.send_bytes(pcm)
        except (RuntimeError, ConnectionError, OSError) as exc:
            raise WebSocketDisconnect(code=1006, reason="Browser socket closed") from exc

    # -- startup sequence ---------------------------------------------------

    def _session_update_payload(self) -> dict[str, Any]:
        """The single session.update, in whichever shape this API generation wants.

        Sent once and never repeated: `voice` is frozen the moment the model has
        emitted any audio, so a later change is simply rejected.
        """
        turn_detection: dict[str, Any] = {
            "type": "server_vad",
            # Activation energy, 0.0-1.0.
            "threshold": settings.interview_vad_threshold,
            # Audio kept from BEFORE speech onset, so the first phoneme survives.
            "prefix_padding_ms": settings.interview_vad_prefix_padding_ms,
            # Silence that ends a turn. Above the API default on purpose: the
            # persona promises not to interrupt, and real answers contain
            # 400-600 ms thinking pauses mid-sentence.
            "silence_duration_ms": settings.interview_vad_silence_duration_ms,
            # The server commits the buffer AND creates the response itself.
            # This is why the relay never sends commit or response.create per
            # turn -- doing so double-commits and produces a stuttering
            # interviewer that nobody can reproduce on a quiet machine.
            "create_response": True,
            # THE RELAY owns interruption: _on_speech_started flushes the browser
            # queue and sends response.cancel itself. Left at its default of true
            # the SERVER cancels the moment it emits speech_started, our cancel
            # lands one RTT later against an already-cancelled response, and the
            # API answers error(code="response_cancel_not_active") -- which
            # _handle_upstream_event forwards downstream as reep.error and the
            # client raises as a warning banner. That is one spurious banner per
            # barge-in, mid-interview. Exactly one party may cancel; the brief
            # names this one. Sent on BOTH surfaces because both default to true.
            "interrupt_response": False,
        }

        if settings.realtime_beta_header:
            # Beta: flat session object. "text" must accompany "audio" here or
            # the assistant transcript is never emitted.
            return {
                "modalities": ["text", "audio"],
                "instructions": _INTERVIEWER_PERSONA,
                "voice": settings.openai_realtime_voice,
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "input_audio_transcription": {"model": "whisper-1"},
                "turn_detection": turn_detection,
            }

        # GA: nested session object. session.type is REQUIRED here -- without it
        # the whole object is rejected and the interview silently runs on default
        # instructions.
        return {
            "type": "realtime",
            "instructions": _INTERVIEWER_PERSONA,
            "output_modalities": ["audio"],
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": _AUDIO_SAMPLE_RATE_HZ},
                    "turn_detection": turn_detection,
                    # Without this, the student's side is never transcribed and
                    # there is nothing to show or store.
                    "transcription": {"model": "whisper-1"},
                },
                "output": {
                    "format": {"type": "audio/pcm", "rate": _AUDIO_SAMPLE_RATE_HZ},
                    "voice": settings.openai_realtime_voice,
                },
            },
        }

    async def _await_upstream_event(
        self,
        upstream: ClientConnection,
        wanted: frozenset[str],
        caused_by_event_id: str | None = None,
    ) -> dict[str, Any]:
        """Read upstream until one of `wanted` arrives, logging what is skipped.

        Unbounded only in appearance: every caller runs inside the handshake
        timeout, so a chatty upstream that never sends the expected event fails
        as a timeout rather than spinning forever.

        `caused_by_event_id` is the id of the client event we are waiting on the
        reply to. An `error` echoing that id IS the reply: a rejected
        session.update (bad voice name, out-of-range VAD value) never produces a
        session.updated, so without this the student waited the full 20 s
        handshake timeout for a cause that arrived in ~200 ms.
        """
        while True:
            event = json.loads(await upstream.recv())
            etype = event.get("type", "")
            if etype in wanted:
                return event
            if etype == "error":
                self._log_upstream_error(event, phase="handshake")
                err = event.get("error") or {}
                if caused_by_event_id and err.get("event_id") == caused_by_event_id:
                    raise _SessionEnded(
                        _CLOSE_UPSTREAM_UNAVAILABLE,
                        "Voice service unavailable, try again shortly",
                    )
                continue
            self._log.info(
                "Ignoring %s while waiting for %s", etype, "|".join(sorted(wanted))
            )

    async def _handshake(self, upstream: ClientConnection) -> None:
        """The mandated startup sequence, enforced in order rather than hoped for.

            recv session.created  -> recv session.updated -> send response.create
                  -> send reep.ready -> only now does the browser send audio

        session.update is NOT sent before session.created even though the server
        would accept it: there would be no session id to correlate a rejection
        against, and the default instructions would be live in the gap.
        """
        created = await self._await_upstream_event(upstream, frozenset({"session.created"}))
        session = created.get("session") or {}
        self._session_id = session.get("id")
        # Rebind so every later line carries the id -- this is the correlation
        # handle for any support ticket raised with OpenAI.
        self._log.extra = {"conn_id": self._conn_id, "session_id": self._session_id}
        self._log.info("Upstream session created (model=%s)", session.get("model"))

        update_event_id = self._next_event_id("session-update")
        await upstream.send(
            json.dumps(
                {
                    "type": "session.update",
                    "event_id": update_event_id,
                    "session": self._session_update_payload(),
                }
            )
        )

        updated = await self._await_upstream_event(
            upstream, frozenset({"session.updated"}), caused_by_event_id=update_event_id
        )
        self._verify_turn_detection(updated.get("session") or {})

        # Exactly once per session, and the reason the student is not met with
        # silence: the model produces nothing until it has an input. `instructions`
        # is deliberately omitted -- supplying it here REPLACES the session
        # persona for this response instead of adding to it, which would drop the
        # persona on precisely the turn that sets the tone.
        await upstream.send(
            json.dumps(
                {
                    "type": "response.create",
                    "event_id": self._next_event_id("open"),
                    "response": {"conversation": "auto"},
                }
            )
        )

        await self._send_control(
            {
                "type": "reep.ready",
                "session_id": self._session_id,
                "conn_id": self._conn_id,
                "audio": {
                    "format": _AUDIO_FORMAT_NAME,
                    "sample_rate": _AUDIO_SAMPLE_RATE_HZ,
                    "chunk_ms": _CLIENT_CHUNK_MS_HINT,
                },
                "limits": {
                    "session_max_seconds": settings.interview_max_seconds,
                    "idle_max_seconds": settings.interview_idle_seconds,
                },
            }
        )
        self._log.info("Interview ready; accepting client audio")

    def _verify_turn_detection(self, session: dict[str, Any]) -> None:
        """session.updated is the only positive confirmation the config took."""
        present, value = _echoed_turn_detection(session)
        if not present:
            # This surface did not echo the field. Not proof of anything, so it
            # must not end the interview -- but it removes our only check.
            self._log.warning(
                "session.updated did not echo turn_detection; server VAD is "
                "unverified for this session"
            )
            return
        if not isinstance(value, dict) or value.get("type") != "server_vad":
            # Fatal and worth being blunt about: with VAD off no turn ever ends,
            # so the student talks and the interviewer never answers. Failing here
            # gives them a retry instead of two silent minutes.
            self._log.error(
                "session.update was not applied: turn_detection echoed back as %r. "
                "Server VAD is off, so no student turn would ever complete.",
                value,
            )
            raise _SessionEnded(
                _CLOSE_UPSTREAM_UNAVAILABLE, "Voice service unavailable, try again shortly"
            )

    # -- pumps --------------------------------------------------------------

    async def _pump_client_to_upstream(self, upstream: ClientConnection) -> None:
        """browser -> OpenAI. Binary frames are audio; text frames are control.

        There is no queue here by design: this task reads one frame and awaits
        the upstream send. A slow upstream therefore stops us reading, the TCP
        window closes toward the browser, and memory stays flat. A queue would be
        a buffer holding a student's voice that we would then have to bound.
        """
        while True:
            message = await self._ws.receive()
            mtype = message.get("type")

            if mtype == "websocket.disconnect":
                raise WebSocketDisconnect(
                    code=message.get("code", 1005), reason=message.get("reason") or ""
                )

            data = message.get("bytes")
            if data is not None:
                await self._forward_client_audio(upstream, data)
                continue

            text = message.get("text")
            if text is not None:
                await self._handle_client_control(upstream, text)

    async def _forward_client_audio(
        self, upstream: ClientConnection, pcm: bytes
    ) -> None:
        """The hot path: ~25 frames/s/session. Nothing here allocates unnecessarily."""
        if len(pcm) > _MAX_CLIENT_FRAME_BYTES:
            # Dropped, not truncated: a frame this size is not audio this relay
            # asked for, and truncating would splice an unrelated waveform into
            # the middle of the student's turn.
            self._log.warning(
                "Discarding oversized client audio frame: %d bytes (cap %d)",
                len(pcm),
                _MAX_CLIENT_FRAME_BYTES,
            )
            return
        if self._pcm_carry:
            pcm = self._pcm_carry + pcm
            self._pcm_carry = b""
        if len(pcm) & 1:
            # PCM16 is 2 bytes/sample. Sending an odd byte count would split a
            # sample across the frame boundary and produce an audible click; the
            # stray byte belongs to the next frame.
            self._pcm_carry = pcm[-1:]
            pcm = pcm[:-1]
        if not pcm:
            return

        # A plain assignment, which is the whole reason the watchdog polls
        # monotonic timestamps instead of re-arming a timer per frame.
        self._last_audio_at = time.monotonic()
        self._client_frames += 1
        self._client_bytes += len(pcm)

        await upstream.send(
            _APPEND_PREFIX + base64.b64encode(pcm).decode("ascii") + _APPEND_SUFFIX
        )

    async def _handle_client_control(
        self, upstream: ClientConnection, text: str
    ) -> None:
        try:
            event = json.loads(text)
        except json.JSONDecodeError:
            self._log.warning("Discarding malformed control frame from browser")
            return
        if not isinstance(event, dict):
            self._log.warning("Discarding non-object control frame from browser")
            return

        etype = event.get("type")
        if etype == _CLIENT_END:
            self._log.info("Student ended the interview")
            raise _SessionEnded(_CLOSE_OK, "Interview complete")

        if etype == _CLIENT_APPEND:
            # The base64 uplink (public/app.js `?uplink=base64`). The payload is
            # already the exact base64 the upstream event wants, so it is passed
            # through without a decode/re-encode round trip -- but it IS bounded,
            # because nothing else in this process bounds a text frame.
            audio = event.get("audio")
            if not isinstance(audio, str) or not audio:
                self._log.warning("Discarding append frame with no audio payload")
                return
            if len(audio) > _MAX_CLIENT_APPEND_B64_CHARS:
                self._log.warning(
                    "Discarding oversized append frame: %d base64 chars (cap %d)",
                    len(audio),
                    _MAX_CLIENT_APPEND_B64_CHARS,
                )
                return
            if len(audio) % 4 or not _B64_ALPHABET.issuperset(audio):
                # Not audio this relay asked for. Dropped, never forwarded:
                # anything outside the alphabet would break out of the JSON
                # string this frame is concatenated into. See _B64_ALPHABET.
                self._log.warning(
                    "Discarding append frame that is not valid base64 (%d chars)",
                    len(audio),
                )
                return
            self._last_audio_at = time.monotonic()
            self._client_frames += 1
            # Decoded length, so the two uplink modes report the same figure in
            # the end-of-interview line.
            self._client_bytes += (len(audio) * 3) // 4
            await upstream.send(_APPEND_PREFIX + audio + _APPEND_SUFFIX)
            return

        if etype == _CLIENT_CLEAR:
            # The mic went away (muted, tab hidden). Discard un-committed audio so
            # a half-utterance cannot be committed by VAD minutes later and
            # presented as the student's answer. This does NOT stop the model
            # talking; that is response.cancel.
            await upstream.send(
                json.dumps(
                    {
                        "type": "input_audio_buffer.clear",
                        "event_id": self._next_event_id("clear"),
                    }
                )
            )
            return

        self._log.info("Ignoring unsupported control event from browser: %s", etype)

    async def _pump_upstream_to_client(self, upstream: ClientConnection) -> None:
        """OpenAI -> browser. The only task that writes downstream.

        `async for` is the single permitted consumer of this socket: concurrent
        recv() on one ClientConnection raises RuntimeError.
        """
        async for raw in upstream:
            await self._handle_upstream_event(json.loads(raw))

        # The iterator ends on a CLEAN upstream close. Mid-interview that is
        # still the service hanging up on us, not a normal finish -- the normal
        # finish is driven by the student or the watchdog and never gets here.
        raise _SessionEnded(
            _CLOSE_UPSTREAM_UNAVAILABLE, "Voice service ended the session"
        )

    async def _handle_upstream_event(self, event: dict[str, Any]) -> None:
        etype = event.get("type", "")

        if etype in _AUDIO_DELTA_TYPES:
            await self._forward_model_audio(event)
            return

        if etype == "input_audio_buffer.speech_started":
            await self._on_speech_started()
            return

        if etype == "input_audio_buffer.speech_stopped":
            # Forward only. The server commits the buffer and creates the
            # response itself; a manual commit here races the automatic one.
            await self._send_control({"type": "input_audio_buffer.speech_stopped"})
            return

        if etype == "response.created":
            response = event.get("response") or {}
            self._active_response_id = response.get("id")
            await self._send_control(
                {"type": "response.created", "response_id": self._active_response_id}
            )
            return

        if etype in _AUDIO_DONE_TYPES:
            # Lets the browser drain its scheduled buffers rather than cut.
            await self._send_control(
                {"type": "response.audio.done", "response_id": event.get("response_id")}
            )
            return

        if etype in _TRANSCRIPT_DELTA_TYPES:
            # `delta` is plain text here, not base64 -- captions, not audio.
            response_id = event.get("response_id")
            delta = event.get("delta", "")
            if response_id is not None and delta:
                # Kept so response.done can persist the whole spoken turn. The
                # browser still gets every delta for live captions; before this
                # the relay forwarded them and threw them away, which is why the
                # interviewer's half of the transcript reached no database.
                self._assistant_text[response_id] = (
                    self._assistant_text.get(response_id, "") + delta
                )
            await self._send_control(
                {
                    "type": "response.audio_transcript.delta",
                    "response_id": response_id,
                    "delta": delta,
                }
            )
            return

        if etype == _USER_TRANSCRIPT_DONE:
            # Forwarded under the UPSTREAM name, not a reep.* alias. public/app.js
            # switches on the Realtime event names -- it already handles the
            # `.delta` and `.failed` siblings -- so the rename matched no case,
            # fell through to `default:`, and left the "You" half of the
            # transcript permanently empty with nothing logged anywhere.
            item_id = event.get("item_id")
            transcript = event.get("transcript", "")
            # "u:" / "a:" prefixes: item ids and response ids are drawn from
            # different upstream sequences with no guarantee of being distinct
            # from each other, while append_message dedups on
            # (conversation_id, provider_turn_id) -- a single namespace.
            self._emit_turn("user", transcript, f"u:{item_id}")
            await self._send_control(
                {
                    "type": _USER_TRANSCRIPT_DONE,
                    "item_id": item_id,
                    "transcript": transcript,
                }
            )
            return

        if etype == "response.done":
            await self._on_response_done(event)
            return

        if etype == "error":
            self._log_upstream_error(event, phase="session")
            err = event.get("error") or {}
            # `code` and `param` only. error.message can quote request content
            # back at us, and reflecting it downstream would hand the browser
            # text this relay never inspected.
            await self._send_control(
                {
                    "type": "reep.error",
                    "scope": "upstream",
                    "code": err.get("code"),
                    "param": err.get("param"),
                }
            )
            return

        if etype == "rate_limits.updated":
            # The early warning before a 429 refuses the NEXT student's handshake.
            self._log.info("Upstream rate limits: %s", event.get("rate_limits"))
            return

        if etype not in _HANDLED_UPSTREAM and etype not in self._logged_unknown:
            # Once per type per connection; bounded by the event vocabulary, so
            # this set cannot grow with traffic.
            self._logged_unknown.add(etype)
            self._log.info("Upstream event not forwarded downstream: %s", etype)

    async def _forward_model_audio(self, event: dict[str, Any]) -> None:
        response_id = event.get("response_id")
        if response_id is not None and response_id != self._active_response_id:
            # A stale delta from a response already cancelled by barge-in. The
            # browser has flushed its play queue; letting this through would make
            # the interviewer talk over the student from beyond the grave.
            return
        try:
            pcm = base64.b64decode(event.get("delta", ""), validate=True)
        except (BinasciiError, ValueError) as exc:
            self._log.error("Undecodable audio delta on response %s: %s", response_id, exc)
            return
        if pcm:
            await self._send_audio(pcm)

    async def _on_speech_started(self) -> None:
        """Barge-in: flush the browser's play queue, then stop the model."""
        # Downstream FIRST. The student is already talking over the agent, and
        # every millisecond before the play queue is flushed is audible.
        await self._send_control({"type": "reep.audio.flush"})
        await self._send_control({"type": "input_audio_buffer.speech_started"})

        # Clearing this before sending the cancel arms the drop-filter in
        # _forward_model_audio, so deltas still in flight for the dying response
        # never reach a browser that has already flushed them.
        response_id, self._active_response_id = self._active_response_id, None

        if response_id is None or self._upstream is None:
            # Nothing in flight -- the student spoke into silence. response.cancel
            # is valid ONLY between response.created and response.done, so sending
            # it here would earn an error event indistinguishable from a real one.
            return

        await self._upstream.send(
            json.dumps(
                {
                    "type": "response.cancel",
                    "event_id": self._next_event_id("cancel"),
                    # Optional, but we have it from response.created and it
                    # removes any ambiguity about which response was meant.
                    "response_id": response_id,
                }
            )
        )

    async def _on_response_done(self, event: dict[str, Any]) -> None:
        response = event.get("response") or {}
        response_id = response.get("id")
        status = response.get("status")

        if response_id == self._active_response_id:
            self._active_response_id = None

        if status in ("failed", "incomplete"):
            # THIS is where model failures actually surface. A failed response
            # carries its cause here and does NOT produce a top-level `error`
            # event, so code that only watches `error` reports a healthy session
            # that produced no sound.
            self._log.error(
                "Response %s ended %s: %s",
                response_id,
                status,
                response.get("status_details"),
            )
        else:
            self._log.info("Response %s ended %s", response_id, status)

        # Popped whatever the status, so a cancelled (barge-in) response cannot
        # leave partial text behind to be attributed to the NEXT response. The
        # partial IS stored: it is what the interviewer actually said before the
        # student cut in, and a transcript that silently omits every interrupted
        # question is not a record of the interview that happened.
        spoken = self._assistant_text.pop(response_id, "") if response_id else ""
        self._emit_turn("assistant", spoken, f"a:{response_id}")

        await self._send_control(
            {"type": "response.done", "response_id": response_id, "status": status}
        )

    # -- persistence --------------------------------------------------------

    def _emit_turn(self, sender: str, text: str, provider_turn_id: str) -> None:
        """Persist one FINAL turn. FIRE-AND-FORGET, by contract.

        A failed write must never end an interview that is otherwise going fine
        -- the same deliberate choice AGENTS.md documents for the LiveKit voice
        transcript POSTs, and for the same reason: the student is mid-sentence
        and cannot be helped by an exception. The price is exactly the failure
        mode that runbook exists to catch (perfect in the room, empty in the
        database), so a failed write is logged WITH ITS CAUSE, never swallowed.

        The task is held on `self` so teardown can drain it, rather than being a
        bare create_task whose only reference is the loop's weak one -- which
        CPython is free to garbage-collect mid-write.
        """
        if self._on_turn is None or not text.strip():
            return
        task = asyncio.create_task(
            self._run_turn_write(sender, text, provider_turn_id),
            name=f"interview-write-{self._conn_id}",
        )
        self._writes.add(task)
        task.add_done_callback(self._writes.discard)

    async def _run_turn_write(
        self, sender: str, text: str, provider_turn_id: str
    ) -> None:
        on_turn = self._on_turn
        if on_turn is None:  # pragma: no cover -- guarded by _emit_turn
            return
        try:
            # to_thread, NOT a direct call: see the _on_turn note in __init__.
            await asyncio.to_thread(on_turn, sender, text, provider_turn_id)
        except asyncio.CancelledError:
            # Teardown outran the write. Re-raised so the drain is not lied to,
            # but said out loud first: this is a turn that is NOT in the database.
            self._log.warning(
                "Interview turn not persisted (cancelled at teardown): "
                "sender=%s turn=%s",
                sender,
                provider_turn_id,
            )
            raise
        except Exception as exc:
            self._log.error(
                "Dropped interview turn: sender=%s turn=%s: %s",
                sender,
                provider_turn_id,
                exc,
            )

    async def _drain_writes(self) -> None:
        """Let in-flight turn writes finish before this session goes away.

        Bounded: a wedged database must not hold the browser socket open, and
        the turns it is sitting on are lost to the student either way. Anything
        that has not landed by the deadline is cancelled, and _run_turn_write
        says so rather than letting the row vanish quietly.
        """
        if not self._writes:
            return
        pending = tuple(self._writes)
        try:
            async with asyncio.timeout(_TURN_WRITE_DRAIN_S):
                await asyncio.gather(*pending, return_exceptions=True)
        except TimeoutError:
            self._log.warning(
                "%d interview turn write(s) did not finish within %.0fs",
                sum(1 for task in pending if not task.done()),
                _TURN_WRITE_DRAIN_S,
            )
            for task in pending:
                task.cancel()

    # -- watchdog -----------------------------------------------------------

    async def _watchdog(self) -> None:
        """Both guardrails, plus the shutdown signal, on one coarse timer.

        Raising is the mechanism: the TaskGroup cancels both pumps in response,
        which is what guarantees no task outlives the session.
        """
        session_cap = float(settings.interview_max_seconds)
        idle_cap = float(settings.interview_idle_seconds)

        while True:
            # Waiting on the stop event rather than sleeping means shutdown ends
            # the session immediately instead of up to _WATCHDOG_INTERVAL_S later.
            try:
                async with asyncio.timeout(_WATCHDOG_INTERVAL_S):
                    await self._stop_requested.wait()
            except TimeoutError:
                pass
            else:
                raise _SessionEnded(*self._stop_outcome)

            now = time.monotonic()

            if now - self._started_at >= session_cap:
                self._log.info(
                    "Hard cap reached after %.0fs (%d client audio frames)",
                    now - self._started_at,
                    self._client_frames,
                )
                raise _SessionEnded(
                    _CLOSE_SESSION_CAP,
                    f"Session limit of {_humanize_seconds(settings.interview_max_seconds)} reached",
                )

            if now - self._last_audio_at >= idle_cap:
                self._log.info(
                    "Idle cap reached: no client audio for %.0fs", now - self._last_audio_at
                )
                raise _SessionEnded(
                    _CLOSE_IDLE,
                    f"No audio received for {_humanize_seconds(settings.interview_idle_seconds)}",
                )

    # -- orchestration ------------------------------------------------------

    async def run(self) -> tuple[int, str]:
        """Open upstream, run the interview, and return the downstream close code.

        Every exit path -- clean end, client disconnect, upstream close, upstream
        error, guardrail, cancellation -- leaves through here with both sockets
        closed and no task still running.
        """
        code, reason = _CLOSE_INTERNAL, "Internal error"
        try:
            async with _upstream_connector(
                settings.realtime_url, settings.openai_api_key.strip(), settings.realtime_beta_header
            ) as upstream:
                self._upstream = upstream
                try:
                    code, reason = await self._interview(upstream)
                finally:
                    # Close upstream with our reason BEFORE the context manager
                    # does it with a bare 1000, so the upstream log says why.
                    # Suppressed because a socket the peer already closed raises
                    # here, and that is not a failure of the interview.
                    with contextlib.suppress(Exception):
                        await upstream.close(
                            # OpenAI is not the party at fault for our guardrails,
                            # so it always gets a normal closure; the human reason
                            # carries the detail.
                            code=_CLOSE_OK,
                            reason=_close_reason(reason),
                        )
                    self._upstream = None

        except InvalidStatus as exc:
            # The diagnostic that matters: 401 = bad or absent key, 403 = model
            # not enabled for this org, 404 = bad model id in the query string,
            # 429 = concurrent-session cap. A generic "upstream failed" hides all
            # four and sends the operator hunting in the wrong place.
            status = exc.response.status_code
            self._log.error(
                "OpenAI Realtime handshake refused: HTTP %s (model=%s)",
                status,
                settings.openai_realtime_model,
            )
            if status == 401:
                code, reason = _CLOSE_NOT_CONFIGURED, "Voice service not configured"
            else:
                code, reason = (
                    _CLOSE_UPSTREAM_UNAVAILABLE,
                    "Voice service unavailable, try again shortly",
                )

        except InvalidHandshake as exc:
            self._log.error("OpenAI Realtime handshake malformed: %s", exc)
            code, reason = (
                _CLOSE_UPSTREAM_UNAVAILABLE,
                "Voice service unavailable, try again shortly",
            )

        except TimeoutError:
            # Either the connect open_timeout or the scripted-handshake timeout.
            self._log.error(
                "OpenAI Realtime did not complete the startup sequence within %.0fs",
                _HANDSHAKE_TIMEOUT_S,
            )
            code, reason = (
                _CLOSE_UPSTREAM_UNAVAILABLE,
                "Voice service unavailable, try again shortly",
            )

        except ConnectionClosed as exc:
            rcvd = exc.rcvd
            self._log.error(
                "OpenAI Realtime closed during startup: code=%s reason=%s",
                getattr(rcvd, "code", None),
                getattr(rcvd, "reason", None),
            )
            code, reason = (
                _CLOSE_UPSTREAM_UNAVAILABLE,
                "Voice service unavailable, try again shortly",
            )

        except OSError as exc:
            # DNS failure, refused connection, TLS problem -- the network, not us.
            self._log.error("Cannot reach OpenAI Realtime: %s", exc)
            code, reason = (
                _CLOSE_UPSTREAM_UNAVAILABLE,
                "Voice service unavailable, try again shortly",
            )

        except _SessionEnded as exc:
            # Raised by the handshake's VAD check, before any pump exists.
            code, reason = exc.code, exc.reason

        except WebSocketDisconnect:
            # The student closed the tab while the upstream was still connecting.
            self._log.info("Browser disconnected during startup")
            code, reason = _CLOSE_OK, "Interview complete"

        return code, reason

    async def _interview(self, upstream: ClientConnection) -> tuple[int, str]:
        async with asyncio.timeout(_HANDSHAKE_TIMEOUT_S):
            await self._handshake(upstream)

        code, reason = _CLOSE_INTERNAL, "Internal error"
        settled = False

        try:
            async with asyncio.TaskGroup() as group:
                group.create_task(
                    self._pump_client_to_upstream(upstream), name=f"c2u-{self._conn_id}"
                )
                group.create_task(
                    self._pump_upstream_to_client(upstream), name=f"u2c-{self._conn_id}"
                )
                group.create_task(self._watchdog(), name=f"wd-{self._conn_id}")

        # The clauses below run in source order and several may run for one
        # group, so `settled` fixes the precedence: a deliberate end outranks the
        # disconnects it caused. Anything NOT matched here propagates, which is
        # what turns an unforeseen bug into a logged 1011 rather than a silent
        # "Interview complete".
        except* _SessionEnded as eg:
            ended = _first_leaf(eg, _SessionEnded)
            if ended is not None:
                code, reason, settled = ended.code, ended.reason, True

        except* WebSocketDisconnect as eg:
            disconnect = _first_leaf(eg, WebSocketDisconnect)
            self._log.info(
                "Browser disconnected (code=%s)", getattr(disconnect, "code", None)
            )
            if not settled:
                code, reason, settled = _CLOSE_OK, "Interview complete", True

        except* ConnectionClosed as eg:
            closed = _first_leaf(eg, ConnectionClosed)
            rcvd = getattr(closed, "rcvd", None)
            # Always logged even when another clause already settled the outcome:
            # a 1008 from OpenAI carries a real cause, and a bare `except
            # ConnectionClosed: pass` throws away the only copy of it.
            self._log.warning(
                "Upstream connection closed: code=%s reason=%s",
                getattr(rcvd, "code", None),
                getattr(rcvd, "reason", None),
            )
            if not settled:
                code, reason, settled = (
                    _CLOSE_UPSTREAM_UNAVAILABLE,
                    "Voice service closed the connection",
                    True,
                )

        # AFTER the pumps have stopped and BEFORE the summary line, so that
        # line is the last word on the interview and a late write can never be
        # attributed to a session already reported as finished.
        await self._drain_writes()

        self._log.info(
            "Interview finished: code=%s reason=%r duration=%.0fs frames=%d bytes=%d",
            code,
            reason,
            time.monotonic() - self._started_at,
            self._client_frames,
            self._client_bytes,
        )
        return code, reason


async def _close_downstream(websocket: WebSocket, code: int, reason: str) -> None:
    """Close the browser socket, once, without ever masking the real cause.

    Both Starlette states are checked: the client half goes DISCONNECTED as soon
    as the peer's close frame is read, and sending into that raises RuntimeError.
    """
    if (
        websocket.client_state is not WebSocketState.CONNECTED
        or websocket.application_state is not WebSocketState.CONNECTED
    ):
        return
    try:
        await websocket.close(code=code, reason=_close_reason(reason))
    except Exception as exc:
        # Logged, never swallowed silently -- but never re-raised either: this
        # runs in a `finally`, where raising would replace the exception that
        # actually ended the interview with a teardown detail.
        log.warning("Failed to close browser socket cleanly: %s", exc)


def ask_all_sessions_to_stop(sessions: set[_RelaySession]) -> None:
    """Ask every live interview to close ITSELF, with a real code and reason.

    Never blocks and never awaits, so it is safe from a lifespan teardown. Each
    session's own watchdog does the work, which is what turns an abrupt 1006
    into a 1001 the client has a sentence for.
    """
    if not sessions:
        return
    log.info("Shutdown requested: asking %d live interview(s) to close", len(sessions))
    for session in tuple(sessions):
        session.request_stop(_CLOSE_GOING_AWAY, "Server shutting down")
