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
from dataclasses import dataclass
from typing import Any, Final, TypeVar

from fastapi import WebSocket, WebSocketDisconnect

# Via fastapi, not `from starlette.websockets import ...` directly: starlette is
# a TRANSITIVE dependency here and requirements.txt pins fastapi rather than
# starlette (the same convention as the rest of apps/api-py). Importing it
# directly meant this module depended on a package whose version nothing in this
# repo fixes, under fastapi's own floor of `starlette>=0.46.0`. Identical object.
from fastapi.websockets import WebSocketState
from websockets.asyncio.client import ClientConnection, connect as ws_connect
from websockets.exceptions import (
    ConnectionClosed,
    ConnectionClosedOK,
    InvalidHandshake,
    InvalidStatus,
)

from .config import settings
from .interview_matrix import (
    KNOWN_REALTIME_VOICES,
    REPORT_DIRECTIVE,
    InterviewPhase,
    InterviewStateMachine,
    Specialization,
    build_instructions,
    build_turn_instructions,
    classify_answer,
)

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Persona
# ---------------------------------------------------------------------------

# VERBATIM -- the wording is the product spec, not a suggestion. Editing it
# changes what every student is assessed against.
#
# It is also, deliberately, the ONLY thing sent upstream that this app authors
# -- alone for the generic interview, or composed by app/interview_matrix.py
# (base persona first and unchanged, then a specialization block and a phase
# directive, all fixed strings) when the student picked a specialization.
# AGENTS.md rule 1 gates student PII leaving the machine, and api.openai.com is
# emphatically not loopback. A fixed persona carries no marks, USN or attendance,
# and neither does a specialization key the student chose in the UI, so the
# relay sits outside that gate today. The moment anyone personalises these
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

# The streaming halves of that transcript, forwarded so the browser can show
# and revise a PENDING "You" line while the student is still being
# transcribed. Never persisted -- the .completed event above remains the only
# persistence point -- and never acted on for the arc, which only ever reads
# final transcripts. The beta generation may not emit these; the client's
# fallback is the completed-only behaviour it has always had.
_USER_TRANSCRIPT_DELTA: Final[str] = (
    "conversation.item.input_audio_transcription.delta"
)

# The sibling nobody handled until v3, and the cost of that was invisible: a
# transcription that FAILS produced no .completed, so the phase machine never
# ticked and the turn left no row. Under create_response:false it is worse than
# invisible -- nothing else would ever resolve that turn, and the interview
# would simply stop. It resolves the pending entry with an empty transcript and
# the interviewer asks the student to say it again.
_USER_TRANSCRIPT_FAILED: Final[str] = (
    "conversation.item.input_audio_transcription.failed"
)

# Server VAD committing the input buffer, carrying the item_id the transcript
# will arrive under. NOTHING DEPENDS ON THIS EVENT ARRIVING: whether it is still
# emitted under create_response:false is unverified on both API surfaces, so the
# answer deadline is armed from speech_stopped (which is verified and already
# handled) and this event only REFINES that entry with its item id. If it never
# comes, the turn is recorded under a synthetic key and everything else runs.
_INPUT_COMMITTED: Final[str] = "input_audio_buffer.committed"

# The text-only scorecard response streams through these. Two names for two API
# generations, exactly like the audio deltas above. They are accumulated ONLY as
# a fallback for a surface that returns an empty `output` array on response.done
# -- the report is read from response.done, which is one atomic event -- and
# they are never forwarded downstream, because the scorecard is JSON and the
# student's chat is not the place for it.
_TEXT_DELTA_TYPES: Final[frozenset[str]] = frozenset(
    {"response.text.delta", "response.output_text.delta"}
)

