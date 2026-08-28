"""The v3 turn protocol: who asks the next question, and when.

The relay -- not the upstream VAD -- decides when the interviewer speaks. That
decision is made in `_handle_upstream_event` from a handful of state variables,
and every failure it is built to survive (a transcript that never lands, a
transcription that fails outright, a student who talks over the question, a
scorecard the student's own voice could destroy) is a specific sequence of
upstream events. So this module drives that sequence directly.

NO DATABASE AND NO SOCKET, the same property test_interview_matrix.py already
claims: a fake upstream that records what was sent, a fake browser socket that
records what was forwarded, and `on_turn=None` so the persistence path is never
entered. What is asserted is what went ON THE WIRE and what the state machine
did -- the two things a student experiences.

Each test is named for the failure it prevents, because that is the only useful
thing to know when one of them goes red in two years.
"""

import asyncio
import base64
import json
import time

import pytest
from websockets.exceptions import ConnectionClosedOK

from app.config import settings
from app.interview.specializations import SPECIALIZATIONS, InterviewPhase
from app.interview.realtime_relay import (
    _AUDIO_TRACK_STUDENT,
    _CLOSE_OK,
    _CLOSE_TURN_STALLED,
    _CLOSE_UPSTREAM_UNAVAILABLE,
    _MAX_BARGEIN_THRASH,
    _MAX_RESOLVED_ITEMS,
    _RelaySession,
    _SessionEnded,
)


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _FakeBrowser:
    """Starlette's WebSocket, reduced to the two methods the relay calls."""

    def __init__(self) -> None:
        self.control: list[dict] = []
        self.audio: list[bytes] = []

    async def send_json(self, payload: dict) -> None:
        self.control.append(payload)

    async def send_bytes(self, data: bytes) -> None:
        self.audio.append(data)


class _FakeUpstream:
    """api.openai.com, reduced to send(). Every event is kept, parsed."""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, raw: str) -> None:
        self.sent.append(json.loads(raw))

    def of_type(self, etype: str) -> list[dict]:
        return [event for event in self.sent if event.get("type") == etype]

    @property
    def creates(self) -> list[dict]:
        return self.of_type("response.create")


class _ScriptedUpstream(_FakeUpstream):
    """An upstream that can be read from, for the pump loop itself.

    A `None` in the script means "go quiet" -- the read blocks, which is the
    only situation in which a deadline can be the thing that wakes the pump.
    Running out of script is a clean close, exactly as websockets reports one.
    """

    def __init__(self, script: list[dict | None]) -> None:
        super().__init__()
        self.script = list(script)

    async def recv(self) -> str:
        if not self.script:
            raise ConnectionClosedOK(None, None)
        event = self.script.pop(0)
        if event is None:
            await asyncio.sleep(3600)
        return json.dumps(event)


class _Relay(_RelaySession):
    """The real relay, with the persistence call captured instead of scheduled.

    _emit_turn is overridden rather than stubbed with a Mock so the blank-text
    guard and the counters still run: what is recorded here is exactly what the
    turn writer would have been handed.
    """

    __slots__ = ("emitted",)

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.emitted: list[tuple[str, str, str]] = []

    def _emit_turn(self, sender: str, text: str, provider_turn_id: str) -> None:
        self.emitted.append((sender, text, provider_turn_id))
        super()._emit_turn(sender, text, provider_turn_id)


def make_relay(spec_key: str | None = "hr") -> tuple[_Relay, _FakeUpstream, _FakeBrowser]:
    browser = _FakeBrowser()
    relay = _Relay(
        browser,
        "c0ffee123456",
        on_turn=None,
        specialization=SPECIALIZATIONS[spec_key] if spec_key else None,
    )
    upstream = _FakeUpstream()
    relay._upstream = upstream
    return relay, upstream, browser


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Sequence helpers -- the event shapes upstream actually sends
# ---------------------------------------------------------------------------


async def ask_question(relay: _Relay, response_id: str = "resp_1", status: str = "completed"):
    """Drive one interviewer turn from created to done.

    _expecting_response is set first because that is what the handshake (and
    _advance_turn) leave behind; without it the relay would correctly read the
    response as server-created and trip the D2 guard.
    """
    relay._expecting_response = True
    await relay._handle_upstream_event(
        {"type": "response.created", "response": {"id": response_id}}
    )
    await relay._handle_upstream_event(
        {"type": "response.done", "response": {"id": response_id, "status": status}}
    )


async def student_says(relay: _Relay, item_id: str, transcript: str, commit: bool = True):
    """One complete student utterance: speech_stopped -> committed -> transcript."""
    await relay._handle_upstream_event({"type": "input_audio_buffer.speech_stopped"})
    if commit:
        await relay._handle_upstream_event(
            {"type": "input_audio_buffer.committed", "item_id": item_id}
        )
    await relay._handle_upstream_event(
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": item_id,
            "transcript": transcript,
        }
    )


_GOOD_ANSWER = "I led the campus fintech club and grew it to eighty members"


# ---------------------------------------------------------------------------
# The happy path
# ---------------------------------------------------------------------------


