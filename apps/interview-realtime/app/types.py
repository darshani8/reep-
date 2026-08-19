"""Typed contract for the OpenAI Realtime WebSocket protocol.

This module is the single source of truth for the wire format spoken on both
legs of the relay::

    browser  <--reep.* + passthrough-->  relay  <--Realtime API-->  api.openai.com

It is deliberately dependency-free apart from Pydantic: nothing here imports
``config`` or ``server``, so it can be unit-tested, vendored, or re-used by a
future worker without dragging the whole application in.

WHY MODELS AND NOT PLAIN DICTS
The relay forwards most frames verbatim for latency reasons -- parsing a 40 ms
audio chunk into a model just to re-serialise it would be pure waste. These
models exist for the frames where correctness matters more than speed: building
``session.update`` (a malformed one silently leaves the default persona live),
and asserting in tests that what we send is what we meant to send.

TWO API GENERATIONS
OpenAI renamed several events between the preview and GA Realtime APIs. Both
namings are modelled and both are accepted::

    response.audio.delta             ->  response.output_audio.delta
    response.audio.done              ->  response.output_audio.done
    response.audio_transcript.delta  ->  response.output_audio_transcript.delta

``server.py`` handles either, and so does :func:`parse_server_event`. Treating
one as canonical and the other as a typo would break against whichever endpoint
the account is actually pinned to.

EXTRA FIELDS ARE ALWAYS ALLOWED
Every model sets ``extra="allow"``. OpenAI adds fields to these events without a
version bump; a strict model would turn a harmless new field into a 500 in the
middle of a live interview. Validate what we depend on, carry the rest.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, TypeAlias, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

# --------------------------------------------------------------------------- #
# Audio constants                                                             #
# --------------------------------------------------------------------------- #

# The Realtime API speaks raw little-endian 16-bit mono PCM. 24 kHz is the rate
# the model both expects and returns; a resample anywhere in the chain is the
# usual cause of chipmunk or slow-motion audio.
SAMPLE_RATE_HZ: int = 24_000
BYTES_PER_SAMPLE: int = 2
CHANNELS: int = 1

AudioFormat: TypeAlias = Literal["pcm16", "g711_ulaw", "g711_alaw"]
Modality: TypeAlias = Literal["text", "audio"]


class _Event(BaseModel):
    """Base for every wire event.

    ``extra="allow"`` is the load-bearing setting -- see the module docstring.
    ``event_id`` is optional in both directions: a client may supply one to
    correlate an acknowledgement, and the server stamps one on everything.
    """

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    event_id: str | None = None


# --------------------------------------------------------------------------- #
# Session configuration                                                       #
# --------------------------------------------------------------------------- #


class TurnDetection(BaseModel):
    """Server-side Voice Activity Detection.

    With ``server_vad`` the model decides when the student has stopped speaking
    and begins responding on its own -- the relay never has to guess. These
    three numbers are the whole tuning surface:

    ``threshold``
        How loud counts as speech (0..1). Too low and a ceiling fan or a
        keyboard opens a turn; too high and a soft-spoken student is never
        heard at all.
    ``prefix_padding_ms``
        Audio retained from *before* detection fired, so the first syllable is
        not clipped off the transcript.
    ``silence_duration_ms``
        How long a pause must last before the turn is closed. This is the
        biggest lever on how interrupty the interviewer feels: a student
        pausing mid-answer to think must not be treated as finished.
    """

    model_config = ConfigDict(extra="allow")

    type: Literal["server_vad", "semantic_vad"] = "server_vad"
    threshold: float = 0.5
    prefix_padding_ms: int = 300
    silence_duration_ms: int = 700
    create_response: bool | None = None
    interrupt_response: bool | None = None


class SessionConfig(BaseModel):
    """The payload of ``session.update`` in the flat (preview/GA) shape.

    ``instructions`` carries the interviewer persona. When this field fails to
    apply the session silently runs with the model's default personality, and
    the failure is completely inaudible -- which is why ``server.py`` verifies
    the echoed ``session.updated`` instead of assuming success.
    """

    model_config = ConfigDict(extra="allow")

    modalities: list[Modality] | None = None
    instructions: str | None = None
    voice: str | None = None
    input_audio_format: AudioFormat | None = None
    output_audio_format: AudioFormat | None = None
    turn_detection: TurnDetection | None = None
    temperature: float | None = None
    max_response_output_tokens: int | Literal["inf"] | None = None


# --------------------------------------------------------------------------- #
# Client -> OpenAI                                                            #
# --------------------------------------------------------------------------- #


class SessionUpdateEvent(_Event):
    """Configure the live session. Sent once, after ``session.created`` arrives.

    Sending it earlier is the classic ordering bug: the update is dropped and
    the persona never takes effect.
    """

    type: Literal["session.update"] = "session.update"
    session: SessionConfig | dict[str, Any]


class InputAudioBufferAppendEvent(_Event):
    """One chunk of microphone audio: base64-encoded PCM16 at 24 kHz.

    The highest-frequency event on the wire -- roughly 25 per second at a 40 ms
    frame -- which is why the relay forwards the raw bytes rather than
    round-tripping every chunk through this model.
    """

    type: Literal["input_audio_buffer.append"] = "input_audio_buffer.append"
    audio: str


class InputAudioBufferCommitEvent(_Event):
    """Close the current input turn by hand.

    Unused under server VAD, which commits on its own. Kept for the
    push-to-talk fallback path.
    """

    type: Literal["input_audio_buffer.commit"] = "input_audio_buffer.commit"


class InputAudioBufferClearEvent(_Event):
    """Discard buffered input audio that has not been committed."""

    type: Literal["input_audio_buffer.clear"] = "input_audio_buffer.clear"


class ResponseCreateEvent(_Event):
    """Ask for a response now.

    Under server VAD the model does this itself; the relay sends it only to
    open the interview with the first question.
    """

    type: Literal["response.create"] = "response.create"
    response: dict[str, Any] | None = None


class ResponseCancelEvent(_Event):
    """Stop generation immediately.

    Sent the instant ``input_audio_buffer.speech_started`` arrives. Without it
    the model keeps generating -- and keeps billing -- into audio the student
    has already talked over, and the barge-in feels laggy rather than natural.
    """

    type: Literal["response.cancel"] = "response.cancel"
    response_id: str | None = None


ClientEvent: TypeAlias = Annotated[
    Union[
        SessionUpdateEvent,
        InputAudioBufferAppendEvent,
        InputAudioBufferCommitEvent,
        InputAudioBufferClearEvent,
        ResponseCreateEvent,
        ResponseCancelEvent,
    ],
    Field(discriminator="type"),
]


# --------------------------------------------------------------------------- #
# OpenAI -> relay                                                             #
# --------------------------------------------------------------------------- #


class SessionCreatedEvent(_Event):
    """The session exists. Nothing may be configured before this arrives."""

    type: Literal["session.created"] = "session.created"
    session: dict[str, Any]


class SessionUpdatedEvent(_Event):
    """The echo of an applied ``session.update``.

    ``server.py`` reads ``turn_detection`` back out of this to prove server VAD
    is genuinely on. A rejected update is reported here, not as an error frame.
    """

    type: Literal["session.updated"] = "session.updated"
    session: dict[str, Any]


class SpeechStartedEvent(_Event):
    """The student began speaking. THE interruption signal.

    Two things must happen on this frame: the relay sends ``response.cancel``
    upstream, and the browser drops every queued audio buffer. Miss either and
    the assistant talks over the student.
    """

    type: Literal["input_audio_buffer.speech_started"] = "input_audio_buffer.speech_started"
    audio_start_ms: int | None = None
    item_id: str | None = None


class SpeechStoppedEvent(_Event):
    """The student stopped; the turn is closed and a response follows."""

    type: Literal["input_audio_buffer.speech_stopped"] = "input_audio_buffer.speech_stopped"
    audio_end_ms: int | None = None
    item_id: str | None = None


class ResponseCreatedEvent(_Event):
    """A new response turn has begun upstream."""

    type: Literal["response.created"] = "response.created"
    response: dict[str, Any]


class ResponseAudioDeltaEvent(_Event):
    """A chunk of the interviewer's speech: base64 PCM16 at 24 kHz.

    Preview naming. GA sends ``response.output_audio.delta`` with an identical
    payload; both are handled.
    """

    type: Literal["response.audio.delta"] = "response.audio.delta"
    delta: str
    response_id: str | None = None
    item_id: str | None = None
    output_index: int | None = None
    content_index: int | None = None


class ResponseOutputAudioDeltaEvent(_Event):
    """GA naming for :class:`ResponseAudioDeltaEvent`."""

    type: Literal["response.output_audio.delta"] = "response.output_audio.delta"
    delta: str
    response_id: str | None = None
    item_id: str | None = None
    output_index: int | None = None
    content_index: int | None = None


class ResponseAudioDoneEvent(_Event):
    """The interviewer's audio for this turn is complete (preview naming)."""

    type: Literal["response.audio.done"] = "response.audio.done"
    response_id: str | None = None
    item_id: str | None = None