# Every upstream event this relay acts on. Anything outside this set is logged
# once per type per connection and dropped -- an allowlist, never a blind
# forward, so a new upstream event cannot start leaking unreviewed fields (or
# model-authored text) into the browser.
_HANDLED_UPSTREAM: Final[frozenset[str]] = (
    _AUDIO_DELTA_TYPES
    | _AUDIO_DONE_TYPES
    | _TRANSCRIPT_DELTA_TYPES
    | _TEXT_DELTA_TYPES
    | frozenset(
        {
            "error",
            "input_audio_buffer.speech_started",
            "input_audio_buffer.speech_stopped",
            _INPUT_COMMITTED,
            "rate_limits.updated",
            "response.created",
            "response.done",
            _USER_TRANSCRIPT_DONE,
            _USER_TRANSCRIPT_DELTA,
            _USER_TRANSCRIPT_FAILED,
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

# The browser's half-duplex echo gate announcing which side of the duplex it is
# on (InterviewService.setGate). It is COUNTED and nothing else, deliberately:
#
#   * it must NOT clear the upstream append buffer, because the buffer at gate
#     close can already hold a barge-in the student began and server VAD has not
#     committed -- discarding it would break barge-in, which is the one thing the
#     gate exists to protect;
#   * it must NOT advance _last_audio_at, or a client could hold a billing
#     session open indefinitely with text frames and no audio, which is exactly
#     what the idle watchdog is a cost guardrail against.
#
# Counting it is still worth the branch: the totals land in the end-of-interview
# line, so "the gate was shut for most of this session" is answerable from a
# server log instead of from a browser console the student does not have open.
_CLIENT_GATE: Final[str] = "reep.mic.gate"

# Unsupported CLIENT control types are logged once each, like unknown upstream
# events -- but the type here is CHOSEN BY THE BROWSER rather than drawn from a
# fixed vocabulary, so the memo must be bounded or a hostile client turns it into
# unbounded growth on untrusted input. 32 is far above the real vocabulary and
# far below anything that costs memory. Keyed "client:" so the two namespaces
# cannot collide inside the one _logged_unknown set.
_MAX_LOGGED_CLIENT_TYPES: Final[int] = 32


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

# The two audio tracks THIS MODULE FEEDS, spelled here so it needs no import
# from app/interview_audio.py (see the `recorder` note in __init__). They MUST
# match that module's SOURCE_TRACKS, and tests/test_interview_audio.py asserts
# they do -- a mismatch would write a file the download endpoint cannot find,
# silently. That module's TRACKS is one longer: it also holds the `mixed`
# listening copy, which is DERIVED at close from these two and is never fed.
_AUDIO_TRACK_STUDENT: Final[str] = "student"
_AUDIO_TRACK_INTERVIEWER: Final[str] = "interviewer"

# How long teardown waits for the recording to flush, close AND MIX DOWN.
# Longer than the turn drain because this is tens of megabytes reaching a disk
# rather than one row reaching Postgres, and short enough that a wedged disk
# cannot hold the browser's close frame. On expiry the relay records what the
# recorder BELIEVES is on disk (snapshot()) rather than "nothing" -- a real file
# that no row points at is a recording of a named student that retention will
# never destroy.
#
# The mixdown is the only CPU-bound thing under this timeout: measured at ~1.6 s
# for two FULL-LENGTH tracks that are loud end to end, ~0.1 s for a real
# interview (most of both tracks is padded silence, which the mixer copies
# rather than sums). ~1.2 s is the TEN-minute figure and this comment used to
# quote it against the fifteen-minute case -- the same slip
# `interview_audio._write_mix` corrects at its own copy of these numbers; if you
# re-measure, re-measure BOTH. If the headroom ever stops being large, raise
# this rather than moving the mix out -- a mix that lands after the row is
# written is a file `audio_bytes` does not account for.
#
# BOTH FIGURES ARE FOR ONE SESSION CLOSING ALONE, which is the wrong shape to
# size a timeout against if interviews ever end together. `_mix_pcm` sums in
# Python and holds the GIL, so `asyncio.to_thread` buys ordering here, not
# parallelism: 15 sessions closing at once measured 14-17x the cost of one, at
# both content extremes. Against interview_max_sessions (100) that is well past
# this timeout, and the sessions at the back of the queue lose their MIX -- not
# their recording, which `_close_writers` has already finished by then.
_AUDIO_CLOSE_TIMEOUT_S: Final[float] = 10.0

# Bound on the two writes that are AWAITED rather than fire-and-forget: the
# evaluation row and the finalization of the interview_sessions row. Both happen
# once, after the interview is over, so the reason fire-and-forget exists ("the
# student is mid-sentence and cannot be helped by an exception") does not apply
# to either -- but a wedged database still must not hold the browser socket
# open, so they are bounded rather than unbounded. Deliberately longer than
# _TURN_WRITE_DRAIN_S: a turn is one of dozens and losing one is survivable,
# while these two ARE the record.
_RECORD_WRITE_TIMEOUT_S: Final[float] = 3.0

# How often the watchdog stamps interview_sessions.heartbeat_at. This is the
# ONLY thing that makes an orphaned session detectable: a worker killed with -9
# cannot finalize its own rows, so without a heartbeat every crash leaves rows
# claiming to be `running` forever and the sweeper has nothing to key on
# (started_at alone cannot tell a long healthy interview from a dead one).
# 60 s against interview_orphan_grace_seconds (1200) leaves twenty missed
# heartbeats of slack, and at the 100-session cap it is 1.7 writes/second.
_HEARTBEAT_WRITE_INTERVAL_S: Final[float] = 60.0

# The most student utterances that may be waiting on a transcript at once.
# Reached only when the transcriber has stopped answering, in which case every
# one of these entries is seconds from its own deadline and a ninth would buy
# nothing. It exists so a broken upstream cannot grow this dict without bound.
_MAX_PENDING_TURNS: Final[int] = 8

# Memo of item ids already drained, so a duplicate .completed cannot resurrect a
# turn that has been consumed (DF2). Bounded because it is fed by upstream: an
# interview produces a few dozen utterances, and a hostile stream must not be
# able to grow it without limit. It evicts the OLDEST id at the cap -- see
# _memoise_resolved, which explains why refusing the newest is the one policy
# that cannot work here.
_MAX_RESOLVED_ITEMS: Final[int] = 64

# Response.create event ids that may be outstanding at once: one create and the
# single retry S2 allows it. Realtime does not echo our event_id on
# response.created, so an id can only leave this list positionally or by being
# named in an `error` -- and a create that upstream neither acknowledges nor
# refuses would otherwise sit here for the rest of the session.
_MAX_OUTSTANDING_CREATES: Final[int] = 2

# Consecutive responses cancelled by barge-in before they made a sound, after
# which the relay stops cancelling for the rest of the session. A room where VAD
# fires constantly otherwise produces fifteen minutes of interrupted questions
# and no answers at all; a talkative interviewer the student can't interrupt is
# a far better failure than an interviewer who never finishes a sentence.
_MAX_BARGEIN_THRASH: Final[int] = 3

# Slack added to interview_report_timeout_ms to decide when the session cap is
# close enough to force the wrap-up. Covers the spoken verdict itself plus the
# round trips around it: the scorecard cannot start until the verdict finishes.
# NOT a Final int computed at import, because interview_report_timeout_ms is
# operator-tunable and a constant folded here would silently stop matching it.
_REPORT_RESERVE_EXTRA_S: Final[float] = 25.0

# Bound on the scorecard text accumulated from response.text.delta. The create
# already sends max_output_tokens, so this only catches a surface that ignores
# it -- a model writing an essay must not be able to grow a string per delta.
_MAX_REPORT_TEXT_CHARS: Final[int] = 16_000

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
_CLOSE_UNKNOWN_SPECIALIZATION: Final[int] = 4010  # ?specialization= not in the matrix
# The relay could not advance the interview: our own response.create was never
# acknowledged, or was refused twice. Deliberately NOT 4002: 4002 says "upstream
# is unavailable, retry shortly", while this is a working socket on which OUR
# sequencing came apart. The operator diagnosis is different and so is the
# sentence the student reads.
_CLOSE_TURN_STALLED: Final[int] = 4011
# One student already holds interview_max_sessions_per_user live interviews on
# this worker. Deliberately NOT 1013: 1013 says "the server is full, everyone is
# affected, try later", while this says "YOUR other interview is still open" --
# a different sentence for the student and a different diagnosis for the
# operator, who otherwise reads a capacity incident where there is none.
_CLOSE_USER_SESSION_CAP: Final[int] = 4012
_CLOSE_CONSENT_REQUIRED: Final[int] = 4013  # No live consent row for this student
_CLOSE_CONSENT_REVOKED: Final[int] = 4014  # Consent withdrawn mid-interview
# The student has already run interview_max_per_student_per_day interviews in
# the last 24 hours — the VOLUME half of the per-user cap (4012 is the
# concurrency half). Deliberately its own code: "your other interview is still
# open" and "you have done eight today" call for different sentences, and every
# accepted socket bills upstream from the handshake, so the refusal must happen
# before an upstream connection exists. Raised by routers/interview.py's
# _open_records, with the rest of the vocabulary defined here.
_CLOSE_DAILY_CAP: Final[int] = 4015

# NOTE 4013/4014 are defined here, with the rest of the vocabulary, but nothing
# in this module raises them yet: consent enforcement lands in
# routers/interview.py only AFTER the client is posting consent rows, or every
# existing student is locked out of the feature on the deploy that turns it on.
# They live here so the numbers cannot be reassigned in the meantime, and so
# that interview.service.ts has one list to mirror.


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


def _percentile(samples: list[float], fraction: float) -> float | None:
    """Nearest-rank percentile over a handful of samples. None when empty.

    Deliberately not statistics.quantiles: one interview produces at most a few
    dozen ASR measurements, interpolation between two of them says nothing the
    raw rank does not, and this must never raise on n=1 (quantiles does).
    On an even count the rank lands on the UPPER of the middle pair, which is
    the pessimistic read -- the right direction for a number that exists to
    justify a timeout.
    """
    if not samples:
        return None
    ordered = sorted(samples)
    index = min(len(ordered) - 1, int(len(ordered) * fraction))
    return ordered[index]


def _fmt_seconds(value: float | None) -> str:
    """A latency for the summary line: "1.42s", or "-" when nothing was measured."""
    return "-" if value is None else f"{value:.2f}s"


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


# Bounds on what the scorecard may carry into the database and the browser.
# The model was asked for 2-3 strengths and one short paragraph; these are what
# happens when it ignores that, and they are applied on the way IN so no later
# reader has to remember them.
_MAX_REPORT_LIST_ITEMS: Final[int] = 5
_MAX_REPORT_ITEM_CHARS: Final[int] = 300
_MAX_REPORT_PARAGRAPH_CHARS: Final[int] = 1200


def _report_score(value: Any) -> int | None:
    """One 0-100 score, or None when the model did not give a usable one.

    NEVER a fabricated 0. A missing score and a zero mean opposite things to the
    mentor reading the scorecard, and only one of them is a judgement about the
    student -- so an unparseable field stays empty rather than becoming the
    worst possible mark.
    """
    if isinstance(value, bool):
        # bool is an int in Python, and True would clamp to 1/100.
        return None
    if isinstance(value, (int, float)):
        number = int(value)
    elif isinstance(value, str):
        try:
            number = int(float(value.strip()))
        except ValueError:
            return None
    else:
        return None
    return max(0, min(100, number))


def _report_strings(value: Any, max_items: int) -> list[str]:
    """A bounded list of bounded strings, salvaging what is salvageable.

    A model that answers with one string instead of a list is corrected rather
    than rejected: "degrade, never assert" is the whole posture of this parse,
    and losing the entire report over a container type would be the opposite.
    """
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    items: list[str] = []
    for entry in value:
        if not isinstance(entry, str):
            continue
        text = entry.strip()[:_MAX_REPORT_ITEM_CHARS]
        if text:
            items.append(text)
        if len(items) >= max_items:
            break
    return items


def _report_paragraph(value: Any) -> str:
    return value.strip()[:_MAX_REPORT_PARAGRAPH_CHARS] if isinstance(value, str) else ""


def _extract_report_text(response: dict[str, Any]) -> str:
    """The model's text, read from response.done rather than from the deltas.

    One event, atomic, present on both API generations -- so the report cannot
    be half-assembled from a stream that stopped. `type` is "text" on one
    surface and "output_text" on the other, exactly like the audio events.
    """
    parts: list[str] = []
    for item in response.get("output") or []:
        if not isinstance(item, dict):
            continue
        for part in item.get("content") or []:
            if not isinstance(part, dict):
                continue
            if part.get("type") in ("text", "output_text"):
                text = part.get("text")
                if isinstance(text, str):
                    parts.append(text)
    return "".join(parts)


def _parse_report(raw: str) -> dict[str, Any] | None:
    """The model's text -> a validated scorecard, or None if there is not one.

    Defensive by design, because the alternative was a json_schema parameter
    that is unverified on one of the two API generations -- and a rejected
    parameter costs the ENTIRE report. So the JSON is demanded in the
    instructions and salvaged here.

    First "{" to last "}" also strips a ``` fence for free, which is why there
    is no separate fence-stripping step to keep in sync with it.
    """
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        parsed = json.loads(raw[start : end + 1])
    except ValueError:
        return None
    if not isinstance(parsed, dict):
        return None
    report: dict[str, Any] = {
        "overall": _report_score(parsed.get("overall")),
        "communication": _report_score(parsed.get("communication")),
        "domain": _report_score(parsed.get("domain")),
        "structure": _report_score(parsed.get("structure")),
        "strengths": _report_strings(parsed.get("strengths"), _MAX_REPORT_LIST_ITEMS),
        "improvements": _report_strings(parsed.get("improvements"), _MAX_REPORT_LIST_ITEMS),
        "drill": _report_paragraph(parsed.get("drill")),
        "summary": _report_paragraph(parsed.get("summary")),
    }
    if (
        all(report[key] is None for key in ("overall", "communication", "domain", "structure"))
        and not report["summary"]
        and not report["strengths"]
    ):
        # Well-formed JSON that says nothing about the interview is not a
        # report. Calling it one would show the student an empty scorecard and
        # record a success; "unparseable" is the honest answer.
        return None
    return report


@dataclass(slots=True)
class _Pending:
    """One student utterance waiting for its transcript.

    MUTABLE on purpose: the entry is armed at speech_stopped, refined at
    input_audio_buffer.committed (which supplies the item_id) and resolved by
    whichever of .completed / .failed / the deadline arrives first. Rebuilding a
    frozen record at each step would lose the insertion order that makes the
    drain deterministic.

    `status` is "" while unresolved, then exactly one of "ok" / "failed" /
    "timeout" -- and that string is the honest record of WHY a turn has no text,
    which is the whole reason a blank transcript is not simply dropped.
    """

    key: str
    armed_at: float
    deadline_at: float
    item_id: str | None = None
    transcript: str = ""
    status: str = ""

    @property
    def resolved(self) -> bool:
        return bool(self.status)


@dataclass(frozen=True, slots=True)
class _AnswerMeta:
    """What the relay knew about ONE student utterance at the moment it was recorded.

    Set on the session in the statement immediately above the matching
    `_emit_turn` call and consumed there -- NOT passed as a parameter. That is a
    deliberate constraint rather than an oversight: `_emit_turn`'s three
    positional arguments are the seam the relay's own test suite overrides to
    capture emissions with no database and no socket, and growing a fourth
    argument would break every one of those tests to move a value four lines.
    Set it directly above the call, never earlier, and never leave it set: an
    assistant turn reads it as None and means it.
    """

    transcription_status: str
    answer_quality: str | None
    counted_as_answer: bool


@dataclass(frozen=True, slots=True)
class _TurnRecord:
    """The interview context of one turn -- everything a `messages` row cannot carry.

    Handed to the turn writer alongside (sender, text, provider_turn_id) so the
    two inserts happen in one transaction. Frozen because it is composed once,
    at emit time, and read on a worker thread afterwards: a mutable record could
    be rewritten by the next turn while the previous one is still being written.
    """

    seq: int
    phase: str
    transcription_status: str
    answer_quality: str | None
    counted_as_answer: bool
    is_partial: bool


@dataclass(frozen=True, slots=True)
class _ReportRecord:
    """The scorecard, on its way to interview_evaluations. One per interview."""

    status: str
    report: dict[str, Any] | None
    raw_response: str
    model: str


@dataclass(frozen=True, slots=True)
class _SessionOutcome:
    """How an interview ended, for the one UPDATE that closes its record.

    `report_status` is None when the scorecard was never even attempted (the
    session ended before WRAP_UP), which is what the writer turns into an
    evaluation row saying `unavailable` -- a mentor then reads "no report: hit
    the 15-minute cap" instead of a blank screen, and a MISSING row (which says
    nothing at all) never happens.
    """

    status: str
    close_code: int
    terminal_reason: str
    final_phase: str
    answers_accepted: int
    turns_emitted: int
    turns_persisted: int
    upstream_session_id: str | None
    report_status: str | None

    # What was kept of the student's voice. DEFAULTED, so that every existing
    # construction of this record (and its tests) still compiles and still means
    # exactly what it meant: nothing was recorded. `audio_recorded` is the field
    # to branch on and `audio_path` is not -- app/models/interview.py sets out
    # the four different facts a NULL path collapses into one.
    #
    # `audio_truncated` can be True while `audio_recorded` is False: a capture
    # that was stopped before its first flush ended early AND kept nothing, and
    # the two flags say different things about it.
    audio_recorded: bool = False
    audio_path: str | None = None
    audio_bytes: int | None = None
    audio_duration_ms: int | None = None
    audio_truncated: bool = False


class _TurnWriteRefused(Exception):
    """The conversation this interview writes into no longer accepts turns.

    Raised by the turn writer in routers/interview.py when
    conversations.append_message refuses (the student cleared the thread from
    another tab, or retention purged it mid-call). That function's CALL-SITE
    CONTRACT says a fire-and-forget writer must let the refusal reach its own
    `except Exception` -- where the connection id and the provider turn id are --
    and then END THE SESSION, because both realtime callers resolve
    conversation_id once at socket open and reuse it for fifteen minutes, so one
    dropped-turn line per turn for the rest of the call is noise wrapped around a
    record that is already lost.

    It is a relay-owned type rather than `conversations.ConversationGone`
    reaching in here for one reason: this module imports no ORM model and no
    database code AT ALL (see the header, and rule 1), and that is what lets
    tests/test_interview_relay.py drive the whole turn protocol with no Postgres.
    The writer translates at the boundary where it already holds a Session. It is
    NOT a swallow -- the refusal is neither ignored nor folded into the
    IntegrityError branch, which is exactly what that contract forbids.
    """


@dataclass(frozen=True, slots=True)
class _DeferredTurn:
    """A response.create that had to wait because one was already in flight.

    Carries the KIND, not a bare bool: by the time the in-flight response ends,
    "ask the next question" and "you did not hear that, ask again" need
    different instructions, and a boolean would send the wrong one.
    """

    kind: str


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


# What refused an acquire, or "" for success. Two caps share one call because a
# two-step acquire is a leak waiting to happen: the first step succeeds, the
# second refuses, and the slot the first took is released only on the paths
# somebody remembered.
_REFUSED_BY_WORKER: Final[str] = "worker"
_REFUSED_BY_USER: Final[str] = "user"


class _ConnectionLimiter:
    """Per-worker AND per-user caps on concurrent interviews, without ever blocking.

    A student who cannot start must be TOLD so (close 1013 / 4012) rather than
    queued: queueing shows a spinner while their slot is not running, and the
    15-minute cap they are waiting for has not started either.

    THE PER-USER DICT IS THE POINT (audit H1). The worker cap counts sessions and
    never asks whose they are, so one student looping
    `new WebSocket('/api/interview')` from devtools took every slot on the worker
    and everyone else was answered 1013. Each of those sockets authenticates,
    opens an upstream Realtime session and BILLS from the handshake's
    response.create with no microphone input at all -- so the abuse is cheap to
    mount, expensive to absorb, and looks exactly like a capacity incident.

    Deliberately NOT routers/voice.py's `_TOKEN_GRANTS.try_acquire(user_id,
    limit)`, which was written for the same rule one layer up and is not reusable
    here: that one is a TTL-EXPIRING GRANT for a stateless token nobody holds,
    while this is a HELD resource with an explicit release. Reusing it would mean
    a slot that expires while its socket is still open.

    asyncio.Semaphore has no acquire_nowait(), so the test and the increment are
    written out. There is no await between them and asyncio is single-threaded,
    which makes the pair atomic by construction -- no lock is needed or useful.
    (routers/voice.py's version DOES take a lock because it is called from
    threadpooled sync endpoints; this one only ever runs on the event loop.)
    """

    __slots__ = ("_limit", "_per_user_limit", "_active", "_by_user")

    def __init__(self, limit: int, per_user_limit: int) -> None:
        self._limit = limit
        self._per_user_limit = per_user_limit
        self._active = 0
        self._by_user: dict[str, int] = {}

    def try_acquire(self, user_id: str) -> str:
        """Take a slot for `user_id`. Returns "" on success, else which cap refused.

        The worker cap is checked FIRST: when the process is genuinely full, the
        honest answer is "the server is full", not "you have too many" -- a
        student holding one legitimate interview would otherwise be told they
        were the problem.
        """
        if self._active >= self._limit:
            return _REFUSED_BY_WORKER
        held = self._by_user.get(user_id, 0)
        if held >= self._per_user_limit:
            return _REFUSED_BY_USER
        self._active += 1
        self._by_user[user_id] = held + 1
        return ""

    def release(self, user_id: str) -> None:
        # Guard against a double release turning the counter negative, which
        # would quietly raise the effective cap above the configured one.
        if self._active > 0:
            self._active -= 1
        held = self._by_user.get(user_id, 0)
        if held <= 1:
            # POPPED, not left at zero. Keyed by user id, this dict would
            # otherwise gain one permanent entry per student who ever interviewed
            # on this worker -- a slow leak on a process designed to run for
            # weeks, and one no test would ever notice.
            self._by_user.pop(user_id, None)
        else:
            self._by_user[user_id] = held - 1

    def active_for(self, user_id: str) -> int:
        return self._by_user.get(user_id, 0)

    @property
    def active(self) -> int:
        return self._active

    @property
    def limit(self) -> int:
        return self._limit

    @property
    def per_user_limit(self) -> int:
        return self._per_user_limit


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
        "_gate_closes",
        "_turns_user",
        "_turns_assistant",
        "_last_error",
        "_asr_samples",
        "_speech_stopped_at",
        # -- v3 turn ownership. Each of these exists because the relay, not the
        # upstream VAD, now decides when the interviewer speaks.
        "_pending",
        "_pending_seq",
        "_resolved_items",
        "_abandoned_turns",
        "_question_open",
        "_partial_question",
        "_deferred",
        "_clarifications",
        "_unheard_streak",
        "_expecting_response",
        "_create_deadline",
        "_create_retries",
        "_failed_recreates",
        "_pending_create_ids",
        "_last_create_kind",
        "_server_created_response",
        "_bargein_thrash",
        "_bargein_disabled",
        "_response_spoke",
        "_wrap_up_deadline",
        "_verdict_retried",
        "_awaiting_candidate_questions",
        "_verdict_requested",
        "_report_requested",
        "_expecting_report",
        "_report_create_id",
        "_report_response_id",
        "_report_settled",
        "_report_deadline",
        "_report_text",
        "_report_status",
        "_report_raw",
        "_on_turn",
        "_on_report",
        "_on_finalize",
        "_on_heartbeat",
        "_turn_seq",
        "_turns_persisted",
        "_answers_accepted",
        "_answer_meta",
        "_heartbeat_at",
        "_finalized",
        "_writes",
        "_recorder",
        "_assistant_text",
        "_machine",
    )

    def __init__(
        self,
        websocket: WebSocket,
        conn_id: str,
        on_turn: Callable[[str, str, str, _TurnRecord], None] | None = None,
        specialization: Specialization | None = None,
        on_report: Callable[[_ReportRecord], None] | None = None,
        on_finalize: Callable[[_SessionOutcome], None] | None = None,
        on_heartbeat: Callable[[], None] | None = None,
        recorder: Any | None = None,
    ) -> None:
        self._ws = websocket
        self._conn_id = conn_id
        # The Specialization Matrix row this interview runs under, and the
        # state machine tracking which phase of it we are in. None means the
        # generic interview that predates the matrix: the persona below stays
        # byte-for-byte what it was, and no phase updates are pushed.
        self._machine = InterviewStateMachine(specialization)
        # THE FOUR DATABASE HOOKS, and the only ones. This module imports no ORM
        # model, no Session and no app.conversations -- rule 1's containment is
        # structural, not a convention -- so everything it writes leaves through
        # a callable routers/interview.py supplies. All four are SYNCHRONOUS and
        # allowed to block: this class runs each on a worker thread via
        # asyncio.to_thread, because app/conversations.py is synchronous
        # SQLAlchemy and calling it inline would stall the event loop -- i.e.
        # every other student's audio on this worker -- for a whole round trip to
        # Postgres. All four are None in the relay's own tests, which is what
        # lets those tests drive the entire turn protocol with no database.
        #
        #   _on_turn      (sender, text, provider_turn_id, _TurnRecord) per FINAL
        #                 turn. FIRE-AND-FORGET; failures never reach the pumps
        #                 (see _emit_turn) except the one refusal that must end
        #                 the session, _TurnWriteRefused.
        #   _on_report    (_ReportRecord) once, AWAITED -- see _finish_report.
        #   _on_finalize  (_SessionOutcome) once, AWAITED, after the last turn
        #                 write has drained -- see _finalize_session.
        #   _on_heartbeat () roughly once a minute from the watchdog, fire-and-
        #                 forget, so a killed worker's rows can be swept.
        self._on_turn = on_turn
        self._on_report = on_report
        self._on_finalize = on_finalize
        self._on_heartbeat = on_heartbeat
        # THE AUDIO RECORDER, and the fifth thing that leaves this class -- but
        # deliberately NOT a fifth hook. It is an object with three methods
        # (`feed(track, pcm)`, `snapshot()`, `await aclose()`), supplied by
        # routers/interview.py from app.interview_audio.recorder_for(), and it is
        # None in every deployment where recording is off or the student has not
        # granted scope_store_audio -- which today is all of them.
        #
        # Duck-typed, and this module does NOT import app.interview_audio: that
        # module reads `interview_consents` to decide whether it may exist at
        # all, and importing it here would put an ORM model behind the relay's
        # import graph for the first time. The header's "nothing here imports any
        # ORM model, and that is the point" is a rule 1 containment argument, not
        # a stylistic one, and a recording feature is not the thing to spend it
        # on. The cost is a `typing.Any` and a contract written down instead of
        # checked; the tests supply their own object with the same three methods.
        #
        # `feed` is TOTAL by its own contract -- it never raises and never does
        # I/O -- and _capture() below wraps it anyway, because an interview must
        # never end over a file.
        self._recorder = recorder
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
        # Times the browser reported its echo gate SHUT. Roughly one per model
        # response is normal (one close, one open); a count far above the number
        # of responses means the gate is thrashing, and a count of zero on a
        # session that reported self-talk means the gate was never armed at all.
        self._gate_closes = 0

        # Counted where a turn is EMITTED, so these are turns handed to the
        # persistence path -- the number the AGENTS.md voice runbook's "the call
        # sounded fine and saved nothing" query is checked against. Both at zero
        # is the interview never getting going at all.
        #
        # BLANK TURNS ARE COUNTED TOO, since L4: a timed-out transcript still
        # produces an interview_turns row, and their sum has to stay comparable
        # with _turns_persisted or `emitted - persisted` stops meaning "dropped"
        # (persisted could even exceed emitted). The cost is that "assistant
        # turns and zero user turns" no longer diagnoses a dead transcriber on
        # its own -- that now shows as user turns with no text, and the summary
        # line names it directly with asrP50=- and error=transcriber:timeout.
        self._turns_user = 0
        self._turns_assistant = 0
        # Turn writes that actually reached Postgres. The PAIR
        # (turns_emitted, turns_persisted) on the interview_sessions row is what
        # answers "the call sounded fine and saved nothing" with no join and no
        # query against `messages`: emitted > persisted is exactly how many turns
        # the fire-and-forget writer dropped, and that number used to be
        # recoverable only by counting log lines.
        self._turns_persisted = 0
        # 1-based, in EMIT order, and incremented for every turn including the
        # blank ones -- a gap in `seq` would read as a lost turn when it is
        # actually a turn the transcriber never heard (L4).
        self._turn_seq = 0
        # Accepted answers, counted HERE and not read off the state machine,
        # because the machine's own counter only moves for a specialized
        # interview (the phase tick is gated on one). The generic interview has
        # no arc and would otherwise record zero answers however well it went.
        self._answers_accepted = 0
        # See _AnswerMeta: set immediately above a student `_emit_turn` and
        # consumed there. None means "an interviewer turn", and it means it.
        self._answer_meta: _AnswerMeta | None = None
        # The last upstream failure seen, already reduced to type/code (never
        # error.message, which can quote request content back at us). Kept so
        # the summary line can name a cause instead of a support ticket saying
        # "it just sounded bad".
        self._last_error: str | None = None

        # ASR round-trip telemetry: monotonic seconds from the end of the
        # student's speech to their transcript landing. Measured BEFORE it
        # became load-bearing, on purpose. Under v3 the relay waits for this
        # transcript before asking the next question, so T_asr is added to
        # every turn's silence in series -- and interview_transcription_timeout_ms
        # (8000) is a guess until a cohort of real interviews reports these two
        # numbers on the end-of-interview line. A guessed deadline that is too
        # low turns good long answers into "unheard"; too high and a dead
        # transcriber holds the student in silence for eight seconds a turn.
        # Bounded by the number of student utterances in one capped session.
        self._asr_samples: list[float] = []
        # Armed at input_audio_buffer.speech_stopped, consumed by whichever
        # transcription result resolves the turn. None means "no utterance is
        # outstanding", which is also why a duplicate result cannot double-count.
        self._speech_stopped_at: float | None = None

        # -- v3 turn state. The invariant each one protects is in the design
        # doc's state table; the short version is here.
        #
        # Student utterances waiting for a transcript, INSERTION-ORDERED, which
        # is what makes the drain commit-ordered. Resolution is a pop from the
        # head, and that pop is the single point of consumption: a .completed
        # and its own deadline can both fire, and the loser finds nothing.
        self._pending: dict[str, _Pending] = {}
        self._pending_seq = 0
        # Item ids already drained. Without it, a duplicate .completed for a
        # turn we have finished would arm a NEW entry and ask a second question.
        # An insertion-ordered dict used as an ordered set, so the cap can evict
        # the oldest id instead of refusing the newest -- see _memoise_resolved.
        self._resolved_items: dict[str, None] = {}
        # Utterances the answer deadline gave up on BEFORE upstream told us
        # their item_id -- which, under create_response:false, is every timeout
        # on a surface that does not send input_audio_buffer.committed. There is
        # no id to memoise for those, so the duplicate guard has nothing to
        # match on and a late transcript would resurrect the turn. One credit is
        # spent per late result that matches nothing. See _resolve_pending.
        self._abandoned_turns = 0
        # Was a question actually ASKED? Only an answer to a question that was
        # asked may advance the arc -- an interjection over an unfinished
        # question is not an answer, and counting it re-introduces the bug this
        # engine exists to remove, from the other direction.
        self._question_open = False
        # The last interviewer turn was cut off by barge-in rather than
        # finished. Recorded so the transcript can say "asked" or "cut off".
        self._partial_question = False
        # A create that would have collided with a live response.
        self._deferred: _DeferredTurn | None = None
        # Re-asks spent on the CURRENT question. Reset on every accepted answer.
        # The cap is what guarantees the arc terminates: a student who genuinely
        # cannot answer must not be trapped on question two until the hard cap.
        self._clarifications = 0
        # Consecutive turns whose transcript never arrived, so the summary line
        # can name a failing transcriber instead of leaving it to a query.
        self._unheard_streak = 0
        # Our own response.create is outstanding. Also the D2 detector: a
        # response.created arriving while this is False was created by the
        # server, which means create_response:false did not take.
        self._expecting_response = False
        self._create_deadline: float | None = None
        self._create_retries = 0
        self._failed_recreates = 0
        # Every response.create of ours that upstream has neither acknowledged
        # nor refused, oldest first. A LIST and not one id: _retry_create sends
        # a second create for the same turn, and a single field meant the retry
        # disowned the create it was retrying -- so when the original was
        # acknowledged late (which is exactly what upstream congestion, the
        # cause of the retry, produces) the relay owned an outstanding create it
        # could no longer recognise. The retry's rejection then fell through to
        # the generic reep.error forward and put a warning banner in front of a
        # student mid-interview, and the retry's own response.created tripped
        # the D2 detector against itself. Capped at _MAX_OUTSTANDING_CREATES.
        self._pending_create_ids: list[str] = []
        self._last_create_kind = "next"
        self._server_created_response = False
        self._bargein_thrash = 0
        self._bargein_disabled = False
        # Did the CURRENT response make a sound before it ended? A response
        # cancelled before it spoke is the signature of a room where VAD fires
        # on the interviewer's own voice.
        self._response_spoke = False
        # The final report. _report_response_id is what keeps the scorecard out
        # of the student's chat and safe from their own voice; _report_settled
        # is what stops the deadline and the response.done both settling it.
        self._report_requested = False
        self._expecting_report = False
        self._report_create_id: str | None = None
        self._report_response_id: str | None = None
        self._report_settled = False
        self._report_deadline: float | None = None
        self._report_text = ""
        self._report_status: str | None = None
        # The model's exact output, kept for a DIRECTOR to look at when a parse
        # goes wrong -- a bad scorecard is nearly always a prompt problem rather
        # than a code one, and without the raw text there is nothing to read.
        # Truncated and DIRECTOR/ADMIN-scoped downstream: it is the model's
        # private words about a named student.
        self._report_raw = ""
        # Finalization runs exactly once (Layer 1). The router's backstop
        # (Layer 2) is idempotent against it by predicate -- `WHERE
        # status='running'` -- rather than by this flag, because the two live in
        # different objects and the backstop must still work when this one never
        # ran at all.
        self._finalized = False
        # Monotonic stamp of the last heartbeat write, seeded so the first one
        # is due a full interval in rather than on the watchdog's first tick:
        # the row was inserted with heartbeat_at = now() moments ago.
        self._heartbeat_at = now

        # S8: force the wrap-up while there is still time to deliver a verdict
        # AND generate the scorecard. Without it a five-answer interview can hit
        # the hard cap mid-verdict and produce nothing at all -- the exact tail
        # of the bug this engine was built to fix. Disarmed when the cap is too
        # short for the reserve to mean anything (a test, a deliberate stub),
        # because forcing a verdict in the first seconds would replace the
        # interview rather than rescue it.
        reserve = settings.interview_report_timeout_ms / 1000 + _REPORT_RESERVE_EXTRA_S
        cap = float(settings.interview_max_seconds)
        self._wrap_up_deadline = now + cap - reserve if cap > reserve * 2 else None
        self._verdict_retried = False
        # The two-beat close. WRAP_UP is now reached one turn BEFORE the
        # verdict: the tick into WRAP_UP creates an "any questions for us?"
        # turn (invite_questions) and arms the first flag; the student's reply
        # -- ANY reply, bypassing classify_answer, because "no, I'm good" is
        # filler words to the word gate and must not earn a clarify loop --
        # clears it, sets _verdict_requested, and only THAT turn's
        # response.done may trigger the scorecard. The forced/clock path skips
        # the beat and sets _verdict_requested directly.
        self._awaiting_candidate_questions = False
        self._verdict_requested = False

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
        # Last one wins: a session that errored twice ends on the more recent
        # cause, and the full history is already in the lines above. type/code
        # only, for the reason the downstream reep.error carries only those.
        self._last_error = f"{phase}:{err.get('type')}/{err.get('code')}"

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

    def _instructions(self) -> str:
        """The instructions for the CURRENT phase of this interview.

        The generic interview (no specialization) keeps _INTERVIEWER_PERSONA
        byte-for-byte -- it is VERBATIM product spec, and composing it with a
        matrix row is the only permitted way to extend it. build_instructions
        puts the base persona first and unchanged for exactly that reason.
        """
        spec = self._machine.specialization
        if spec is None:
            return _INTERVIEWER_PERSONA
        return build_instructions(spec, _INTERVIEWER_PERSONA, self._machine.phase)

    def _session_voice(self) -> str:
        """The voice for the single startup session.update.

        A specialization speaks with its own voice (the matrix row's -- a CHRO
        does not sound like a CFO); the generic interview keeps the
        operator-configured OPENAI_REALTIME_VOICE. That one is
        operator-supplied, so it is validated against the known set here and
        falls back to "alloy" WITH A LOG LINE: upstream answers an unknown
        voice with a silent fallback to its own default, and the interview
        then runs fine while sounding nothing like what was configured.
        """
        spec = self._machine.specialization
        if spec is not None:
            return spec.voice
        voice = settings.openai_realtime_voice.strip().lower()
        if voice in KNOWN_REALTIME_VOICES:
            return voice
        self._log.warning(
            "OPENAI_REALTIME_VOICE=%r is not a known Realtime voice; using 'alloy'",
            settings.openai_realtime_voice,
        )
        return "alloy"

    def _session_update_payload(self) -> dict[str, Any]:
        """The single session.update, in whichever shape this API generation wants.

        Sent once at startup and never repeated: `voice` is frozen the moment
        the model has emitted any audio, so a later change is simply rejected.
        Mid-session PHASE changes use _phase_update_payload instead, which
        carries instructions and nothing else.
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
            # THE RELAY creates the response, not the upstream VAD. This one
            # literal is what the whole v3 turn protocol turns on.
            #
            # With `true`, upstream created the next question at the instant it
            # committed the input buffer -- which is BEFORE the student's
            # transcript exists. The relay could not check whether the answer
            # was substantive, could not count it, and its phase directive
            # therefore always steered the question AFTER next; at the end of
            # the arc the model asked a sixth question instead of delivering the
            # verdict, and if the session cap landed first there was no verdict
            # at all. No prompt wording fixes that: instructions are the CONTENT
            # of a response, and this flag decides how many responses exist and
            # when.
            #
            # WHAT DOES NOT CHANGE: server VAD still COMMITS the input buffer,
            # so this relay still never sends input_audio_buffer.commit -- a
            # manual commit would race the automatic one, which is what the old
            # comment here was protecting and it is still true. Only response
            # creation moved, and it moved to exactly one call site,
            # _advance_turn.
            #
            # The failure mode to fear is now the opposite one: creating a
            # response while another is live earns
            # `conversation_already_has_active_response` and a warning banner
            # mid-interview, which is why _advance_turn defers instead of
            # sending whenever _active_response_id is set.
            "create_response": False,
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

        # ONE object, embedded verbatim into whichever shape this generation
        # wants, so the two surfaces can never drift onto different transcribers.
        # Whisper has always been on here -- what was missing was a way to move
        # off "whisper-1" (the legacy id) without a redeploy. A bad value is
        # rejected at session.update and _await_upstream_event closes 4002; it
        # does not degrade into an interview with no student transcript.
        transcription: dict[str, Any] = {"model": settings.transcription_model}

        voice = self._session_voice()
        # INTERVIEW_TEMPERATURE, sent on BOTH shapes but ONLY when the operator
        # set it: this codebase's posture is that unverified parameters stay
        # off the wire, so the default is the model's own. The validator has
        # already bounded it to 0.0-2.0.
        temperature = settings.interview_temperature

        if settings.realtime_beta_header:
            # Beta: flat session object. "text" must accompany "audio" here or
            # the assistant transcript is never emitted. audio.output.speed is
            # a GA-only parameter and is NEVER sent on this shape.
            payload = {
                "modalities": ["text", "audio"],
                "instructions": self._instructions(),
                "voice": voice,
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "input_audio_transcription": transcription,
                "turn_detection": turn_detection,
            }
            if temperature is not None:
                payload["temperature"] = temperature
            return payload

        # GA: nested session object. session.type is REQUIRED here -- without it
        # the whole object is rejected and the interview silently runs on default
        # instructions.
        output: dict[str, Any] = {
            "format": {"type": "audio/pcm", "rate": _AUDIO_SAMPLE_RATE_HZ},
            "voice": voice,
        }
        # audio.output.speed is confirmed GA-supported, but still sent only when
        # the operator moved it off 1.0 -- a stock session's payload stays
        # minimal, and every field on the wire is a field that can be rejected.
        if settings.interview_voice_speed != 1.0:
            output["speed"] = settings.interview_voice_speed
        payload = {
            "type": "realtime",
            "instructions": self._instructions(),
            "output_modalities": ["audio"],
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": _AUDIO_SAMPLE_RATE_HZ},
                    "turn_detection": turn_detection,
                    # Without this, the student's side is never transcribed and
                    # there is nothing to show or store.
                    "transcription": transcription,
                },
                "output": output,
            },
        }
        if temperature is not None:
            payload["temperature"] = temperature
        return payload

    def _phase_update_payload(self) -> dict[str, Any]:
        """An instructions-ONLY session.update, for a mid-interview phase change.

        Deliberately minimal: `voice` is frozen once the model has spoken and
        re-sending the full session object asks the API to re-validate fields
        that cannot change. Instructions are the one field a phase transition
        exists to replace, on both API generations.
        """
        if settings.realtime_beta_header:
            return {"instructions": self._instructions()}
        return {"type": "realtime", "instructions": self._instructions()}

    async def _push_phase(self, upstream: ClientConnection) -> None:
        """Tell the model the interview moved phase, and the browser too.

        The session.update reaches the model between turns and steers its NEXT
        question; the reep.phase event lets the UI name the phase the student
        is in. Neither blocks the audio path -- both are ordinary sends from
        the upstream pump, which owns all downstream writes.
        """
        phase = self._machine.phase
        self._log.info("Interview phase advanced to %s", phase)
        await upstream.send(
            json.dumps(
                {
                    "type": "session.update",
                    "event_id": self._next_event_id("phase"),
                    "session": self._phase_update_payload(),
                }
            )
        )
        spec = self._machine.specialization
        await self._send_control(
            {
                "type": "reep.phase",
                "phase": phase.value,
                "specialization": spec.label if spec is not None else None,
            }
        )

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

        # THE FIRST of this relay's own response.create calls; every later one
        # comes from _advance_turn. Under create_response:false there is no VAD
        # path that could ever produce a first response, so removing this is a
        # guaranteed dead interview -- it is more necessary now, not less.
        # `instructions` is deliberately omitted: supplying it here REPLACES the
        # session persona for this response instead of adding to it, which would
        # drop the persona on precisely the turn that sets the tone, and the
        # OPENING directive already reached the model in the session.update above.
        open_event_id = self._next_event_id("open")
        await upstream.send(
            json.dumps(
                {
                    "type": "response.create",
                    "event_id": open_event_id,
                    "response": {"conversation": "auto"},
                }
            )
        )
        # Armed here rather than in _advance_turn because this send bypasses it.
        # If upstream drops this one create the student meets silence and every
        # guardrail we have measures AUDIO, not questions -- the browser keeps
        # sending frames, so the idle watchdog never fires.
        self._pending_create_ids.append(open_event_id)
        self._last_create_kind = "next"
        self._expecting_response = True
        self._create_deadline = time.monotonic() + self._create_timeout_s()

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
                # The matrix row this interview runs under (None for the
                # generic interview) and the state machine's starting phase,
                # so the UI can name both from the first frame.
                "specialization": (
                    self._machine.specialization.label
                    if self._machine.specialization is not None
                    else None
                ),
                "phase": self._machine.phase.value,
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
        if "create_response" not in value:
            # This surface did not echo the field, so we cannot know whether it
            # took. Not fatal -- refusing here would break every deployment on a
            # surface that simply echoes less -- but it hands the whole job to
            # the runtime guard in _handle_upstream_event, which detects a
            # server-created response positionally and skips our own create for
            # that turn. Degraded to today's behaviour, not doubled.
            self._log.warning(
                "session.updated did not echo turn_detection.create_response; "
                "relying on the runtime guard to detect server-created responses"
            )
            return
        if value["create_response"] is not False:
            # The one upstream behaviour that cannot be verified from here, and
            # the one whose failure is worst: both parties creating a response
            # means two questions per turn, which is the exact bug v3 removes,
            # doubled. Refusing the session beats running a known-double
            # interview in front of a student.
            self._log.error(
                "session.update was not applied: turn_detection.create_response "
                "echoed back as %r. Upstream would create a second response per "
                "turn, so the interview would ask two questions at a time.",
                value["create_response"],
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

        # Captured AFTER the oversize drop and AFTER the odd-byte carry, so the
        # file holds exactly the samples the model was given -- a recording that
        # disagrees with what upstream heard is worse than no recording, because
        # it is a plausible one. Zero cost when nothing is recording (an
        # attribute load and a branch) and no I/O when something is: see
        # app/interview_audio.py.
        self._capture(_AUDIO_TRACK_STUDENT, pcm)

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
            if self._recorder is not None:
                # CAPTURED HERE TOO. This branch forwards audio byte-identical
                # to the binary path's and used to skip _capture entirely, so a
                # `?uplink=base64` client produced an interviewer track, NO
                # student track, and a snapshot still claiming recorded=True --
                # a DIRECTOR opens it and hears the interviewer talking to
                # silence, indistinguishable from a student who never spoke. A
                # plausible recording that disagrees with what upstream heard is
                # worse than no recording, which is the rule _forward_client_audio
                # states and this branch broke.
                #
                # Capture, rather than refusing the mode while recording: the
                # mode works, the shipped Angular client does not use it, and
                # breaking a working client to protect a file is the wrong trade.
                # The decode is the one allocation this path did not already
                # make, and only when something is actually recording -- the
                # forward upstream stays a passthrough with no round trip.
                try:
                    self._capture(
                        _AUDIO_TRACK_STUDENT, base64.b64decode(audio, validate=True)
                    )
                except (BinasciiError, ValueError) as exc:
                    # The alphabet and length checks above already ran, so this
                    # is padding in the wrong place. The frame still goes
                    # upstream: what the model hears matters more than the file.
                    self._log.warning(
                        "Could not decode an append frame for the recording: %s", exc
                    )
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

        if etype == _CLIENT_GATE:
            # Counted only. See _CLIENT_GATE: this frame deliberately touches
            # neither the append buffer nor the idle clock.
            if event.get("state") == "suppressed":
                self._gate_closes += 1
            return

        key = f"client:{etype}"
        if key in self._logged_unknown:
            return
        if len(self._logged_unknown) >= _MAX_LOGGED_CLIENT_TYPES:
            # Memo full. A client inventing new type strings has stopped being
            # diagnostic information and started being log volume.
            return
        self._logged_unknown.add(key)
        self._log.info("Ignoring unsupported control event from browser: %s", etype)

    async def _pump_upstream_to_client(self, upstream: ClientConnection) -> None:
        """OpenAI -> browser. The only task that writes downstream.

        ONE recv() at a time is still mandatory -- concurrent recv() on a single
        ClientConnection raises RuntimeError -- which is exactly why this loop
        must not become two. It used to be `async for raw in upstream`, and the
        reason it no longer is: under v3 the relay owns turn state that has to
        AGE OUT (a transcript that never lands, a response.create upstream never
        acknowledged), and the handler for those deadlines both mutates turn
        state and sends downstream. Running it from the watchdog would make the
        watchdog a second downstream sender -- breaking the invariant documented
        above _send_control -- and would turn the pop-based double-fire guard in
        _drain_pending from a proof into a hope, because two tasks could then
        reach the same entry. So the deadline is enforced by the one task that
        already owns both: this one, between reads.

        Cost, stated honestly: the wrap-up reserve is armed for the whole
        session, so in practice there IS a timeout on nearly every iteration --
        one heap entry armed and cancelled per upstream event. That is an order
        of magnitude cheaper than the json.loads two lines below it, and it is
        NOT the per-audio-frame timer the watchdog's comment argues against:
        upstream events are tens per second, not thousands. When no deadline at
        all is armed the recv() blocks exactly as it did before v3.
        """
        while True:
            deadline = self._earliest_deadline()
            try:
                if deadline is None:
                    raw = await upstream.recv()
                else:
                    # A RELATIVE timeout rather than asyncio.timeout_at: these
                    # deadlines are time.monotonic() stamps, and timeout_at
                    # wants the event loop's clock. They are the same clock on
                    # CPython's default loop today, which is precisely the kind
                    # of coincidence that stops holding on someone else's
                    # runner. Cancelling a recv() is documented safe by
                    # websockets and loses no frames.
                    async with asyncio.timeout(max(0.0, deadline - time.monotonic())):
                        raw = await upstream.recv()
            except TimeoutError:
                await self._on_deadline()
                continue
            except ConnectionClosedOK:
                # What `async for` used to swallow for us. A ConnectionClosedError
                # still propagates to the except* clause in _interview, which is
                # where the code and reason are logged.
                break
            await self._handle_upstream_event(json.loads(raw))

        # A CLEAN upstream close. Mid-interview that is still the service
        # hanging up on us, not a normal finish -- the normal finish is driven
        # by the student, the report or the watchdog and never gets here.
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
            # The student stopped talking, so the ASR clock starts and, with it,
            # the deadline that guarantees this turn ends one way or another.
            # Armed HERE and not at input_audio_buffer.committed on purpose:
            # whether `committed` still arrives under create_response:false is
            # unverified, and a turn whose only timer depends on an unverified
            # event is a turn that can hang forever. Server VAD still commits;
            # this relay still sends no manual commit.
            self._arm_answer_deadline()
            await self._send_control({"type": "input_audio_buffer.speech_stopped"})
            return

        if etype == _INPUT_COMMITTED:
            # Refinement only -- see _INPUT_COMMITTED. Not forwarded: the
            # browser has already been told the student stopped speaking, and an
            # item id means nothing to it.
            self._refine_pending(event.get("item_id"))
            return

        if etype == "response.created":
            response = event.get("response") or {}
            response_id = response.get("id")
            self._active_response_id = response_id
            self._response_spoke = False

            if self._expecting_report and self._report_response_id is None:
                # The scorecard. Learned here because Realtime does not echo our
                # event_id on response.created, so the id has to be taken
                # positionally -- which is safe for exactly one response,
                # because nothing else is created while the report is pending.
                self._expecting_report = False
                self._report_response_id = response_id
                # NOT forwarded. The browser turns response.created into
                # "the interviewer is speaking", and the scorecard is silent:
                # the student would watch a speaking indicator for up to twenty
                # seconds of nothing, which reads as a hang.
                return

            if self._expecting_response:
                self._expecting_response = False
                self._create_deadline = None
                self._create_retries = 0
                # ONE response.created answers the OLDEST create still
                # outstanding, and only that one. Realtime does not echo our
                # event_id here, so the attribution is positional -- but
                # forgetting every outstanding id (which is what clearing a
                # single field did) leaves a retry the relay can no longer
                # recognise, and an error naming it then reaches the student as
                # a banner. A retry is the same question again, never a second
                # one, so re-sending on a rejection cannot ask twice either.
                if self._pending_create_ids:
                    self._pending_create_ids.pop(0)
            elif self._pending_create_ids:
                # Our own create, acknowledged late -- typically the original
                # that _retry_create had already given up on, arriving after the
                # retry. NOT server-created: reading it as one accuses
                # turn_detection.create_response=false of not being in effect,
                # which §2.6 names as the one upstream behaviour that cannot be
                # verified from here, on the strength of our own retry -- and
                # then _advance_turn consumes the flag and skips the relay's
                # next create, costing the student a question on top of a false
                # diagnosis.
                self._pending_create_ids.pop(0)
                self._log.warning(
                    "response.created %s answers a create this relay had "
                    "already retried; not counting it as server-created",
                    response_id,
                )
            else:
                # D2, the runtime half. Nothing we sent is outstanding, so
                # upstream created this response by itself and
                # create_response:false did not take on this surface. The
                # correlation is positional and therefore a heuristic -- good
                # enough to detect and log, which is the point. _advance_turn
                # reads the flag and skips our own create for that turn, so the
                # interview degrades to the pre-v3 behaviour instead of asking
                # two questions at once.
                self._server_created_response = True
                self._last_error = "vad:server_created_response"
                self._log.error(
                    "Upstream created response %s that this relay did not ask "
                    "for: turn_detection.create_response=false is not in effect",
                    response_id,
                )

            await self._send_control(
                {"type": "response.created", "response_id": self._active_response_id}
            )
            return

        if etype in _TEXT_DELTA_TYPES:
            # Accumulated ONLY as the fallback for a surface that hands back an
            # empty `output` array on response.done, and only for the scorecard.
            # Nothing depends on these arriving, and none of it is forwarded:
            # the student's chat is not the place for raw JSON.
            if (
                self._report_response_id is not None
                and event.get("response_id") == self._report_response_id
                and len(self._report_text) < _MAX_REPORT_TEXT_CHARS
            ):
                self._report_text += str(event.get("delta") or "")
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

        if etype == _USER_TRANSCRIPT_DELTA:
            # Live captions for the student's OWN speech, keyed by item_id so
            # the browser can revise one pending "You" line in place. NEVER
            # persisted and never fed to the arc: the .completed event below
            # remains the single point where a student turn is recorded or
            # judged. Forwarded under a reep.* alias rather than the upstream
            # name because the allowlist's whole job is that upstream event
            # names do not reach the browser unreviewed.
            item_id = event.get("item_id")
            delta = event.get("delta", "")
            if item_id and delta:
                await self._send_control(
                    {
                        "type": "reep.transcript.delta",
                        "item_id": item_id,
                        "delta": delta,
                    }
                )
            return

        if etype == _USER_TRANSCRIPT_DONE:
            # Forwarded under the UPSTREAM name, not a reep.* alias. The clients
            # switch on the Realtime event names, so a rename matched no case,
            # fell through to `default:`, and left the "You" half of the
            # transcript permanently empty with nothing logged anywhere.
            #
            # It no longer emits the turn or ticks the machine directly: this is
            # one of three ways a pending entry can resolve, and doing the work
            # here would mean the other two (.failed, the deadline) had to
            # duplicate it. The drain is the one place a resolved turn is acted on.
            item_id = event.get("item_id")
            transcript = event.get("transcript", "")
            self._resolve_pending(item_id, transcript, "ok")
            await self._send_control(
                {
                    "type": _USER_TRANSCRIPT_DONE,
                    "item_id": item_id,
                    "transcript": transcript,
                }
            )
            await self._drain_and_advance()
            return

        if etype == _USER_TRANSCRIPT_FAILED:
            # The turn is over for us either way: the audio is committed
            # upstream and no transcript is coming. Resolved with an empty
            # string and status "failed", which the interviewer answers by
            # asking the student to say it again -- rather than the pre-v3
            # behaviour, where this event was not in the allowlist at all and
            # the answer simply vanished from the record.
            #
            # Deliberately NOT forwarded downstream: error.message can quote
            # request content back at us, the clients handle neither this event
            # nor a redacted version of it, and the student learns what happened
            # from the interviewer asking them to repeat.
            err = event.get("error") or {}
            self._log.error(
                "Input transcription failed for item %s: type=%s code=%s",
                event.get("item_id"),
                err.get("type"),
                err.get("code"),
            )
            self._last_error = f"transcription:{err.get('type')}/{err.get('code')}"
            self._resolve_pending(event.get("item_id"), "", "failed")
            await self._drain_and_advance()
            return

        if etype == "response.done":
            await self._on_response_done(event)
            return

        if etype == "error":
            self._log_upstream_error(event, phase="session")
            err = event.get("error") or {}
            event_id = err.get("event_id")
            if event_id is not None and event_id == self._report_create_id:
                # Upstream refused the text-only response outright (most likely
                # a parameter this surface does not accept -- the log line above
                # names `param`, so the fix is one line and visible on the first
                # run). The interview still COMPLETED; only the scorecard did
                # not, and that news travels in the payload rather than in a
                # close code.
                await self._finish_report(None, "rejected")
                return
            if event_id is not None and event_id in self._pending_create_ids:
                # An error echoing OUR create is not cosmetic: under v3 nothing
                # else will ask the next question, so this is a stalled
                # interview wearing a warning banner. Handled, and deliberately
                # not forwarded -- the student can do nothing with it and the
                # relay is already recovering.
                await self._on_create_rejected(err)
                return
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

    # -- the turn protocol --------------------------------------------------
    #
    # Everything between "the student stopped talking" and "the interviewer
    # speaks" is decided here, on the upstream pump task and nowhere else.

    def _create_timeout_s(self) -> float:
        return settings.interview_response_create_timeout_ms / 1000

    def _arm_answer_deadline(self, item_id: str | None = None) -> _Pending | None:
        """Start the clock on one student utterance. None when the queue is full.

        Each entry gets its OWN deadline at its OWN arm time, never a deadline
        measured from when it reaches the head of the queue: otherwise one hung
        transcription blocks the entries behind it and they blow their windows
        while waiting for it. One line, and easy to get wrong.
        """
        if len(self._pending) >= _MAX_PENDING_TURNS:
            self._log.warning(
                "Not arming another pending turn: %d already waiting on a "
                "transcript. The transcriber has stopped answering.",
                len(self._pending),
            )
            return None
        self._pending_seq += 1
        now = time.monotonic()
        entry = _Pending(
            key=f"p{self._pending_seq}",
            armed_at=now,
            deadline_at=now + settings.interview_transcription_timeout_ms / 1000,
            item_id=item_id,
        )
        self._pending[entry.key] = entry
        return entry

    def _refine_pending(self, item_id: str | None) -> None:
        """Attach the item id upstream just committed to the newest utterance."""
        if not item_id:
            return
        for entry in reversed(self._pending.values()):
            if not entry.resolved and entry.item_id is None:
                entry.item_id = item_id
                # Re-armed from the commit, which is closer to when the
                # transcriber actually starts work than speech_stopped was.
                entry.deadline_at = (
                    time.monotonic() + settings.interview_transcription_timeout_ms / 1000
                )
                return
        # A commit with no armed entry means speech_stopped never reached us.
        # Arm one now rather than letting the transcript arrive with nothing to
        # resolve: an utterance we can still record is worth more than tidiness.
        if item_id in self._resolved_items:
            return
        if self._abandoned_turns > 0:
            # ...unless it is the LATE commit for a turn the deadline already
            # gave up on, which is the same resurrection _resolve_pending
            # guards, one event earlier. Learning the id here is what lets the
            # memo catch the .completed that follows it.
            self._abandoned_turns -= 1
            self._memoise_resolved(item_id)
            return
        self._arm_answer_deadline(item_id)

    def _match_pending(self, item_id: str | None) -> _Pending | None:
        """The entry a transcription result belongs to.

        By item id when we have one -- which needs input_audio_buffer.committed
        to have arrived -- and otherwise the OLDEST unresolved entry, because
        transcription results come back in commit order. When the fallback picks
        wrongly, two utterances that are about to be joined into one answer
        anyway swap their provider ids; nothing about the interview changes.
        """
        if item_id:
            for entry in self._pending.values():
                if entry.item_id == item_id:
                    return entry
        for entry in self._pending.values():
            if not entry.resolved:
                return entry
        return None

    def _resolve_pending(self, item_id: str | None, transcript: str, status: str) -> None:
        """Settle one pending utterance. The single point of consumption.

        A .completed and that entry's own deadline can both fire; whichever
        arrives second finds the entry already resolved (or already popped) and
        does nothing. That is genuinely atomic rather than hopeful, because both
        paths run on the pump task and _handle_upstream_event is awaited to
        completion before the next event is read.
        """
        if item_id and item_id in self._resolved_items:
            # Already drained, so there is nothing here to resolve. Checked
            # BEFORE the match, not after it: the fallback below picks the
            # oldest unresolved entry when it has no id to go on, and a
            # duplicate arriving while a LATER utterance is still pending would
            # otherwise overwrite that utterance with an old transcript. Arming
            # a fresh entry instead would ask a second question for one answer.
            # (The record is protected separately, by the unique index on
            # (conversation_id, provider_turn_id) -- two layers, deliberately.)
            self._log.info("Duplicate transcription result for %s, ignored", item_id)
            return
        entry = self._match_pending(item_id)
        if entry is None:
            if self._abandoned_turns > 0:
                # A result for a turn the deadline already popped, arriving
                # after the interview moved on. It cannot be caught by the memo
                # above because that entry never learned an item_id, so without
                # this the arm below would RESURRECT it: the student's one
                # utterance becomes two rows and two questions, and the second
                # one is classified "resume" so the arc never counts the answer
                # they actually gave. Spend the credit and record the id, so a
                # second copy is caught by the memo like any other duplicate.
                self._abandoned_turns -= 1
                if item_id:
                    self._memoise_resolved(item_id)
                self._log.info(
                    "Transcription result for %s arrived after its deadline "
                    "popped the turn; discarded rather than asked again",
                    item_id or "an unidentified item",
                )
                return
            entry = self._arm_answer_deadline(item_id)
            if entry is None:
                self._log.warning("Dropping transcription result for %s: queue full", item_id)
                return
        if entry.resolved:
            return
        if entry.item_id is None:
            entry.item_id = item_id
        entry.transcript = transcript or ""
        entry.status = status
        if status == "ok":
            self._record_asr_latency(entry.armed_at)

    def _drain_pending(self) -> list[_Pending]:
        """Pop resolved entries from the HEAD, in commit order.

        Stops at the first unresolved entry so a turn can never be recorded
        before the one that preceded it. Returns a LIST rather than one entry
        because two utterances that resolve together are ONE answer and get ONE
        question in reply -- the fix for "the student paused mid-answer, VAD
        split it in two, and the interviewer asked two questions".
        """
        drained: list[_Pending] = []
        while self._pending:
            key = next(iter(self._pending))
            entry = self._pending[key]
            if not entry.resolved:
                break
            self._pending.pop(key, None)
            if entry.item_id:
                self._memoise_resolved(entry.item_id)
            elif entry.status in ("timeout", "failed"):
                # No item_id, so there is NOTHING for the memo to match a late
                # result against. That is not an edge case: §2.1 says
                # input_audio_buffer.committed is unverified under
                # create_response:false and that "the design therefore never
                # depends on it", and the answer deadline is the one path that
                # pops an entry which never learned an id. A transcript landing
                # a second after an 8 s timeout used to arm a FRESH entry --
                # two interview_turns rows for one utterance, a second
                # question, a spurious "you spoke before I had finished
                # asking", and a 0.0 s sample poisoning the very asrP50 that
                # exists to validate interview_transcription_timeout_ms.
                # Counted instead, and spent in _resolve_pending.
                self._abandoned_turns += 1
            drained.append(entry)
        return drained

    def _memoise_resolved(self, item_id: str) -> None:
        """Remember one drained item id, evicting the OLDEST at the cap.

        A cache that guards correctness must never silently refuse the NEWEST
        entry, which is what "stop growing past the cap" did: the newest id is
        precisely the one a duplicate .completed is about to arrive for, so from
        utterance 65 onwards the duplicate guard was simply off. Dropping the
        oldest is safe for the opposite reason -- a duplicate arrives seconds
        after its original, never sixty-four utterances later.
        """
        self._resolved_items.pop(item_id, None)
        self._resolved_items[item_id] = None
        while len(self._resolved_items) > _MAX_RESOLVED_ITEMS:
            self._resolved_items.pop(next(iter(self._resolved_items)))

    async def _drain_and_advance(self) -> None:
        entries = self._drain_pending()
        if entries:
            await self._after_answer(entries)

    async def _after_answer(self, entries: list[_Pending]) -> None:
        """One drained batch: record it, judge it, maybe advance the arc, reply.

        The order of the two checks is not interchangeable. `_question_open` is
        asked FIRST because it answers a different question from the validator:
        a three-word answer to a real question needs a clarification, while a
        three-word interjection over an unfinished question needs THE QUESTION
        FINISHED. Conflating them advances the interview on utterances that
        answered nothing.
        """
        if self._awaiting_candidate_questions:
            # The reply to "any questions for you?" is NOT an answer and is
            # deliberately not judged: "no, I'm good" is filler words to
            # classify_answer, and a student closing out politely must not
            # earn a clarify loop on the final turn of their interview. A
            # failed or timed-out transcript goes the same way -- a real
            # interviewer just closes. Recorded like any other turn, then
            # straight to the verdict: kind "next" sends no per-response
            # override, so the session instructions -- already carrying the
            # WRAP_UP (verdict) directive from the phase push below -- are
            # exactly the right ones.
            self._awaiting_candidate_questions = False
            for entry in entries:
                self._answer_meta = _AnswerMeta(
                    transcription_status=entry.status or "timeout",
                    answer_quality=None,
                    # Not an answer: the arc is already complete, and a mentor
                    # reading answers_accepted must be reading answers.
                    counted_as_answer=False,
                )
                self._emit_turn("user", entry.transcript, f"u:{entry.item_id or entry.key}")
            self._answer_meta = None
            self._verdict_requested = True
            await self._advance_turn("next")
            return

        joined = " ".join(e.transcript.strip() for e in entries if e.transcript.strip())
        unheard = not joined and any(e.status in ("failed", "timeout") for e in entries)
        # ONE verdict for the whole batch, not one per entry. A batch is one
        # answer that server VAD happened to split at a pause (DF3), and judging
        # the halves separately would record two "too_short" rows for an answer
        # that was accepted as a whole -- a transcript that contradicts the arc
        # it produced.
        quality = None if unheard else classify_answer(joined)

        if not self._question_open:
            kind = "resume"
        elif unheard:
            kind = "unheard"
        elif quality != "accepted":
            kind = "clarify"
        else:
            kind = "next"

        if kind in ("clarify", "unheard"):
            cap = settings.interview_max_clarifications_per_question
            if self._clarifications >= cap:
                # The budget is spent, so take what arrived and move on. A
                # student who genuinely cannot answer must not be trapped on one
                # question until the hard cap ends the interview with no verdict
                # -- and a degraded transcriber must not either. The arc always
                # terminates within (cap + 1) turns, and the record says why.
                self._log.info(
                    "Clarification budget of %d spent on this question; "
                    "accepting a %s answer and moving on",
                    cap,
                    kind,
                )
                kind = "next"
            else:
                self._clarifications += 1

        if kind == "unheard":
            self._unheard_streak += 1
            if self._unheard_streak >= 2:
                # Named on the summary line so a failing transcriber is legible
                # from one log line, without anyone querying the database.
                self._last_error = "transcriber:timeout"
        elif kind == "next":
            self._unheard_streak = 0

        # RECORDED HERE, after the kind is final and BEFORE the phase tick below.
        # Both halves of that sentence are load-bearing: the kind is what decides
        # `counted_as_answer`, and the phase stamped on the row must be the phase
        # the turn HAPPENED in -- push it after _push_phase and every answer that
        # moved the arc would be filed under the phase it moved the arc INTO.
        for index, entry in enumerate(entries):
            # One row per utterance, keyed in the same "u:"/"a:" namespace
            # append_message dedups on. A timed-out or failed entry has no text:
            # it is dropped from `messages` (nothing was said that a chat history
            # can show) and KEPT in interview_turns with its transcription_status
            # -- see the L4 carve-out in _emit_turn, which is the whole reason
            # that table has a status column.
            self._answer_meta = _AnswerMeta(
                transcription_status=entry.status or "timeout",
                answer_quality=quality,
                # ONE row per batch carries the tick, the last one, so that
                # `sum(counted_as_answer) == answers_accepted` holds even when
                # VAD split one answer in two. Marking both would double-count an
                # arc that advanced once.
                counted_as_answer=kind == "next" and index == len(entries) - 1,
            )
            self._emit_turn("user", entry.transcript, f"u:{entry.item_id or entry.key}")
        self._answer_meta = None

        if kind == "next":
            self._answers_accepted += 1
            # Only reachable with _question_open True: the "resume" branch above
            # takes every utterance that answered nothing, and the budget
            # promotion only fires for clarify/unheard, both of which require an
            # open question. That is what keeps the arc measuring answers.
            self._clarifications = 0
            if (
                self._machine.specialization is not None
                and self._machine.student_answered()
                and self._upstream is not None
            ):
                # AHEAD of the create, which is the whole point: a session.update
                # steers responses created AFTER upstream processes it, so a
                # phase directive sent after the create would steer the question
                # after next. That one-response lag is why the interview used to
                # ask a sixth question instead of delivering its verdict.
                await self._push_phase(self._upstream)
                if self._machine.phase is InterviewPhase.WRAP_UP:
                    # The two-beat close: the questioning is done, but a real
                    # interview ends with "any questions for us?" BEFORE the
                    # verdict. The create below carries the invite_questions
                    # override for exactly that one response; the student's
                    # reply -- any reply, bypassed past classify_answer in the
                    # branch above -- is what earns the verdict. The
                    # forced/clock path (_force_wrap_up) skips this beat.
                    self._awaiting_candidate_questions = True
                    kind = "invite_questions"

        await self._advance_turn(kind)

    async def _advance_turn(self, kind: str) -> None:
        """THE SINGLE response.create call site after the handshake.

        "One open question at a time" is enforced by the CALL GRAPH, not by a
        flag someone has to remember to check: every path that could make the
        interviewer speak -- a drained answer, an expired transcript, a
        clarification, a forced wrap-up, a deferred create -- arrives here,
        where the collision guard, the deferral and the deadline live. IF A
        SECOND response.create CALL SITE EVER APPEARS AFTER THE HANDSHAKE THAT
        INVARIANT IS GONE AND NO TEST WILL NOTICE. The handshake's opening
        create is the one deliberate exception, and it says so.

        The create is UNCONDITIONAL on specialization. Only the phase tick is
        gated on one; gating the create as well would ship a build in which the
        generic interview -- no ?specialization= at all -- goes permanently
        silent after the first answer. It is the easiest thing here to get wrong.
        """
        upstream = self._upstream
        if upstream is None:
            return
        if self._report_requested:
            # Nothing is being asked during the scorecard and nothing is being
            # said aloud, so a student's parting "thanks" must not create a
            # response that collides with it.
            return
        if self._server_created_response:
            # D2. The echo did not confirm create_response:false and upstream
            # has just created a response by itself, so ours would be the second
            # question in one turn. Skip this one and let the server's stand:
            # degraded to the pre-v3 behaviour, which is bad, rather than
            # doubled, which is worse.
            self._server_created_response = False
            self._log.error(
                "Skipping our response.create: upstream created one itself, so "
                "create_response=false is not in effect on this session"
            )
            return
        if self._active_response_id is not None or self._expecting_response:
            # DF4: a response is live -- or one we asked for is about to be --
            # so ours would be refused with
            # `conversation_already_has_active_response`. Queued rather than
            # dropped, and fired from _on_response_done. Last write wins on
            # purpose: if the student speaks again, their newer words ARE the
            # answer.
            #
            # _expecting_response is in this test for a case that looks
            # impossible and is not: between our create and its response.created
            # there is no _active_response_id, and a second utterance resolving
            # in that window would sail straight past a guard that only checked
            # the id.
            self._deferred = _DeferredTurn(kind)
            return
        await self._send_create(kind)

    async def _send_create(self, kind: str) -> None:
        """Put one response.create on the wire and arm its acknowledgement clock.

        Separate from _advance_turn so a RETRY can re-send the same turn without
        going back through the deferral guard -- a retry is the same question
        again, never a second one.
        """
        upstream = self._upstream
        if upstream is None:
            return
        body: dict[str, Any] = {"conversation": "auto"}
        if kind != "next":
            # A per-response override REPLACES the session persona for this
            # response, so build_turn_instructions composes a self-contained
            # string: base persona verbatim, then the specialization and phase,
            # then what to do this turn. It never contains the student's words.
            body["instructions"] = build_turn_instructions(
                self._machine.specialization,
                _INTERVIEWER_PERSONA,
                self._machine.phase,
                kind,
            )
        event_id = self._next_event_id(kind)
        self._pending_create_ids.append(event_id)
        if len(self._pending_create_ids) > _MAX_OUTSTANDING_CREATES:
            # A create upstream never acknowledged and never refused has no
            # other exit, and one per turn would grow this list for the whole
            # session. The oldest is the one least likely to still be answered.
            self._pending_create_ids.pop(0)
        self._last_create_kind = kind
        self._expecting_response = True
        self._create_deadline = time.monotonic() + self._create_timeout_s()
        self._question_open = False
        await upstream.send(
            json.dumps(
                {"type": "response.create", "event_id": event_id, "response": body}
            )
        )

    async def _retry_create(self, why: str) -> None:
        """One retry, then end the session rather than hang on a working socket.

        The create being retried is NOT disowned: it stays in
        _pending_create_ids, because the congestion that made it look lost is
        exactly the condition under which upstream answers it a moment later,
        and an id the relay has forgotten is an id whose rejection reaches the
        student as a banner.
        """
        if self._create_retries >= 1:
            self._log.error("response.create failed twice (%s); ending the session", why)
            raise _SessionEnded(
                _CLOSE_TURN_STALLED, "The interviewer stopped responding"
            )
        self._create_retries += 1
        self._log.warning(
            "response.create %s (%s); retrying once",
            ", ".join(self._pending_create_ids) or "(none outstanding)",
            why,
        )
        await self._send_create(self._last_create_kind)

    async def _on_create_rejected(self, err: dict[str, Any]) -> None:
        """Upstream refused OUR response.create. S3."""
        code = err.get("code")
        # Only the id upstream named is disowned. Anything else still
        # outstanding -- the original this rejection's create was retrying, or
        # the retry of this one -- has to stay recognisable, or its own error
        # falls through to the generic reep.error forward and the student, who
        # can do nothing with it, gets a warning banner mid-interview.
        rejected = err.get("event_id")
        if rejected in self._pending_create_ids:
            self._pending_create_ids.remove(rejected)
        self._expecting_response = False
        self._create_deadline = None
        if code == "conversation_already_has_active_response":
            # A response we did not know about is in flight. DO NOT retry and DO
            # NOT cancel: cancelling here kills the question currently being
            # asked, which is the worst outcome available. Wait for its
            # response.done, which fires the deferred create.
            if self._deferred is None:
                self._deferred = _DeferredTurn(self._last_create_kind)
            return
        await self._retry_create(f"rejected: {code}")

    async def _force_wrap_up(self) -> None:
        """S8: the session cap is near, so deliver a verdict while there is time.

        Turns "the cap landed mid-interview and there is no verdict at all" into
        "the verdict came a little early". The risk is smaller under v3 than it
        was -- WRAP_UP is now reached a full turn sooner, because v3 no longer
        burns a response asking a sixth question -- but a slow student still
        gets here, and this is the difference between a report and nothing.
        """
        if self._awaiting_candidate_questions and not self._verdict_requested:
            # The clock ran out while the student was thinking of a question
            # to ask US. The rest of the two-beat close is skipped -- a real
            # interviewer who is out of time just closes -- and the verdict
            # goes out now, because "a slightly early verdict beats none" is
            # this function's whole reason.
            self._awaiting_candidate_questions = False
            self._verdict_requested = True
            await self._advance_turn("verdict")
            return
        if self._report_requested or self._machine.phase in (
            InterviewPhase.WRAP_UP,
            InterviewPhase.ENDED,
        ):
            return
        self._log.info(
            "Session cap is close; forcing the wrap-up from %s", self._machine.phase
        )
        changed = self._machine.force_wrap_up()
        if changed and self._machine.specialization is not None and self._upstream is not None:
            await self._push_phase(self._upstream)
        # The forced path goes STRAIGHT to the verdict -- no candidate-
        # questions beat, there is no time left for it -- so the verdict is
        # requested here and its response.done is what triggers the scorecard.
        self._verdict_requested = True
        await self._advance_turn("verdict")

    def _earliest_deadline(self) -> float | None:
        """The next moment this session has something to do without upstream.

        None when nothing is armed, which is the common case and costs nothing:
        the pump then blocks on recv() exactly as it did before v3.
        """
        deadlines = [e.deadline_at for e in self._pending.values() if not e.resolved]
        for deadline in (self._create_deadline, self._report_deadline, self._wrap_up_deadline):
            if deadline is not None:
                deadlines.append(deadline)
        return min(deadlines) if deadlines else None

    async def _on_deadline(self) -> None:
        """Something armed has expired. Runs ON THE PUMP TASK -- see the pump.

        Every branch here either resolves state or ends the session; none of
        them may return leaving the same deadline armed, or the pump spins.
        """
        now = time.monotonic()

        if self._report_deadline is not None and now >= self._report_deadline:
            self._report_deadline = None
            await self._finish_report(None, "timeout")
            return

        expired = [
            entry
            for entry in self._pending.values()
            if not entry.resolved and now >= entry.deadline_at
        ]
        for entry in expired:
            self._log.warning(
                "No transcript for %s after %.1fs; continuing the interview without it",
                entry.item_id or entry.key,
                now - entry.armed_at,
            )
            entry.transcript = ""
            entry.status = "timeout"
        if expired:
            # The interview must never stall on a transcriber: the turn is
            # recorded with an unknown transcript and the next question is asked
            # anyway. Note the idle watchdog cannot cover this -- see its own
            # comment on what "idle" measures.
            await self._drain_and_advance()

        if self._wrap_up_deadline is not None and now >= self._wrap_up_deadline:
            self._wrap_up_deadline = None
            await self._force_wrap_up()

        if self._create_deadline is not None and now >= self._create_deadline:
            self._create_deadline = None
            await self._retry_create("was never acknowledged")

    def _record_asr_latency(self, armed_at: float | None) -> None:
        """One measurement of speech-stopped -> transcript-in-hand.

        Called only where a transcript actually ARRIVES: a turn that timed out
        or failed measures the deadline, not the transcriber, and mixing those
        in would make the p50 drift toward whatever the timeout is set to.
        """
        if armed_at is None:
            return
        self._asr_samples.append(time.monotonic() - armed_at)

    async def _forward_model_audio(self, event: dict[str, Any]) -> None:
        response_id = event.get("response_id")
        if response_id is not None and response_id == self._report_response_id:
            # The scorecard asked for text only, and this drop is what happens
            # when a surface ignores that: the worst case becomes a report the
            # student cannot hear, rather than a robot reading JSON aloud.
            return
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
            self._response_spoke = True
            # Only audio that actually reaches the browser is recorded: both
            # drops above (the scorecard's own audio, and a stale delta from a
            # response barge-in already cancelled) happen first, so the
            # interviewer track is what was SENT TO THE STUDENT rather than
            # everything the model produced. The two differ exactly when the student
            # interrupted, and the transcript's `is_partial` says so too.
            self._capture(_AUDIO_TRACK_INTERVIEWER, pcm)
            await self._send_audio(pcm)

    async def _on_speech_started(self) -> None:
        """Barge-in: flush the browser's play queue, then stop the model.

        Two cases do NOT barge in, and both decide BEFORE the flush -- a flush
        that fires anyway would drop audio the student is still meant to hear,
        which is the very thing the second case exists to prevent.
        """
        # THE ONE PLACE in this design where the correct action is to ignore the
        # student's voice. The scorecard is text-only and makes no sound, so
        # there is nothing to barge in over -- and a student saying "thanks,
        # bye" while it generates would otherwise destroy the headline output of
        # the whole feature.
        settling_report = (
            self._report_response_id is not None
            and self._active_response_id == self._report_response_id
        )
        # D3: this room's VAD is firing on the interviewer's own voice, so every
        # question has been dying before it was asked. An interviewer the
        # student cannot interrupt is a far better failure than one that never
        # finishes a sentence.
        if not settling_report and not self._bargein_disabled:
            # Downstream FIRST. The student is already talking over the agent,
            # and every millisecond before the play queue is flushed is audible.
            await self._send_control({"type": "reep.audio.flush"})
        # Forwarded either way: the browser draws "listening" from this, and
        # that is true no matter what we do about the response.
        await self._send_control({"type": "input_audio_buffer.speech_started"})
        if settling_report or self._bargein_disabled:
            return

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

        if response_id is not None and response_id == self._report_response_id:
            # DF5. Everything below this line -- the assistant turn, the
            # downstream response.done, the wrap-up branch -- is wrong for the
            # scorecard, and the one that MATTERS is _emit_turn: without this
            # return, raw JSON lands in the student's chat history and in
            # GET /api/agent/history as something the interviewer said.
            await self._settle_report(response)
            return

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
            # Recorded here as well as in _log_upstream_error precisely because
            # this path produces NO top-level `error` event: a summary line that
            # watched only `error` would report a clean session that made no
            # sound.
            self._last_error = f"response:{status}"
        else:
            self._log.info("Response %s ended %s", response_id, status)

        # Popped whatever the status, so a cancelled (barge-in) response cannot
        # leave partial text behind to be attributed to the NEXT response. The
        # partial IS stored: it is what the interviewer actually said before the
        # student cut in, and a transcript that silently omits every interrupted
        # question is not a record of the interview that happened.
        # Was the question ASKED? Only an answer to a question that was asked
        # may advance the arc. "incomplete" counts -- the student heard most of
        # it -- while "cancelled" and "failed" do not.
        #
        # SETTLED BEFORE THE EMIT BELOW, not after. `_partial_question` is what
        # the interview_turns row records as `is_partial`, and a question the
        # student cut in on is exactly the turn a reader needs to see marked --
        # "she never answered it" and "she never heard the end of it" are
        # different findings. Reading the flag one line too late records every
        # interrupted question as a complete one.
        asked = status in ("completed", "incomplete")
        self._question_open = asked
        self._partial_question = status == "cancelled"

        spoken = self._assistant_text.pop(response_id, "") if response_id else ""
        self._emit_turn("assistant", spoken, f"a:{response_id}")

        if status == "cancelled" and not self._response_spoke:
            # D3: a response cancelled before it made any sound means VAD fired
            # on something that was not the student answering.
            self._bargein_thrash += 1
            if self._bargein_thrash >= _MAX_BARGEIN_THRASH and not self._bargein_disabled:
                self._bargein_disabled = True
                self._last_error = "bargein:thrashing"
                self._log.error(
                    "%d consecutive questions were cancelled before they made a "
                    "sound; disabling barge-in for the rest of this session",
                    self._bargein_thrash,
                )
        else:
            self._bargein_thrash = 0

        await self._send_control(
            {"type": "response.done", "response_id": response_id, "status": status}
        )

        if self._deferred is not None and self._deferred.kind == "verdict":
            # S8's forced wrap-up fired while THIS response was still in flight,
            # so its create was deferred (DF4) and the response that just ended
            # is the ordinary question that preceded it -- not the verdict. The
            # WRAP_UP branch below assumes the opposite and went straight into
            # _request_report, which is how "a slightly early verdict" became
            # "an ordinary probing question, then a report panel": the student
            # never heard a verdict and the last assistant row in
            # interview_turns was a question stamped phase='wrap_up'. The
            # reserve is a wall-clock instant with no relationship to turn
            # boundaries, so a response in flight is the ORDINARY case here.
            #
            # Checked ahead of WRAP_UP and not merged into the generic
            # _deferred fire below, which WRAP_UP returns before ever reaching.
            # Only _force_wrap_up and the S6 retry create a "verdict" kind, and
            # the S6 retry never defers (nothing is in flight when it runs), so
            # this cannot swallow a verdict that was already spoken.
            self._deferred = None
            await self._advance_turn("verdict")
            return

        if (
            self._machine.phase is InterviewPhase.WRAP_UP
            and self._verdict_requested
            and not self._report_requested
        ):
            if asked:
                # The spoken verdict is finished, and it IS persisted as an
                # assistant turn above -- the student heard it, so it is part of
                # the interview. The scorecard is one further response.create.
                await self._request_report()
                return
            if not self._verdict_retried:
                # S6: the verdict was cancelled by barge-in. One bounded
                # re-create with a "deliver the verdict now" override, then the
                # report happens regardless -- a verdict lost to a cough must
                # not cost the scorecard as well.
                self._verdict_retried = True
                await self._advance_turn("verdict")
                return
            await self._request_report()
            return

        if self._deferred is not None:
            # DF4, fired UNCONDITIONALLY on status: a cancelled response on a
            # path where _active_response_id was already None would otherwise
            # lose the turn entirely.
            kind, self._deferred = self._deferred.kind, None
            await self._advance_turn(kind)
            return

        if status == "failed":
            # Nothing was asked and nothing else will ask it: under v3 the
            # relay is the only party that creates a response, so a failed one
            # is a silent interview unless we create another. Bounded, because a
            # model failing every time would otherwise loop until the hard cap.
            if self._failed_recreates >= 2:
                self._log.error("Three consecutive responses failed; ending the session")
                raise _SessionEnded(
                    _CLOSE_TURN_STALLED, "The interviewer stopped responding"
                )
            self._failed_recreates += 1
            await self._advance_turn(self._last_create_kind)
            return
        if asked:
            self._failed_recreates = 0

    # -- the final report ---------------------------------------------------

    async def _request_report(self) -> None:
        """One more response.create: text-only, strict JSON, same session.

        The session that conducted the interview already holds the whole
        transcript, so the scorecard costs one response rather than a second
        provider, a second pipeline or a second egress surface to reason about
        under rule 1. Nothing about the student is sent to fetch it -- the
        directive is a fixed string that names nobody.
        """
        upstream = self._upstream
        if self._report_requested or upstream is None:
            return
        self._report_requested = True

        body: dict[str, Any] = {
            # "auto", not "none": an out-of-band response is tidier in theory,
            # but on some surfaces it requires an explicit `input` array, and a
            # scorecard generated with no knowledge of the interview is the
            # whole feature failing silently. The cost of "auto" is that the
            # JSON is appended to the conversation as an assistant turn, which
            # is suppressed locally -- and that branch is needed either way.
            "conversation": "auto",
            "instructions": REPORT_DIRECTIVE,
            # Bounds a model that decides to write an essay and holds the socket
            # past the student's patience.
            "max_output_tokens": 800,
        }
        # The generation split lives inside `response`, mirroring what
        # _session_update_payload does for the session object. `temperature` is
        # deliberately omitted (beta accepts it here, GA is unverified) and so
        # is a `type` discriminator: fewer fields, fewer rejections, and a
        # rejection costs the entire report.
        if settings.realtime_beta_header:
            body["modalities"] = ["text"]
        else:
            body["output_modalities"] = ["text"]

        event_id = self._next_event_id("report")
        self._report_create_id = event_id
        self._expecting_report = True
        # Armed at SEND rather than at response.created, so a create that
        # upstream never acknowledges is covered by the same clock.
        self._report_deadline = time.monotonic() + settings.interview_report_timeout_ms / 1000
        self._log.info("Requesting the interview scorecard")
        await upstream.send(
            json.dumps(
                {"type": "response.create", "event_id": event_id, "response": body}
            )
        )

    async def _settle_report(self, response: dict[str, Any]) -> None:
        """Read the scorecard off response.done and end the interview."""
        raw = _extract_report_text(response) or self._report_text
        # Stashed before any parse attempt, because the case that needs it most
        # is the one where the parse fails: without the model's exact words there
        # is nothing for a DIRECTOR to read and no way to tell a prompt problem
        # from a code one. Truncated and scoped by the writer.
        self._report_raw = raw
        status = response.get("status")
        if not raw:
            self._log.error(
                "Scorecard response %s ended %s with no text",
                response.get("id"),
                status,
            )
            await self._finish_report(None, "rejected" if status == "failed" else "unparseable")
            return
        report = _parse_report(raw)
        if report is None:
            # The raw text is kept for a DIRECTOR to look at, because a bad
            # parse is nearly always a prompt problem rather than a code one --
            # and it is truncated and scoped, because it is the model's private
            # words about a named student.
            self._log.error("Could not parse the scorecard from %d chars of model text", len(raw))
            await self._finish_report(None, "unparseable")
            return
        await self._finish_report(report, "ok")

    async def _finish_report(self, report: dict[str, Any] | None, status: str) -> None:
        """Send reep.report and end the session -- always with close 1000.

        Every failure here is a payload, never a close code: the interview
        COMPLETED, and only the scorecard did not. A dedicated error code would
        make a successful interview read as a failure in the client, in the logs
        and in the record.

        Settled ONCE: the report deadline and a late response.done can both
        arrive, and the second one finds this already set.
        """
        if self._report_settled:
            return
        self._report_settled = True
        self._report_deadline = None
        self._report_status = status
        if status == "ok":
            self._log.info("Scorecard ready (overall=%s)", report.get("overall") if report else None)
        else:
            self._log.warning("No scorecard for this interview: %s", status)

        # THE EVALUATION ROW, and the one write in this module that is AWAITED
        # rather than fire-and-forget (L3). A DELIBERATE, DOCUMENTED DIVERGENCE
        # from the house rule two functions below: the reason fire-and-forget
        # exists -- "the student is mid-sentence and cannot be helped by an
        # exception" -- does not apply to a single row written after the
        # interview is over. Left to the fire-and-forget path it would be the
        # LAST write scheduled and therefore the first one _TURN_WRITE_DRAIN_S
        # cancels, which is to say: the scorecard would be the piece most likely
        # to be missing.
        #
        # Bounded, and a failure is logged and then IGNORED, because the payload
        # below still goes out: the student must see their scorecard even when
        # Postgres did not take it. This send is also why the report travels down
        # the socket rather than being fetched afterwards -- it is the only place
        # the scorecard exists if that write failed.
        await self._write_record(
            self._on_report,
            _ReportRecord(
                status=status,
                report=report,
                raw_response=self._report_raw,
                model=settings.openai_realtime_model,
            ),
            "the interview evaluation",
        )

        await self._send_control(
            {
                "type": "reep.report",
                "available": status == "ok",
                # None on success so a client can branch on truthiness alone.
                "reason": None if status == "ok" else status,
                "report": report if status == "ok" else None,
            }
        )
        raise _SessionEnded(_CLOSE_OK, "Interview complete")

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

        THE BLANK-TEXT GUARD MOVED (L4). It used to return here and drop the turn
        entirely; it now belongs to the `messages` insert ALONE, inside the
        writer. A transcription that timed out or failed produces `text == ""`,
        and those are precisely the turns `interview_turns.transcription_status`
        exists to record -- dropping them would leave the new column with nothing
        to say and the transcript silently missing the answers nobody could hear.
        `messages` still gets nothing, because a chat history that renders an
        empty bubble is worse than one that renders no bubble.
        """
        if self._on_turn is None:
            return
        # Incremented for EVERY turn, blank ones included, so `seq` is a dense
        # 1..N over what happened. A gap would be read as a lost row by the first
        # person to look, and the whole point of this table is that it does not
        # lose rows.
        self._turn_seq += 1
        record = _TurnRecord(
            seq=self._turn_seq,
            # The phase the turn HAPPENED in. Read from the machine at emit time
            # for exactly this reason -- it is the one thing a shared `messages`
            # row can never carry, and it is only true before the next tick.
            phase=self._machine.phase.value,
            # An interviewer turn was never transcribed at all: its text came
            # from the model. 'not_applicable' says that, where 'ok' would claim
            # a transcriber succeeded on a turn it never saw.
            transcription_status=(
                self._answer_meta.transcription_status
                if sender == "user" and self._answer_meta is not None
                else "not_applicable"
            ),
            answer_quality=(
                self._answer_meta.answer_quality
                if sender == "user" and self._answer_meta is not None
                else None
            ),
            counted_as_answer=(
                self._answer_meta.counted_as_answer
                if sender == "user" and self._answer_meta is not None
                else False
            ),
            # Only an interviewer turn can be cut off; a student utterance
            # arrives already complete, as one committed segment.
            is_partial=sender != "user" and self._partial_question,
        )
        # Counted before the write is scheduled, so this is "turns the interview
        # produced", not "turns Postgres accepted" -- the write is
        # fire-and-forget and a failed one is logged on its own line. The two
        # numbers side by side in the summary are the diagnosis: assistant-only
        # means the student was never transcribed, both zero means no turn ever
        # completed.
        if sender == "user":
            self._turns_user += 1
        else:
            self._turns_assistant += 1
        task = asyncio.create_task(
            self._run_turn_write(sender, text, provider_turn_id, record),
            name=f"interview-write-{self._conn_id}",
        )
        self._writes.add(task)
        task.add_done_callback(self._writes.discard)

    async def _run_turn_write(
        self, sender: str, text: str, provider_turn_id: str, record: _TurnRecord
    ) -> None:
        on_turn = self._on_turn
        if on_turn is None:  # pragma: no cover -- guarded by _emit_turn
            return
        try:
            # to_thread, NOT a direct call: see the _on_turn note in __init__.
            await asyncio.to_thread(on_turn, sender, text, provider_turn_id, record)
        except _TurnWriteRefused as exc:
            # L5. The chat thread this interview writes into was cleared or
            # purged mid-call, so every remaining turn would be refused the same
            # way: one dropped-turn line per turn for the rest of a 15-minute
            # session, wrapped around a record that is already lost. The
            # conversation_id was resolved ONCE at socket open, so this is a
            # state change we could not have checked for -- and the honest
            # response is to stop, not to keep shouting.
            #
            # request_stop, not raise: this runs on the EVENT LOOP (only the
            # writer itself is on a worker thread), so setting the stop event is
            # safe here and the watchdog turns it into a real close code. Raising
            # from a fire-and-forget task would be swallowed by the task, not by
            # the interview. 1000, not an error code: nothing failed -- the
            # student deliberately cleared the thread.
            self._log.error(
                "Interview turn refused and ENDING the interview: "
                "sender=%s turn=%s: %s",
                sender,
                provider_turn_id,
                exc,
            )
            self.request_stop(_CLOSE_OK, "Conversation cleared")
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
        else:
            # Only on the path where nothing was raised, which is what makes
            # `turns_persisted` mean "Postgres took it" rather than "we tried".
            # The gap against turns_emitted is the drop count, on the row itself.
            self._turns_persisted += 1

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

    # -- the interview record ------------------------------------------------

    async def _write_record(
        self, hook: Callable[[Any], None] | None, payload: Any, what: str
    ) -> None:
        """One AWAITED record write, bounded, whose failure never changes the outcome.

        The opposite discipline from _emit_turn, and deliberately so: these
        writes happen ONCE, after the interview is over, so waiting for them
        costs the student nothing and losing them costs the record everything.
        What they must never do is change how the interview ends -- a database
        that is slow or down is not a reason to hand the student a different
        close code -- which is why every failure here is logged and swallowed.
        _close_downstream documents the same rule for the same reason.

        On timeout the worker thread keeps running and its write may well land a
        moment later; the timeout bounds how long the SOCKET waits, not the
        statement. That is the right trade: the row arriving late is fine, the
        browser hanging on a close frame is not.
        """
        if hook is None:
            return
        try:
            async with asyncio.timeout(_RECORD_WRITE_TIMEOUT_S):
                await asyncio.to_thread(hook, payload)
        except TimeoutError:
            # Listed before Exception on purpose: since 3.11 TimeoutError IS an
            # OSError and would otherwise be caught by the clause below with a
            # message that named the wrong fault.
            self._log.error(
                "Timed out after %.0fs writing %s", _RECORD_WRITE_TIMEOUT_S, what
            )
        except Exception as exc:
            self._log.error("Could not write %s: %s", what, exc)

    # -- the recording -------------------------------------------------------

    def _capture(self, track: str, pcm: bytes) -> None:
        """Hand one frame to the recorder, if there is one. Cannot fail.

        Called from BOTH audio paths, ~50 frames/s/session in total. The
        recorder's own `feed` is total and does no I/O, so the cost when
        recording is off is one attribute load and a branch, and when it is on,
        a list append.

        The try/except is not distrust of that contract so much as the price of
        being wrong about it: a live interview must never end because a
        recording could not be kept, and this is the one place where a bug in
        the audio store would otherwise reach the student's ears. On failure the
        recorder is left in place rather than dropped, because it still owns
        open file handles that teardown has to close -- and whatever it did
        write is still a recording somebody has to be able to delete.
        """
        recorder = self._recorder
        if recorder is None:
            return
        try:
            recorder.feed(track, pcm)
        except Exception as exc:  # pragma: no cover -- feed() is documented total
            self._log.error("Interview audio capture raised and is being ignored: %s", exc)

    async def _close_recorder(self) -> Any:
        """Flush and close the recording; return what was kept, or None.

        Idempotent, because it is called from two places on purpose: the
        finalizer (the normal path, where the result reaches the database) and
        run()'s teardown (the path where the relay raised something nobody
        foresaw and the finalizer never ran). The second one keeps no result --
        it exists so file handles are closed and the RIFF headers are final.

        A timeout does NOT mean "nothing was recorded". It means the disk is
        slow, and the bytes are already there; reporting nothing would leave a
        student's voice on disk with no row pointing at it, which is the one
        state retention cannot clean up. `snapshot()` is the recorder's honest
        account of what it believes it wrote, and it is what gets stored.
        """
        recorder = self._recorder
        if recorder is None:
            return None
        try:
            async with asyncio.timeout(_AUDIO_CLOSE_TIMEOUT_S):
                result = await recorder.aclose()
            if result.recorded:
                # The one line that says a recording exists, on the session that
                # produced it. Without it, "is capture actually working?" is only
                # answerable by a query -- and this is the feature where an
                # operator most needs to be sure of the answer in both
                # directions.
                self._log.info(
                    "Interview audio stored: path=%s bytes=%d duration=%.0fs truncated=%s",
                    result.path,
                    result.total_bytes,
                    result.duration_ms / 1000,
                    result.truncated,
                )
            return result
        except TimeoutError:
            # Before Exception, deliberately: since 3.11 TimeoutError IS an
            # OSError and the clause below would name the wrong fault.
            self._log.error(
                "Interview audio did not finish closing within %.0fs; recording "
                "what is believed to be on disk so it stays deletable",
                _AUDIO_CLOSE_TIMEOUT_S,
            )
        except Exception as exc:
            self._log.error("Could not close the interview audio: %s", exc)
        try:
            return recorder.snapshot()
        except Exception as exc:  # pragma: no cover -- snapshot() reads counters
            self._log.error("Interview audio state is unreadable: %s", exc)
            return None

    async def _finalize_session(self, code: int, reason: str) -> None:
        """LAYER 1 of three: the relay closing its own record.

        A `running` row that is never closed is worse than no row -- it is a
        record that lies, and a mentor reading it sees an interview that is still
        happening. Three layers close it, in order of how much of the process has
        to survive: this one (every ordinary exit, including guardrails,
        disconnects and 1011), the router's `finally` backstop (this coroutine
        never running at all), and retention's sweeper (the process was killed
        and nothing in it ran).

        Called from _interview AFTER _drain_writes so `turns_persisted` is a
        final number rather than a snapshot mid-flight, and BEFORE the summary
        line so that line is genuinely the last word.

        `status` is NOT a lookup on the close code alone. A 1000 means "the
        socket closed normally", which covers both "the scorecard was delivered"
        and "the student pressed End at minute three" -- and calling the second
        one `completed` would put a finished-looking interview with no verdict in
        front of a mentor. The scorecard having settled is what completed means.
        """
        if self._finalized:
            return
        self._finalized = True

        # BEFORE the early return on a missing hook, and before the outcome is
        # composed: the files must be closed even when nothing is listening for
        # the result (the relay's own tests, a misconfiguration), or a session
        # ends with two open file handles and an unpatched header. This is also
        # what makes `audio_bytes` and `audio_duration_ms` final rather than a
        # mid-flush snapshot -- the same reason _drain_writes runs before this
        # coroutine is called at all.
        audio = await self._close_recorder()

        if self._on_finalize is None:
            return

        if self._report_settled:
            status = "completed"
        elif code in (
            _CLOSE_OK,
            _CLOSE_GOING_AWAY,
            _CLOSE_IDLE,
            _CLOSE_SESSION_CAP,
        ):
            # Nobody's fault and nothing broke: the student left, the tab was
            # backgrounded, the deploy restarted, or the 15-minute cap landed.
            # The interview simply did not reach its verdict.
            status = "abandoned"
        else:
            # 1011, 4001, 4002, 4011, 4003 -- something went wrong, and the
            # (close_code, terminal_reason) pair on the row says what.
            status = "failed"

        await self._write_record(
            self._on_finalize,
            _SessionOutcome(
                status=status,
                close_code=code,
                # The exact pair the student's browser saw, in the shape the
                # schema's own example uses ("4008 No audio received for 2
                # minutes"), so a support report and the row agree word for word.
                terminal_reason=f"{code} {reason}",
                # The phase the interview STOPPED in, and machine.end() is
                # deliberately not called first: 'ended' on every row would erase
                # the one fact this column exists for -- how far the arc got.
                final_phase=self._machine.phase.value,
                answers_accepted=self._answers_accepted,
                turns_emitted=self._turns_user + self._turns_assistant,
                turns_persisted=self._turns_persisted,
                upstream_session_id=self._session_id,
                # None ⇒ the scorecard was never even attempted, which the writer
                # records as an evaluation row saying `unavailable`. A row saying
                # "no report, the cap hit first" is a record; a MISSING row says
                # nothing at all and reads as a bug.
                report_status=self._report_status,
                # What was kept of the student's voice, if anything. `audio` is
                # None whenever no recorder existed, which is the default
                # everywhere: recording requires the setting AND a live
                # scope_store_audio grant (app/interview_audio.py), and the
                # defaults below then say "we know nothing was kept" rather than
                # leaving the row ambiguous.
                audio_recorded=bool(audio and audio.recorded),
                audio_path=audio.path if audio and audio.recorded else None,
                audio_bytes=audio.total_bytes if audio and audio.recorded else None,
                audio_duration_ms=(
                    audio.duration_ms if audio and audio.recorded else None
                ),
                # True even when nothing was recorded in the end: a capture that
                # was cut off at zero bytes still ended early, and a flag that
                # only ever appears next to a file cannot say so.
                audio_truncated=bool(audio and audio.truncated),
            ),
            "the interview record",
        )

    def _beat(self) -> None:
        """Stamp heartbeat_at. Fire-and-forget, from the watchdog, on a thread.

        THE WATCHDOG IS ALLOWED TO ISSUE THIS ONE WRITE precisely because it
        touches no turn state and sends nothing downstream -- the two things
        :2.5's "exactly one task ever sends downstream" invariant is about. It
        must stay that way.

        If it fails all session long, `heartbeat_at` never leaves `started_at`
        and the sweeper eventually marks a HEALTHY session `abandoned`. That is
        wrong-but-present, and it is the correct direction to fail: a session
        wrongly marked abandoned is visible and arguable, while one stuck at
        `running` forever is invisible.

        Tracked in `self._writes` so teardown drains it and CPython cannot
        garbage-collect the task mid-write -- the same reason _emit_turn holds
        its tasks.
        """
        hook = self._on_heartbeat
        if hook is None:
            return

        async def run() -> None:
            try:
                await asyncio.to_thread(hook)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._log.warning("Interview heartbeat not written: %s", exc)

        task = asyncio.create_task(run(), name=f"interview-heartbeat-{self._conn_id}")
        self._writes.add(task)
        task.add_done_callback(self._writes.discard)

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

            if now - self._heartbeat_at >= _HEARTBEAT_WRITE_INTERVAL_S:
                # Stamped BEFORE the write is scheduled, not after it lands: a
                # database that is answering slowly must not cause a second,
                # third and fourth heartbeat to pile up behind the first.
                self._heartbeat_at = now
                self._beat()

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

            # "IDLE" MEANS NO AUDIO FRAMES, NOT NO SPEECH, and it is not a
            # backstop for a stalled transcription: the browser's echo-gate
            # keepalive feeds zeroed frames every 10 s, so _last_audio_at stays
            # fresh through any amount of silence. A turn that never resolves is
            # caught by its own answer deadline in _on_deadline, and by nothing
            # here.
            #
            # AND THE FRAMES ARE NOT INSPECTED, WHICH IS A DECISION. A client
            # sending one 1920-byte all-zero frame every 119 s holds a slot for
            # the full 15 minutes with no microphone at all, and an energy gate
            # here would refuse it. It is deliberately not added, for three
            # reasons in order: the browser's own echo-gate keepalive is zeroed
            # BY DESIGN, so an energy gate would close healthy sessions while the
            # interviewer is speaking -- the exact failure this cap exists to
            # avoid, inverted; the abuse it prevents is already bounded above by
            # interview_max_seconds and, since audit H1, by the per-user cap in
            # _ConnectionLimiter, so the ceiling is two dead sockets per student
            # rather than a whole worker; and voice-activity detection belongs to
            # server VAD upstream, which already has the audio and the model for
            # it. This cap is a LIVENESS CHECK ON THE TRANSPORT. Keep it one.
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

        finally:
            # THE ONLY EXIT NOT COVERED BY _finalize_session: something raised
            # inside _interview that none of its `except*` clauses matched, so
            # the finalizer never ran and the recording is sitting on two open
            # file handles with a stale RIFF header. Idempotent, so on every
            # ordinary path this is a no-op that returns the cached result.
            #
            # Its result is DISCARDED here on purpose -- the outcome row is
            # Layer 1's job and by this point there is nothing left to write it
            # with. What this buys is a closed, playable file that retention can
            # still find by session id (app/interview_audio.py names it that way
            # for exactly this case). Suppressed because a teardown detail must
            # never replace the close code the student is about to be handed;
            # CancelledError is a BaseException and still propagates.
            with contextlib.suppress(Exception):
                await self._close_recorder()

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

        # LAYER 1 of finalization, and here rather than anywhere else for two
        # reasons: after _drain_writes so `turns_persisted` is final rather than
        # a mid-flight snapshot, and before the summary line so that line carries
        # the terminal status the record now holds. Every exit the pumps can take
        # -- clean end, guardrail, disconnect, upstream close, 1011 -- funnels
        # through this one point, which is exactly why the finalizer lives here
        # and not in five `except*` clauses.
        await self._finalize_session(code, reason)

        # ONE line, the last word on the interview, and deliberately the line a
        # support report is asked to paste. Everything a "the audio was bad"
        # ticket cannot tell us by description is in it: whether audio arrived
        # at all (frames/bytes), whether either side produced turns
        # (turns=user/assistant), which transcriber ran (a wrong model id is the
        # difference between "the student said nothing" and "the student was
        # never transcribed"), and whether anything upstream actually failed.
        # error=None with turns=0/N is a different bug from error=... with the
        # same counts, and no amount of guessing separates them afterwards.
        # gateCloses is the browser's half-duplex echo gate, reported by the
        # client: roughly one per model response is healthy, zero on a session
        # that reported self-talk means the gate was never armed, and a figure
        # far above the response count means it is thrashing on a threshold that
        # is wrong for that room.
        # asrP50/asrMax are the transcriber round trip measured on THIS
        # session (speech_stopped -> transcript). Under v3 that time is added
        # to the silence between every answer and the next question, so it is
        # the number that says whether interview_transcription_timeout_ms is
        # right for this deployment -- and "-" means no student utterance was
        # ever transcribed, which is a different fault from a slow one.
        self._log.info(
            "Interview finished: code=%s reason=%r duration=%.0fs frames=%d bytes=%d "
            "turns=%d/%d saved=%d gateCloses=%d asrP50=%s asrMax=%s pending=%d "
            "report=%s transcriber=%s error=%s",
            code,
            reason,
            time.monotonic() - self._started_at,
            self._client_frames,
            self._client_bytes,
            self._turns_user,
            self._turns_assistant,
            # Turns Postgres actually took. `saved` below the sum of `turns` is
            # the runbook's "sounded fine, saved nothing" measured on the session
            # itself -- the same number now on interview_sessions.turns_persisted,
            # here so a log line answers it without a query.
            self._turns_persisted,
            self._gate_closes,
            _fmt_seconds(_percentile(self._asr_samples, 0.5)),
            _fmt_seconds(max(self._asr_samples) if self._asr_samples else None),
            # Utterances whose transcript never arrived before the socket closed
            # -- the student pressed End, and _drain_writes drains WRITES, not
            # pending transcriptions. Those turns are lost, and this is the only
            # place that says so; the same loss used to be entirely invisible.
            len(self._pending),
            self._report_status,
            settings.transcription_model,
            self._last_error,
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