class TestOneQuestionPerAnswer:
    def test_one_answer_produces_exactly_one_next_question(self):
        """The whole point of v3: the create happens AFTER the transcript.

        If this goes red, either the relay stopped creating responses (a dead
        interview) or it started creating more than one per answer (the bug v3
        was written to remove).
        """
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay)
            assert relay._question_open is True
            await student_says(relay, "item_1", _GOOD_ANSWER)

        run(scenario())

        assert len(upstream.creates) == 1
        create = upstream.creates[0]
        # "next" carries no instructions: the session persona, already re-sent
        # for this phase, is the right one.
        assert "instructions" not in create["response"]
        assert create["response"]["conversation"] == "auto"
        assert ("user", _GOOD_ANSWER, "u:item_1") in relay.emitted
        assert relay._question_open is False

    def test_the_phase_moves_before_the_question_is_asked(self):
        """M7: a session.update sent AFTER the create steers the question after
        next, so the arc was permanently one response late and the interview
        asked a sixth question instead of delivering its verdict."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay)
            await student_says(relay, "item_1", _GOOD_ANSWER)

        run(scenario())

        assert relay._machine.phase is InterviewPhase.PROBING
        types = [event["type"] for event in upstream.sent]
        assert types.index("session.update") < types.index("response.create")
        assert [c["type"] for c in browser.control].count("reep.phase") == 1

    def test_the_generic_interview_still_gets_a_next_question(self):
        """S5: the phase tick is gated on a specialization and the CREATE is
        not. Gating both would leave `/api/interview` with no ?specialization=
        permanently silent after the first answer."""
        relay, upstream, browser = make_relay(spec_key=None)

        async def scenario():
            await ask_question(relay)
            await student_says(relay, "item_1", _GOOD_ANSWER)

        run(scenario())

        assert len(upstream.creates) == 1
        assert upstream.of_type("session.update") == []
        assert relay._machine.phase is InterviewPhase.OPENING


# ---------------------------------------------------------------------------
# The three ways a turn can resolve
# ---------------------------------------------------------------------------


class TestTurnResolution:
    def test_a_failed_transcription_still_advances_the_interview(self):
        """M5 + the safety property v3 gives up: under create_response:false a
        transcription that never resolves is an interview that never continues.
        A `.failed` must ask the student to repeat, not stop the world."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay)
            await relay._handle_upstream_event({"type": "input_audio_buffer.speech_stopped"})
            await relay._handle_upstream_event(
                {
                    "type": "conversation.item.input_audio_transcription.failed",
                    "item_id": "item_1",
                    "error": {"type": "invalid_request_error", "code": "audio_too_short"},
                }
            )

        run(scenario())

        assert len(upstream.creates) == 1
        assert "did not hear" in upstream.creates[0]["response"]["instructions"]
        # An unheard turn is not an answer, so the arc does not move.
        assert relay._machine.answers == 0
        assert relay._machine.phase is InterviewPhase.OPENING
        assert relay._last_error.startswith("transcription:")

    def test_a_transcript_that_never_arrives_times_out_and_the_interview_goes_on(self):
        """S1: the idle watchdog cannot save us here -- the browser's echo-gate
        keepalive keeps _last_audio_at fresh through any amount of silence, so
        without this deadline only the 15-minute cap ends the session, with no
        verdict."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay)
            await relay._handle_upstream_event({"type": "input_audio_buffer.speech_stopped"})
            assert relay._earliest_deadline() is not None
            # Age the entry rather than sleeping for the real 8 seconds.
            for entry in relay._pending.values():
                entry.deadline_at = 0.0
            await relay._on_deadline()

        run(scenario())

        assert len(upstream.creates) == 1
        assert "did not hear" in upstream.creates[0]["response"]["instructions"]
        assert relay._machine.answers == 0
        # Consumed, so the deadline cannot fire twice for one utterance.
        assert relay._pending == {}

    def test_two_utterances_resolving_out_of_order_produce_ONE_question(self):
        """DF3: the student paused mid-answer, VAD split it in two, and the
        interviewer asked two questions -- a real complaint about the pre-v3
        build. The drain pops the whole resolved head and _advance_turn runs
        once, with the transcripts joined."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay)
            # Both halves are committed before either transcript lands.
            await relay._handle_upstream_event({"type": "input_audio_buffer.speech_stopped"})
            await relay._handle_upstream_event(
                {"type": "input_audio_buffer.committed", "item_id": "item_1"}
            )
            await relay._handle_upstream_event({"type": "input_audio_buffer.speech_stopped"})
            await relay._handle_upstream_event(
                {"type": "input_audio_buffer.committed", "item_id": "item_2"}
            )
            # The SECOND transcript arrives first: the head is still unresolved,
            # so nothing may be drained yet.
            await relay._handle_upstream_event(
                {
                    "type": "conversation.item.input_audio_transcription.completed",
                    "item_id": "item_2",
                    "transcript": "and then we shipped it in one term",
                }
            )
            assert upstream.creates == []
            await relay._handle_upstream_event(
                {
                    "type": "conversation.item.input_audio_transcription.completed",
                    "item_id": "item_1",
                    "transcript": "I led the campus fintech club",
                }
            )

        run(scenario())

        assert len(upstream.creates) == 1
        # One row per utterance is unchanged -- the record is per utterance,
        # the QUESTION is per answer.
        assert [turn[2] for turn in relay.emitted if turn[0] == "user"] == [
            "u:item_1",
            "u:item_2",
        ]
        assert relay._machine.answers == 1

    def test_a_duplicate_transcript_cannot_ask_a_second_question(self):
        """DF2: .completed delivered twice would otherwise arm a new entry, drain
        it, and ask a question for an answer that was already handled."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay)
            await student_says(relay, "item_1", _GOOD_ANSWER)
            await relay._handle_upstream_event(
                {
                    "type": "conversation.item.input_audio_transcription.completed",
                    "item_id": "item_1",
                    "transcript": _GOOD_ANSWER,
                }
            )

        run(scenario())

        assert len(upstream.creates) == 1
        assert relay._machine.answers == 1

    def test_the_turn_survives_input_audio_buffer_committed_never_arriving(self):
        """The one thing §2.1 admits it cannot verify. Nothing may depend on
        `committed`: the deadline is armed at speech_stopped and the transcript
        resolves the entry by position when it carries an id we never saw."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay)
            await student_says(relay, "item_1", _GOOD_ANSWER, commit=False)

        run(scenario())

        assert len(upstream.creates) == 1
        assert ("user", _GOOD_ANSWER, "u:item_1") in relay.emitted

    def test_a_late_transcript_cannot_resurrect_a_turn_the_deadline_popped(self):
        """The duplicate guard has to work when `committed` NEVER ARRIVES.

        §2.1 says flatly that `input_audio_buffer.committed` is unverified under
        create_response:false and that "the design therefore never depends on
        it". The memo in _drain_pending did depend on it: it only remembered
        entries that had an item_id, and the deadline path leaves that None. So
        a transcript that landed one second after an 8 s timeout was not
        recognised as a duplicate at all -- it armed a FRESH entry and the
        student's one utterance became two interview_turns rows (blank + real),
        a second question, a spurious "you spoke before I had finished asking",
        and a 0.0 s sample in asrP50. That last one is circular and is why this
        test exists: the telemetry that validates
        interview_transcription_timeout_ms was being fed by the timeout.
        """
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay)
            # No `committed`, so the entry never learns an item_id.
            await relay._handle_upstream_event({"type": "input_audio_buffer.speech_stopped"})
            for entry in relay._pending.values():
                entry.deadline_at = 0.0
            await relay._on_deadline()
            assert len(upstream.creates) == 1
            # The transcriber was simply slower than the deadline.
            await relay._handle_upstream_event(
                {
                    "type": "conversation.item.input_audio_transcription.completed",
                    "item_id": "item_1",
                    "transcript": _GOOD_ANSWER,
                }
            )

        run(scenario())

        assert len(upstream.creates) == 1
        assert [e for e in relay.emitted if e[0] == "user"] == [("user", "", "u:p1")]
        assert relay._pending == {}
        # A deadline is not a measurement of the transcriber.
        assert relay._asr_samples == []

    def test_the_resolved_memo_evicts_the_oldest_instead_of_refusing_the_newest(self):
        """A silently-lossy cache guarding correctness is the wrong shape.

        Past _MAX_RESOLVED_ITEMS the memo used to stop accepting entries, so
        from utterance 65 on a duplicate .completed resurrected the turn even
        when `committed` HAD arrived. The newest id is precisely the one a
        duplicate is about to arrive for, so refusing it is the one eviction
        policy that cannot work.
        """
        relay, upstream, browser = make_relay()
        for n in range(_MAX_RESOLVED_ITEMS):
            relay._memoise_resolved(f"old_{n}")

        async def scenario():
            await ask_question(relay)
            await student_says(relay, "item_65", _GOOD_ANSWER)
            await relay._handle_upstream_event(
                {
                    "type": "conversation.item.input_audio_transcription.completed",
                    "item_id": "item_65",
                    "transcript": _GOOD_ANSWER,
                }
            )

        run(scenario())

        assert "item_65" in relay._resolved_items
        assert len(relay._resolved_items) <= _MAX_RESOLVED_ITEMS
        assert len(upstream.creates) == 1
        assert relay._machine.answers == 1