class ResponseOutputAudioDoneEvent(_Event):
    """GA naming for :class:`ResponseAudioDoneEvent`."""

    type: Literal["response.output_audio.done"] = "response.output_audio.done"
    response_id: str | None = None
    item_id: str | None = None


class ResponseAudioTranscriptDeltaEvent(_Event):
    """Text of what the interviewer is saying, for the on-screen transcript."""

    type: Literal["response.audio_transcript.delta"] = "response.audio_transcript.delta"
    delta: str
    response_id: str | None = None
    item_id: str | None = None


class ResponseOutputAudioTranscriptDeltaEvent(_Event):
    """GA naming for :class:`ResponseAudioTranscriptDeltaEvent`."""

    type: Literal["response.output_audio_transcript.delta"] = (
        "response.output_audio_transcript.delta"
    )
    delta: str
    response_id: str | None = None
    item_id: str | None = None


class InputAudioTranscriptionCompletedEvent(_Event):
    """Whisper's transcript of what the STUDENT said.

    The half worth persisting for later feedback, since it is the thing being
    assessed -- the interviewer's own words are reproducible from the persona.
    """

    type: Literal["conversation.item.input_audio_transcription.completed"] = (
        "conversation.item.input_audio_transcription.completed"
    )
    transcript: str
    item_id: str | None = None
    content_index: int | None = None


