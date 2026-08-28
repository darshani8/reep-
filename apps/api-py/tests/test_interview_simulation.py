"""Full-interview simulations: every specialization, end to end, no sockets.

test_interview_relay.py drives the turn protocol one failure at a time; this
module walks a COMPLETE interview the way a student actually experiences it --
handshake, opening, five real answers (one of them split by VAD at a thinking
pause, one of them too short and clarified exactly once), the candidate-
questions beat, the spoken verdict, the text-only scorecard, close 1000 -- and
asserts on everything that went on the wire in between.

That is the "does it FEEL like a real interview" regression net: the matrix
tests pin the words, the relay tests pin the failure modes, and these pin that
the two compose into the right CONVERSATION, per specialization, in order.

The harness is test_interview_relay.py's own: a fake upstream that records
what was sent, a fake browser that records what was forwarded, no database.
"""

import json

import pytest

from app.interview.specializations import SPECIALIZATIONS, InterviewPhase
from app.interview.realtime_relay import _CLOSE_OK, _SessionEnded

# The harness is deliberately imported, not copied: one fake upstream, one
# fake browser, one set of event-sequence helpers, so a change to the harness
# changes every driver of it at once.
from test_interview_relay import (  # noqa: E402
    _GOOD_ANSWER,
    _REPORT_JSON,
    _FakeBrowser,
    _Relay,
    _ScriptedUpstream,
    ask_question,
    make_relay,
    report_done_event,
    run,
    student_says,
)


# ---------------------------------------------------------------------------
# Driving a whole interview
# ---------------------------------------------------------------------------


def _handshake_events() -> list[dict]:
    """What api.openai.com answers a well-formed startup with (GA shape)."""
    return [
        {"type": "session.created", "session": {"id": "sess_sim", "model": "gpt-realtime"}},
        {
            "type": "session.updated",
            "session": {
                "id": "sess_sim",
                "audio": {
                    "input": {
                        "turn_detection": {"type": "server_vad", "create_response": False}
                    }
                },
            },
        },
    ]


def _all_instruction_strings(upstream) -> list[str]:
    """Every instruction string this session put on the wire, both carriers."""
    out: list[str] = []
    for event in upstream.sent:
        if event.get("type") == "session.update":
            instructions = (event.get("session") or {}).get("instructions")
            if instructions:
                out.append(instructions)
        elif event.get("type") == "response.create":
            instructions = (event.get("response") or {}).get("instructions")
            if instructions:
                out.append(instructions)
    return out


async def _split_answer(relay: _Relay, first: str, second: str, base: str) -> None:
    """One answer that server VAD split at a thinking pause into TWO segments.

    The transcripts even arrive out of order, which is the realistic case:
    the drain must merge them into ONE verdict and ONE question.
    """
    await relay._handle_upstream_event({"type": "input_audio_buffer.speech_stopped"})
    await relay._handle_upstream_event(
        {"type": "input_audio_buffer.committed", "item_id": f"{base}a"}
    )
    await relay._handle_upstream_event({"type": "input_audio_buffer.speech_stopped"})
    await relay._handle_upstream_event(
        {"type": "input_audio_buffer.committed", "item_id": f"{base}b"}
    )
    await relay._handle_upstream_event(
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": f"{base}b",
            "transcript": second,
        }
    )
    await relay._handle_upstream_event(
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": f"{base}a",
            "transcript": first,
        }
    )