# ---------------------------------------------------------------------------
# What counts as an answer
# ---------------------------------------------------------------------------


class TestAnswerClassification:
    def test_barge_in_over_an_unfinished_question_is_not_an_answer(self):
        """§4.2/§4.5: a cancelled response never asked anything, so what the
        student said cannot be an answer to it. Counting it advances the arc on
        utterances that answered nothing -- M7 from the other direction."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay, status="cancelled")
            assert relay._question_open is False
            assert relay._partial_question is True
            await student_says(relay, "item_1", _GOOD_ANSWER)

        run(scenario())

        assert len(upstream.creates) == 1
        # Not a new question: finish the one that was interrupted.
        assert "finish the question" in upstream.creates[0]["response"]["instructions"]
        assert relay._machine.answers == 0

    def test_a_question_that_completed_does_open_the_arc(self):
        """The other half of the pair above: the same utterance, after a
        question that was actually asked, must count."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay, status="completed")
            await student_says(relay, "item_1", _GOOD_ANSWER)

        run(scenario())

        assert relay._machine.answers == 1
        assert "instructions" not in upstream.creates[0]["response"]

    def test_an_incomplete_question_counts_as_asked(self):
        """The student heard most of it, so their reply is an answer."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay, status="incomplete")
            await student_says(relay, "item_1", _GOOD_ANSWER)

        run(scenario())

        assert relay._machine.answers == 1

    def test_a_two_word_answer_earns_a_clarification_and_no_tick(self):
        """D1's first half. A model asked to "probe deeper" cannot be trusted to
        stay on the question, so the arc must not move on an answer that said
        nothing."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay)
            await student_says(relay, "item_1", "yes okay")

        run(scenario())

        assert len(upstream.creates) == 1
        assert "too brief" in upstream.creates[0]["response"]["instructions"]
        assert relay._machine.answers == 0
        assert relay._clarifications == 1

    def test_the_clarification_budget_is_spent_and_the_interview_moves_on(self):
        """D1's second half, and the one that matters more: a student who
        genuinely cannot answer must not be pinned on question two until the
        hard cap ends the interview with no verdict at all."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay, "resp_1")
            await student_says(relay, "item_1", "yes okay")
            assert relay._machine.answers == 0
            # The clarification is asked and answered just as briefly.
            await ask_question(relay, "resp_2")
            await student_says(relay, "item_2", "i think so")

        with_cap = settings.interview_max_clarifications_per_question
        assert with_cap == 1, "this test pins the default budget"
        run(scenario())

        assert len(upstream.creates) == 2
        # Second time round the budget is gone, so the answer is taken as given
        # and the arc moves rather than looping.
        assert relay._machine.answers == 1
        assert relay._clarifications == 0

    def test_an_accepted_answer_resets_the_clarification_budget(self):
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay, "resp_1")
            await student_says(relay, "item_1", "yes okay")
            assert relay._clarifications == 1
            await ask_question(relay, "resp_2")
            await student_says(relay, "item_2", _GOOD_ANSWER)

        run(scenario())

        assert relay._clarifications == 0
        assert relay._machine.answers == 1


# ---------------------------------------------------------------------------
# Collisions, stalls and the guard that cannot be verified from here
# ---------------------------------------------------------------------------


class TestCollisionsAndStalls:
    def test_an_utterance_during_a_live_response_defers_instead_of_colliding(self):
        """DF4: creating while a response is live earns
        `conversation_already_has_active_response` and a warning banner
        mid-interview. The turn is queued, never dropped."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay, "resp_1")
            # A second question is in flight when the student's words land.
            relay._expecting_response = True
            await relay._handle_upstream_event(
                {"type": "response.created", "response": {"id": "resp_2"}}
            )
            await student_says(relay, "item_1", _GOOD_ANSWER)
            assert upstream.creates == []
            assert relay._deferred is not None
            await relay._handle_upstream_event(
                {"type": "response.done", "response": {"id": "resp_2", "status": "completed"}}
            )

        run(scenario())

        assert len(upstream.creates) == 1
        assert relay._deferred is None

    def test_a_refused_create_waits_for_the_live_response_instead_of_cancelling(self):
        """S3: cancelling here would kill the question currently being asked --
        the worst outcome available."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay, "resp_1")
            await student_says(relay, "item_1", _GOOD_ANSWER)
            create_id = upstream.creates[0]["event_id"]
            await relay._handle_upstream_event(
                {
                    "type": "error",
                    "error": {
                        "type": "invalid_request_error",
                        "code": "conversation_already_has_active_response",
                        "event_id": create_id,
                    },
                }
            )

        run(scenario())

        assert upstream.of_type("response.cancel") == []
        assert len(upstream.creates) == 1  # no retry
        assert relay._deferred is not None
        # And the student is not shown a banner for something we are handling.
        assert [c for c in browser.control if c["type"] == "reep.error"] == []

    def test_a_create_that_is_never_acknowledged_retries_once_then_ends_4011(self):
        """S2: a silently dropped create is an interview that never continues,
        and no guardrail we have measures questions -- they all measure audio."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay)
            await student_says(relay, "item_1", _GOOD_ANSWER)
            relay._create_deadline = 0.0
            await relay._on_deadline()
            assert len(upstream.creates) == 2
            relay._create_deadline = 0.0
            with pytest.raises(_SessionEnded) as caught:
                await relay._on_deadline()
            return caught.value

        ended = run(scenario())
        assert ended.code == _CLOSE_TURN_STALLED == 4011

    def test_a_retry_does_not_disown_the_create_it_is_retrying(self):
        """The retry used to overwrite the one id the relay could recognise.

        Upstream congestion is exactly what causes the retry, so the create
        being retried is very often acknowledged LATE. When it was, the ack
        cleared _pending_create_id, upstream refused the retry with
        `conversation_already_has_active_response`, and the S3 branch -- whose
        own comment says it is "deliberately not forwarded" -- no longer
        recognised the id. The student got a warning banner mid-interview: the
        precise outcome DF4/S3 exist to prevent.
        """
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay)
            await student_says(relay, "item_1", _GOOD_ANSWER)
            first_create_id = upstream.creates[0]["event_id"]
            relay._create_deadline = 0.0
            await relay._on_deadline()
            retry_id = upstream.creates[1]["event_id"]
            assert retry_id != first_create_id
            # The original create is acknowledged after the retry went out.
            await relay._handle_upstream_event(
                {"type": "response.created", "response": {"id": "resp_2"}}
            )
            await relay._handle_upstream_event(
                {
                    "type": "error",
                    "error": {
                        "type": "invalid_request_error",
                        "code": "conversation_already_has_active_response",
                        "event_id": retry_id,
                    },
                }
            )

        run(scenario())

        assert [c for c in browser.control if c["type"] == "reep.error"] == []
        assert upstream.of_type("response.cancel") == []
        assert len(upstream.creates) == 2  # the retry, and no third create

    def test_the_relay_does_not_read_its_own_retry_as_a_server_created_response(self):
        """D2 turned against itself, which is the worst way to fail it.

        Both creates being accepted -- the slow original and the retry -- means
        the SECOND response.created arrives with _expecting_response already
        False. Read positionally that looked like upstream creating responses on
        its own, so the relay accused turn_detection.create_response=false of
        not being in effect (the one upstream behaviour §2.6 says cannot be
        verified from here) and then, via _server_created_response, skipped its
        own next create -- costing the student a question on top of a false
        diagnosis.
        """
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay)
            await student_says(relay, "item_1", _GOOD_ANSWER)
            relay._create_deadline = 0.0
            await relay._on_deadline()
            assert len(upstream.creates) == 2
            # The original create is acknowledged, runs and finishes...
            await relay._handle_upstream_event(
                {"type": "response.created", "response": {"id": "resp_2"}}
            )
            await relay._handle_upstream_event(
                {"type": "response.done", "response": {"id": "resp_2", "status": "completed"}}
            )
            # ...and only then does upstream get to the queued retry.
            await relay._handle_upstream_event(
                {"type": "response.created", "response": {"id": "resp_3"}}
            )

        run(scenario())

        assert relay._server_created_response is False
        assert relay._last_error != "vad:server_created_response"

    def test_a_server_created_response_makes_the_relay_stand_down(self):
        """D2: if create_response:false did not take, both parties create a
        response and the student gets two questions at once -- the exact bug,
        doubled. Detected positionally and degraded to the old behaviour."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay)
            # Nothing of ours is outstanding, so this one is upstream's.
            await relay._handle_upstream_event(
                {"type": "response.created", "response": {"id": "resp_server"}}
            )
            assert relay._server_created_response is True
            await relay._handle_upstream_event(
                {"type": "response.done", "response": {"id": "resp_server", "status": "completed"}}
            )
            await student_says(relay, "item_1", _GOOD_ANSWER)

        run(scenario())

        assert upstream.creates == []
        assert relay._last_error == "vad:server_created_response"

    def test_the_handshake_refuses_a_session_that_ignored_create_response(self):
        """H4: refusing beats running a known-double interview in front of a
        student."""
        relay, upstream, browser = make_relay()
        with pytest.raises(_SessionEnded) as caught:
            relay._verify_turn_detection(
                {"turn_detection": {"type": "server_vad", "create_response": True}}
            )
        assert caught.value.code == _CLOSE_UPSTREAM_UNAVAILABLE

        # Absent is NOT proof of anything and must not end the interview: the
        # runtime guard covers it.
        relay._verify_turn_detection({"turn_detection": {"type": "server_vad"}})

    def test_barge_in_thrashing_stops_the_relay_cancelling(self):
        """D3: a room where VAD fires on the interviewer's own voice otherwise
        produces fifteen minutes of interrupted questions and no answers."""
        relay, upstream, browser = make_relay()

        async def scenario():
            for index in range(_MAX_BARGEIN_THRASH):
                relay._expecting_response = True
                await relay._handle_upstream_event(
                    {"type": "response.created", "response": {"id": f"resp_{index}"}}
                )
                await relay._on_speech_started()
                await relay._handle_upstream_event(
                    {
                        "type": "response.done",
                        "response": {"id": f"resp_{index}", "status": "cancelled"},
                    }
                )
            assert relay._bargein_disabled is True
            # The next question is left alone.
            relay._expecting_response = True
            await relay._handle_upstream_event(
                {"type": "response.created", "response": {"id": "resp_last"}}
            )
            cancels_before = len(upstream.of_type("response.cancel"))
            await relay._on_speech_started()
            return cancels_before, len(upstream.of_type("response.cancel"))

        before, after = run(scenario())
        assert before == after == _MAX_BARGEIN_THRASH
        assert relay._last_error == "bargein:thrashing"


class TestThePumpLoop:
    """The `async for` that became an explicit loop, because the deadlines have
    to run on the task that already owns turn state and downstream sends."""

    def test_it_still_forwards_events_and_still_ends_on_a_clean_close(self):
        relay, _, browser = make_relay()
        upstream = _ScriptedUpstream([{"type": "input_audio_buffer.speech_started"}])
        relay._upstream = upstream

        async def scenario():
            with pytest.raises(_SessionEnded) as caught:
                await relay._pump_upstream_to_client(upstream)
            return caught.value

        ended = run(scenario())

        # A clean close mid-interview is still the service hanging up on us.
        assert ended.code == _CLOSE_UPSTREAM_UNAVAILABLE
        assert any(c["type"] == "input_audio_buffer.speech_started" for c in browser.control)

    def test_a_deadline_fires_between_reads_while_upstream_says_nothing(self):
        """S1's shape end to end: upstream has gone quiet holding a transcript,
        and the only thing that can rescue the interview is the pump's own
        clock. If this goes red the deadlines are armed but never enforced."""
        relay, _, browser = make_relay()
        upstream = _ScriptedUpstream([None])
        relay._upstream = upstream

        async def scenario():
            relay._question_open = True
            entry = relay._arm_answer_deadline("item_1")
            entry.deadline_at = time.monotonic() - 1
            with pytest.raises(_SessionEnded):
                await relay._pump_upstream_to_client(upstream)

        run(scenario())

        assert len(upstream.creates) == 1
        assert relay._pending == {}


class TestTheTwoBeatClose:
    """WRAP_UP is now two turns: "any questions for us?", THEN the verdict."""

    def test_entering_wrap_up_invites_candidate_questions_not_the_verdict(self):
        """The fifth accepted answer used to produce the verdict immediately.
        A real interview hands the floor to the candidate first."""
        relay, upstream, browser = make_relay()

        async def scenario():
            for index in range(5):
                await ask_question(relay, f"resp_{index}")
                await student_says(relay, f"item_{index}", _GOOD_ANSWER)

        run(scenario())

        assert relay._machine.phase is InterviewPhase.WRAP_UP
        assert relay._awaiting_candidate_questions is True
        assert relay._verdict_requested is False
        invite = upstream.creates[-1]
        instructions = invite["response"]["instructions"]
        assert "any questions for you" in instructions
        assert "Do not deliver the verdict yet" in instructions
        # The base persona leads even on this turn -- the override REPLACES the
        # session persona, so it must be self-contained.
        assert instructions.startswith("You are a strict yet constructive AI Mock Interviewer")

    def test_the_invite_response_done_does_not_trigger_the_scorecard(self):
        """Only the VERDICT's response.done may request the report. Gating on
        the phase alone fired the scorecard one turn early -- before the
        student had answered, and before any verdict was spoken."""
        relay, upstream, browser = make_relay()

        async def scenario():
            for index in range(5):
                await ask_question(relay, f"resp_{index}")
                await student_says(relay, f"item_{index}", _GOOD_ANSWER)
            await ask_question(relay, "resp_invite")

        run(scenario())

        assert relay._report_requested is False
        report_creates = [c for c in upstream.creates if "report" in c["event_id"]]
        assert report_creates == []

    def test_no_im_good_proceeds_to_the_verdict_with_no_clarify(self):
        """"No, I'm good" / "no, thanks" is filler to the word gate, and the
        reply to "any questions?" is NEVER judged: a student closing politely
        must not be re-asked on the last turn of their interview."""
        for closing in ("no, thanks", "no I'm good"):
            relay, upstream, browser = make_relay()

            async def scenario():
                for index in range(5):
                    await ask_question(relay, f"resp_{index}")
                    await student_says(relay, f"item_{index}", _GOOD_ANSWER)
                await ask_question(relay, "resp_invite")
                await student_says(relay, "item_questions", closing)

            run(scenario())

            assert relay._verdict_requested is True
            assert relay._awaiting_candidate_questions is False
            verdict_create = upstream.creates[-1]
            # The verdict goes out with NO per-response override: the session
            # instructions already carry the WRAP_UP directive from the phase
            # push, and they are exactly the right ones.
            assert "instructions" not in verdict_create["response"]
            # Exactly ONE create for that reply -- never a clarify first.
            assert "too brief" not in json.dumps(upstream.creates)
            # And the verdict's response.done is what finally asks for the
            # scorecard -- exactly once.
            async def verdict():
                await ask_question(relay, "resp_verdict")

            run(verdict())
            report_creates = [c for c in upstream.creates if "report" in c["event_id"]]
            assert len(report_creates) == 1

    def test_a_student_question_gets_an_answer_then_the_verdict(self):
        """The other half of the beat: the student HAS a question. Same wire
        shape -- the model answers in character, then the verdict."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await reach_wrap_up(relay)
            await ask_question(relay, "resp_verdict")

        run(scenario())

        assert relay._report_requested is True
        report_creates = [c for c in upstream.creates if "report" in c["event_id"]]
        assert len(report_creates) == 1

    def test_the_forced_wrap_up_skips_the_candidate_questions_beat(self):
        """The clock path has no time for "any questions?": straight to the
        verdict, and the verdict's response.done requests the report."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay, "resp_1")
            await student_says(relay, "item_1", _GOOD_ANSWER)
            await ask_question(relay, "resp_2")
            relay._wrap_up_deadline = 0.0
            await relay._on_deadline()

        run(scenario())

        assert relay._awaiting_candidate_questions is False
        assert relay._verdict_requested is True
        assert "deliver the closing verdict" in upstream.creates[-1]["response"]["instructions"]

    def test_the_clock_ending_the_beat_goes_straight_to_the_verdict(self):
        """The reserve deadline can land while the student is THINKING of a
        question to ask. The interview must still close out: an early verdict
        beats the hard cap arriving with no verdict at all."""
        relay, upstream, browser = make_relay()

        async def scenario():
            for index in range(5):
                await ask_question(relay, f"resp_{index}")
                await student_says(relay, f"item_{index}", _GOOD_ANSWER)
            await ask_question(relay, "resp_invite")
            assert relay._awaiting_candidate_questions is True
            relay._wrap_up_deadline = 0.0
            await relay._on_deadline()
            await ask_question(relay, "resp_verdict")

        run(scenario())

        assert relay._awaiting_candidate_questions is False
        verdict_creates = [
            c for c in upstream.creates
            if "deliver the closing verdict" in c["response"].get("instructions", "")
        ]
        assert len(verdict_creates) == 1
        assert relay._report_requested is True


# ---------------------------------------------------------------------------
# The report
# ---------------------------------------------------------------------------


_REPORT_JSON = json.dumps(
    {
        "overall": 71,
        "communication": 68,
        "domain": 74,
        "structure": 70,
        "strengths": ["clear structure", "good examples"],
        "improvements": ["quantify the impact"],
        "drill": "Rewrite two STAR answers with numbers in them.",
        "summary": "A solid session with room to be more concrete.",
    }
)


async def reach_wrap_up(relay: _Relay):
    """Five accepted answers PLUS the candidate-questions beat -- the arc as a
    student actually walks it since the two-beat close: the tick into WRAP_UP
    asks "any questions for us?" first, and the student's reply (any reply --
    it is deliberately never classify_answer'd) is what earns the verdict."""
    for index in range(5):
        await ask_question(relay, f"resp_{index}")
        await student_says(relay, f"item_{index}", _GOOD_ANSWER)
    assert relay._machine.phase is InterviewPhase.WRAP_UP
    assert relay._awaiting_candidate_questions is True
    # The invite is asked and finished, and its response.done must NOT trigger
    # the scorecard -- only the verdict's may.
    await ask_question(relay, "resp_invite")
    assert relay._report_requested is False
    await student_says(
        relay, "item_questions", "Yes, what does growth look like in this role?"
    )
    assert relay._verdict_requested is True