class ResponseDoneEvent(_Event):
    """A full turn finished.

    ``response.usage`` carries the token spend -- the only reliable place to
    observe real cost per interview, which is what the guardrails exist to cap.
    """

    type: Literal["response.done"] = "response.done"
    response: dict[str, Any]


class RateLimitsUpdatedEvent(_Event):
    """Remaining quota.

    Worth logging: at 1000 students the account rate limit, not this code, is
    what fails first.
    """

    type: Literal["rate_limits.updated"] = "rate_limits.updated"
    rate_limits: list[dict[str, Any]]


class ErrorEvent(_Event):
    """An upstream error.

    Log ``error.code`` and ``error.message``. A generic "upstream failed" line
    has repeatedly cost hours on this kind of integration.
    """

    type: Literal["error"] = "error"
    error: dict[str, Any]


class UnknownServerEvent(_Event):
    """Anything OpenAI adds that post-dates this file.

    A discriminated union raises on an unrecognised discriminator, which would
    turn a brand-new upstream event into a dropped call.
    :func:`parse_server_event` falls back to this instead.
    """

    model_config = ConfigDict(extra="allow")

    type: str


ServerEvent: TypeAlias = Annotated[
    Union[
        SessionCreatedEvent,
        SessionUpdatedEvent,
        SpeechStartedEvent,
        SpeechStoppedEvent,
        ResponseCreatedEvent,
        ResponseAudioDeltaEvent,
        ResponseOutputAudioDeltaEvent,
        ResponseAudioDoneEvent,
        ResponseOutputAudioDoneEvent,
        ResponseAudioTranscriptDeltaEvent,
        ResponseOutputAudioTranscriptDeltaEvent,
        InputAudioTranscriptionCompletedEvent,
        ResponseDoneEvent,
        RateLimitsUpdatedEvent,
        ErrorEvent,
    ],
    Field(discriminator="type"),
]


# --------------------------------------------------------------------------- #
# Relay -> browser (REEP control frames)                                      #
# --------------------------------------------------------------------------- #
# These are ours, not OpenAI's. They are namespaced ``reep.`` precisely so a
# reader can tell at a glance which frames originate in this relay and which
# are being passed through from upstream.