# ---------------------------------------------------------------------------
# The simulations
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("spec_key", ["hr", "dm", "ba", "fa"])
def test_a_complete_specialized_interview(spec_key):
    spec = SPECIALIZATIONS[spec_key]
    browser = _FakeBrowser()
    relay = _Relay(browser, "c0ffee123456", on_turn=None, specialization=spec)
    upstream = _ScriptedUpstream(_handshake_events())
    relay._upstream = upstream

    async def scenario():
        # -- the handshake: session.update, then the opening create ----------
        await relay._handshake(upstream)

        # -- answer 1: the self-intro, split by VAD at a thinking pause -------
        await ask_question(relay, "resp_open")
        await _split_answer(
            relay,
            "I am a final-year student and",
            "I have always enjoyed working with people",
            "item_1",
        )

        # -- answer 2: too short ONCE, clarified ONCE, then a real one --------
        await ask_question(relay, "resp_q1")
        await student_says(relay, "item_2", "I think so")
        await ask_question(relay, "resp_clarify")
        await student_says(relay, "item_3", _GOOD_ANSWER)

        # -- answers 3, 4, 5: the rest of the arc ------------------------------
        await ask_question(relay, "resp_q2")
        await student_says(relay, "item_4", _GOOD_ANSWER)
        await ask_question(relay, "resp_q3")
        await student_says(relay, "item_5", _GOOD_ANSWER)
        await ask_question(relay, "resp_q4")
        await student_says(relay, "item_6", _GOOD_ANSWER)

        # -- the candidate-questions beat, then the verdict --------------------
        await ask_question(relay, "resp_invite")
        await student_says(
            relay, "item_7", "Yes, what does the first year in this role look like?"
        )
        await ask_question(relay, "resp_verdict")

        # -- the scorecard, then close ----------------------------------------
        relay._expecting_report = True
        await relay._handle_upstream_event(
            {"type": "response.created", "response": {"id": "resp_report"}}
        )
        with pytest.raises(_SessionEnded) as caught:
            await relay._handle_upstream_event(report_done_event(_REPORT_JSON))
        return caught.value

    ended = run(scenario())

    # THE ENDING: well-formed report, clean close.
    assert ended.code == _CLOSE_OK == 1000
    reports = [c for c in browser.control if c["type"] == "reep.report"]
    assert len(reports) == 1
    assert reports[0]["available"] is True
    assert reports[0]["report"]["overall"] == 71

    # THE OPENING: the session.update carries this track's voice, and the
    # opening instructions are a REAL opening -- greet, introduce, set
    # expectations, ask the student to introduce themselves. The opening
    # response.create itself carries NO instructions: supplying them would
    # replace the session persona on the turn that sets the tone.
    session_updates = upstream.of_type("session.update")
    opening_update = session_updates[0]["session"]
    assert opening_update["audio"]["output"]["voice"] == spec.voice
    opening_instructions = opening_update["instructions"]
    assert spec.persona in opening_instructions
    assert "introduce themselves" in opening_instructions
    assert spec.sample_question not in opening_instructions
    opening_create = upstream.creates[0]
    assert "instructions" not in opening_create["response"]

    # THE ARC, in order, and every phase directive pushed BEFORE its create:
    # a session.update sent after the create steers the question AFTER next.
    assert relay._machine.answers == 5
    types = [event["type"] for event in upstream.sent]
    phase_pushes = [i for i, t in enumerate(types) if t == "session.update"][1:]
    assert len(phase_pushes) == 3  # probing, deep_dive, wrap_up
    for push_index in phase_pushes:
        following = types.index("response.create", push_index)
        assert following > push_index

    # ONE create per student turn, and upstream never created one itself.
    # Opening (handshake) + merged a1 + clarify + a2 + a3 + a4 + invite +
    # verdict + report = 9; anything more is the two-questions-per-answer bug.
    assert len(upstream.creates) == 9
    assert relay._server_created_response is False

    # The split answer merged: ONE question for it, two turn records.
    assert [turn[2] for turn in relay.emitted if turn[0] == "user"][:2] == [
        "u:item_1a",
        "u:item_1b",
    ]

    # The too-short answer earned EXACTLY ONE clarify, then the arc moved on.
    clarifies = [
        c
        for c in upstream.creates
        if "too brief" in (c["response"].get("instructions") or "")
    ]
    assert len(clarifies) == 1

    # The beat: the invite carried the invite override and NO report yet; the
    # verdict carried NO override (the session already holds WRAP_UP); the
    # report is the only text-only create and it fired exactly once, after the
    # verdict.
    invite = upstream.creates[-3]
    assert "any questions for you" in invite["response"]["instructions"]
    verdict = upstream.creates[-2]
    assert "instructions" not in verdict["response"]
    report_create = upstream.creates[-1]
    body = report_create["response"]
    assert body.get("modalities") == ["text"] or body.get("output_modalities") == ["text"]
    assert body["max_output_tokens"] == 800
    assert "single JSON object" in body["instructions"]

    # RULE 1's SHAPE, checked against the whole session: no instruction string
    # anywhere contains anything the student said.
    student_words = [_GOOD_ANSWER, "I am a final-year student", "I think so",
                     "the first year in this role"]
    for instructions in _all_instruction_strings(upstream):
        for words in student_words:
            assert words not in instructions


def test_the_generic_interview_never_reaches_wrap_up_on_its_own():
    """No ?specialization= -- the arc does not exist, and the ONLY route to a
    verdict and a scorecard is the session cap forcing one. This pins the
    current behaviour end to end rather than per branch."""
    browser = _FakeBrowser()
    relay = _Relay(browser, "c0ffee123456", on_turn=None, specialization=None)
    upstream = _ScriptedUpstream(_handshake_events())
    relay._upstream = upstream

    async def scenario():
        await relay._handshake(upstream)
        # Eight accepted answers -- well past five. The machine never ticks.
        for index in range(8):
            await ask_question(relay, f"resp_{index}")
            await student_says(relay, f"item_{index}", _GOOD_ANSWER)
        assert relay._machine.phase is InterviewPhase.OPENING
        assert relay._report_requested is False

        # The cap is the only closer this track has. The ninth question is
        # still in flight when it lands, so the verdict is deferred (DF4) and
        # fires when that question finishes -- exactly the shape
        # test_a_forced_wrap_up_during_a_live_response_still_speaks_the_verdict
        # pins for the specialized tracks.
        relay._wrap_up_deadline = 0.0
        await relay._on_deadline()
        assert relay._machine.phase is InterviewPhase.WRAP_UP
        assert relay._verdict_requested is True
        assert relay._deferred is not None and relay._deferred.kind == "verdict"

        await ask_question(relay, "resp_8")
        assert "deliver the closing verdict" in upstream.creates[-1]["response"]["instructions"]
        await ask_question(relay, "resp_verdict")
        assert relay._report_requested is True

        relay._expecting_report = True
        await relay._handle_upstream_event(
            {"type": "response.created", "response": {"id": "resp_report"}}
        )
        with pytest.raises(_SessionEnded) as caught:
            await relay._handle_upstream_event(report_done_event(_REPORT_JSON))
        return caught.value

    ended = run(scenario())

    assert ended.code == _CLOSE_OK == 1000
    # No phase pushes and no specialization ever named: exactly ONE
    # session.update (the handshake's) went upstream all interview long.
    assert len(upstream.of_type("session.update")) == 1
    assert all(
        c.get("phase") in (None, "opening") or c["type"] != "reep.phase"
        for c in browser.control
    )
    # The verdict at the cap is the forced kind -- the candidate-questions
    # beat belongs to the arc path, which this track never walks.
    assert relay._awaiting_candidate_questions is False
    assert "deliver the closing verdict" in upstream.creates[-2]["response"]["instructions"]
    # Rule 1's shape, on the generic track too.
    for instructions in _all_instruction_strings(upstream):
        assert _GOOD_ANSWER not in instructions