def report_done_event(text: str, response_id: str = "resp_report", status: str = "completed"):
    return {
        "type": "response.done",
        "response": {
            "id": response_id,
            "status": status,
            "output": [{"content": [{"type": "output_text", "text": text}]}],
        },
    }


class TestTheReport:
    def test_wrap_up_produces_a_text_only_scorecard_request(self):
        relay, upstream, browser = make_relay()

        async def scenario():
            await reach_wrap_up(relay)
            # The verdict is spoken, and IS persisted -- the student heard it.
            await ask_question(relay, "resp_verdict")

        run(scenario())

        report_create = upstream.creates[-1]
        body = report_create["response"]
        assert body.get("modalities") == ["text"] or body.get("output_modalities") == ["text"]
        assert body["conversation"] == "auto"
        assert body["max_output_tokens"] == 800
        assert "single JSON object" in body["instructions"]
        # No student text is ever composed into an instruction (rule 1's shape).
        assert _GOOD_ANSWER not in body["instructions"]
        # The SPOKEN verdict is a turn of the interview -- the student heard it,
        # so it is persisted like any other. It is the scorecard, not the
        # verdict, that must never appear as an interviewer turn.
        assert ("assistant", "", "a:resp_verdict") in relay.emitted

    def test_the_scorecard_is_never_cancelled_by_the_student_speaking(self):
        """§5.5, and the only place in this design where the correct action is
        to ignore the student's voice: "thanks, bye" while the JSON generates
        would otherwise destroy the feature's headline output."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await reach_wrap_up(relay)
            await ask_question(relay, "resp_verdict")
            relay._expecting_report = True
            await relay._handle_upstream_event(
                {"type": "response.created", "response": {"id": "resp_report"}}
            )
            assert relay._report_response_id == "resp_report"
            cancels_before = len(upstream.of_type("response.cancel"))
            flushes_before = len([c for c in browser.control if c["type"] == "reep.audio.flush"])
            await relay._on_speech_started()
            return (
                cancels_before,
                len(upstream.of_type("response.cancel")),
                flushes_before,
                len([c for c in browser.control if c["type"] == "reep.audio.flush"]),
            )

        cancels_before, cancels_after, flushes_before, flushes_after = run(scenario())
        assert cancels_before == cancels_after
        # Not flushed either: there is nothing playing, and a flush would only
        # cut the tail of the verdict the student is still hearing.
        assert flushes_before == flushes_after
        assert relay._active_response_id == "resp_report"

    def test_the_scorecard_is_never_emitted_as_an_interviewer_turn(self):
        """DF5: without the early return, raw JSON lands in the student's chat
        history and in GET /api/agent/history as something the interviewer
        said."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await reach_wrap_up(relay)
            await ask_question(relay, "resp_verdict")
            relay._expecting_report = True
            await relay._handle_upstream_event(
                {"type": "response.created", "response": {"id": "resp_report"}}
            )
            with pytest.raises(_SessionEnded) as caught:
                await relay._handle_upstream_event(report_done_event(_REPORT_JSON))
            return caught.value

        ended = run(scenario())

        assert ended.code == _CLOSE_OK == 1000
        assert all("resp_report" not in turn[2] for turn in relay.emitted)
        reports = [c for c in browser.control if c["type"] == "reep.report"]
        assert len(reports) == 1
        assert reports[0]["available"] is True
        assert reports[0]["report"]["overall"] == 71
        assert reports[0]["report"]["strengths"] == ["clear structure", "good examples"]
        # response.done for the report is not forwarded either.
        assert all(
            c.get("response_id") != "resp_report"
            for c in browser.control
            if c["type"] == "response.done"
        )

    def test_an_unparseable_scorecard_still_completes_the_interview(self):
        """§5.3: every report failure is a payload, never a close code -- the
        interview completed, and only the scorecard did not."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await reach_wrap_up(relay)
            await ask_question(relay, "resp_verdict")
            relay._expecting_report = True
            await relay._handle_upstream_event(
                {"type": "response.created", "response": {"id": "resp_report"}}
            )
            with pytest.raises(_SessionEnded) as caught:
                await relay._handle_upstream_event(
                    report_done_event("I am sorry, I cannot produce that.")
                )
            return caught.value

        ended = run(scenario())

        assert ended.code == _CLOSE_OK == 1000
        payload = [c for c in browser.control if c["type"] == "reep.report"][0]
        assert payload["available"] is False
        assert payload["reason"] == "unparseable"
        assert payload["report"] is None
        assert relay._report_status == "unparseable"

    def test_a_scorecard_that_never_arrives_times_out_and_still_closes_1000(self):
        """S7. The student is sitting on a finished interview; a report that
        hangs must not also cost them the close code that says it worked."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await reach_wrap_up(relay)
            await ask_question(relay, "resp_verdict")
            assert relay._report_deadline is not None
            relay._report_deadline = 0.0
            with pytest.raises(_SessionEnded) as caught:
                await relay._on_deadline()
            return caught.value

        ended = run(scenario())
        assert ended.code == _CLOSE_OK
        payload = [c for c in browser.control if c["type"] == "reep.report"][0]
        assert payload["reason"] == "timeout"

    def test_the_report_is_settled_exactly_once(self):
        """DF6: the deadline and a late response.done can both arrive."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await reach_wrap_up(relay)
            await ask_question(relay, "resp_verdict")
            relay._expecting_report = True
            await relay._handle_upstream_event(
                {"type": "response.created", "response": {"id": "resp_report"}}
            )
            relay._report_deadline = 0.0
            with pytest.raises(_SessionEnded):
                await relay._on_deadline()
            # The real response turns up afterwards and must change nothing.
            await relay._handle_upstream_event(report_done_event(_REPORT_JSON))

        run(scenario())

        assert relay._report_status == "timeout"
        assert len([c for c in browser.control if c["type"] == "reep.report"]) == 1

    def test_a_verdict_cancelled_by_barge_in_is_re_created_once(self):
        """S6: a verdict lost to a cough must not cost the scorecard as well."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await reach_wrap_up(relay)
            await ask_question(relay, "resp_verdict", status="cancelled")
            assert relay._verdict_retried is True
            retry = upstream.creates[-1]
            assert "deliver the closing verdict" in retry["response"]["instructions"]
            # Cancelled a second time: the report happens regardless.
            await ask_question(relay, "resp_verdict_2", status="cancelled")

        run(scenario())

        assert relay._report_requested is True

    def test_the_session_cap_closing_in_forces_a_verdict_while_there_is_time(self):
        """S8: the tail of the original bug. Without this a five-answer
        interview can hit the 15-minute cap mid-verdict and produce nothing at
        all -- and "nothing at all" is what the whole engine exists to remove."""
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay, "resp_1")
            await student_says(relay, "item_1", _GOOD_ANSWER)
            # The easy half: nothing is in flight when the clock runs out, so
            # _force_wrap_up's create goes straight out. The hard half -- a
            # response still being spoken, which is the ordinary case because
            # the reserve is a wall-clock instant unrelated to turn boundaries
            # -- is the test below, and this one used to be the only one.
            await ask_question(relay, "resp_2")
            assert relay._machine.phase is InterviewPhase.PROBING
            assert relay._wrap_up_deadline is not None
            relay._wrap_up_deadline = 0.0
            await relay._on_deadline()

        run(scenario())

        assert relay._machine.phase is InterviewPhase.WRAP_UP
        # Deliberately not counted as an answer: a mentor reading the answer
        # count must be reading answers, not deadlines.
        assert relay._machine.answers == 1
        assert "deliver the closing verdict" in upstream.creates[-1]["response"]["instructions"]
        # Disarmed, or the pump would spin on an expired deadline.
        assert relay._wrap_up_deadline is None

    def test_a_forced_wrap_up_during_a_live_response_still_speaks_the_verdict(self):
        """S8 promises "a slightly early verdict", not "no verdict at all".

        The reserve clock is a wall-clock instant with no relationship to turn
        boundaries, so the ordinary case is that question N is still being
        spoken when it lands. _force_wrap_up's _advance_turn("verdict") then
        DEFERS (DF4), and _on_response_done used to take the WRAP_UP branch
        before it ever looked at _deferred: it went straight into
        _request_report and the deferred verdict was dropped on the floor. The
        student heard an ordinary probing question and then watched the socket
        close 1000 with a report panel, and the last assistant row in
        interview_turns was a QUESTION stamped phase='wrap_up'.
        """
        relay, upstream, browser = make_relay()

        async def scenario():
            await ask_question(relay, "resp_1")
            await student_says(relay, "item_1", _GOOD_ANSWER)
            # The question that answer earned is created and is still being
            # spoken -- created, not done.
            await relay._handle_upstream_event(
                {"type": "response.created", "response": {"id": "resp_2"}}
            )
            assert relay._active_response_id == "resp_2"
            relay._wrap_up_deadline = 0.0
            await relay._on_deadline()
            assert relay._machine.phase is InterviewPhase.WRAP_UP
            # Deferred, because a create now would collide with resp_2.
            assert relay._deferred is not None and relay._deferred.kind == "verdict"
            await relay._handle_upstream_event(
                {"type": "response.done", "response": {"id": "resp_2", "status": "completed"}}
            )
            # The verdict must be ASKED FOR before the scorecard is.
            assert relay._report_requested is False
            assert "deliver the closing verdict" in upstream.creates[-1]["response"]["instructions"]
            # And the scorecard follows the verdict, exactly as on the arc path.
            await ask_question(relay, "resp_verdict")

        run(scenario())

        assert relay._report_requested is True
        assert relay._deferred is None
        assert ("assistant", "", "a:resp_verdict") in relay.emitted

    def test_the_generic_interview_also_gets_a_forced_verdict(self):
        """It has no phase arc to reach WRAP_UP through, so the clock is the
        only route it has to a report at all."""
        relay, upstream, browser = make_relay(spec_key=None)

        async def scenario():
            await ask_question(relay, "resp_1")
            relay._wrap_up_deadline = 0.0
            await relay._on_deadline()

        run(scenario())

        assert relay._machine.phase is InterviewPhase.WRAP_UP
        assert upstream.of_type("session.update") == []
        assert "deliver the closing verdict" in upstream.creates[-1]["response"]["instructions"]

    def test_audio_for_the_scorecard_never_reaches_the_browser(self):
        """§5.1: modalities:["text"] is demanded and not trusted. The worst case
        is a report the student cannot hear, not a robot reading JSON aloud."""
        relay, upstream, browser = make_relay()

        async def scenario():
            relay._report_response_id = "resp_report"
            relay._active_response_id = "resp_report"
            await relay._handle_upstream_event(
                {
                    "type": "response.output_audio.delta",
                    "response_id": "resp_report",
                    "delta": "AAAA",
                }
            )

        run(scenario())
        assert browser.audio == []