class ReepReadyEvent(_Event):
    """The upstream session is configured and the student may start speaking.

    The browser keeps its microphone closed until this lands, so audio is never
    sent into a session that has not yet had the persona applied.
    """

    type: Literal["reep.ready"] = "reep.ready"
    session_id: str | None = None
    expires_in_seconds: int | None = None


class ReepAudioFlushEvent(_Event):
    """Drop the playback queue NOW -- the local half of barge-in.

    Sent alongside the forwarded ``speech_started``. The browser cannot wait
    for the upstream cancel to take effect: audio already scheduled into the
    AudioContext would keep playing over the student for hundreds of
    milliseconds.
    """

    type: Literal["reep.audio.flush"] = "reep.audio.flush"


class ReepEndEvent(_Event):
    """The relay is closing the session, with a reason a human can act on."""

    type: Literal["reep.end"] = "reep.end"
    reason: Literal[
        "session_timeout",
        "idle_timeout",
        "client_request",
        "upstream_closed",
        "server_shutdown",
    ]
    detail: str | None = None


class ReepErrorEvent(_Event):
    """A user-presentable failure.

    Never carries provider detail or the API key: the browser is untrusted and
    this message is rendered to the student verbatim.
    """

    type: Literal["reep.error"] = "reep.error"
    message: str
    code: str | None = None


ReepEvent: TypeAlias = Annotated[
    Union[ReepReadyEvent, ReepAudioFlushEvent, ReepEndEvent, ReepErrorEvent],
    Field(discriminator="type"),
]


# --------------------------------------------------------------------------- #
# Helpers                                                                     #
# --------------------------------------------------------------------------- #

# Both generations of each renamed event, so call sites test membership instead
# of chaining two string comparisons everywhere.
AUDIO_DELTA_TYPES: frozenset[str] = frozenset(
    {"response.audio.delta", "response.output_audio.delta"}
)
AUDIO_DONE_TYPES: frozenset[str] = frozenset(
    {"response.audio.done", "response.output_audio.done"}
)
TRANSCRIPT_DELTA_TYPES: frozenset[str] = frozenset(
    {"response.audio_transcript.delta", "response.output_audio_transcript.delta"}
)

_SERVER_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "session.created",
        "session.updated",
        "input_audio_buffer.speech_started",
        "input_audio_buffer.speech_stopped",
        "response.created",
        "response.audio.delta",
        "response.output_audio.delta",
        "response.audio.done",
        "response.output_audio.done",
        "response.audio_transcript.delta",
        "response.output_audio_transcript.delta",
        "conversation.item.input_audio_transcription.completed",
        "response.done",
        "rate_limits.updated",
        "error",
    }
)

# Built once at import. A TypeAdapter compiles a validator, and rebuilding it
# per frame would put that cost on every one of ~25 audio events per second.
_SERVER_EVENT_ADAPTER: TypeAdapter[Any] = TypeAdapter(ServerEvent)


def parse_server_event(payload: dict[str, Any]) -> Any:
    """Validate an upstream frame, falling back to :class:`UnknownServerEvent`.

    Never raises on an unrecognised ``type``: a new upstream event must not be
    able to end a live interview.
    """
    if payload.get("type") in _SERVER_EVENT_TYPES:
        return _SERVER_EVENT_ADAPTER.validate_python(payload)
    return UnknownServerEvent.model_validate(payload)


def is_audio_delta(payload: dict[str, Any]) -> bool:
    """True for either generation's audio-delta event."""
    return payload.get("type") in AUDIO_DELTA_TYPES


def is_speech_started(payload: dict[str, Any]) -> bool:
    """True for the interruption signal -- the frame that must never be missed."""
    return payload.get("type") == "input_audio_buffer.speech_started"


def pcm16_duration_seconds(byte_length: int) -> float:
    """Wall-clock duration of a PCM16 mono 24 kHz buffer.

    Used by the playback scheduler's cursor and by the idle watchdog. Getting
    this wrong shows up either as stutter or as a session that never times out.
    """
    return byte_length / (SAMPLE_RATE_HZ * BYTES_PER_SAMPLE * CHANNELS)