# ---------------------------------------------------------------------------
# The recording
# ---------------------------------------------------------------------------


class _FakeRecorder:
    """app/interview/audio_store.py's recorder, reduced to feed()."""

    def __init__(self) -> None:
        self.fed: list[tuple[str, bytes]] = []

    def feed(self, track: str, pcm: bytes) -> None:
        self.fed.append((track, pcm))


class TestTheRecording:
    def test_the_base64_uplink_is_captured_like_the_binary_one(self):
        """A recording that is missing one side is worse than no recording.

        `?uplink=base64` forwards byte-identical audio upstream and used to skip
        _capture entirely, so the session produced an interviewer track, no
        student track, and `recorded=True` in the snapshot -- a DIRECTOR opening
        it hears the interviewer talking to silence and has no way to tell that
        from a student who never spoke. The shipped Angular client only sends
        Binary, but the relay accepts this mode and the prototype client uses
        it, so the fix is to capture it rather than to trust that nobody will.
        """
        relay, upstream, browser = make_relay()
        recorder = _FakeRecorder()
        relay._recorder = recorder
        pcm = bytes(range(0, 32))

        async def scenario():
            await relay._handle_client_control(
                upstream,
                json.dumps(
                    {
                        "type": "input_audio_buffer.append",
                        "audio": base64.b64encode(pcm).decode("ascii"),
                    }
                ),
            )

        run(scenario())

        assert recorder.fed == [(_AUDIO_TRACK_STUDENT, pcm)]
        # And the forward upstream is still the untouched passthrough.
        assert upstream.of_type("input_audio_buffer.append")[0]["audio"] == (
            base64.b64encode(pcm).decode("ascii")
        )

    def test_a_rejected_append_frame_is_not_captured(self):
        """The capture has to agree with what upstream heard, so a frame the
        relay drops must not reach the recorder either -- a plausible recording
        that disagrees with the model's input is worse than none."""
        relay, upstream, browser = make_relay()
        recorder = _FakeRecorder()
        relay._recorder = recorder

        async def scenario():
            for payload in ("not base64!!", "AAA"):
                await relay._handle_client_control(
                    upstream,
                    json.dumps({"type": "input_audio_buffer.append", "audio": payload}),
                )

        run(scenario())

        assert recorder.fed == []
        assert upstream.of_type("input_audio_buffer.append") == []
