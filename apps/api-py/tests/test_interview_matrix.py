"""The Specialization Matrix and its interview state machine.

Two contracts are pinned here:

1. The matrix itself -- the four rows (HR, DM, BA, FA) with their personas,
   frameworks and sample questions are the product spec verbatim, so a test
   fails the moment a row goes missing or a field is left empty.

2. The state machine -- the phase arc (opening -> probing -> deep_dive ->
   wrap_up -> ended) is what steers the model mid-interview, and an illegal
   jump or a sticky-phase bug changes what every student is assessed against.

No database, no sockets: InterviewStateMachine does no I/O by design.
"""

import pytest

from app.interview_matrix import (
    SPECIALIZATIONS,
    InterviewPhase,
    InterviewStateMachine,
    build_instructions,
    get_specialization,
)
from app.interview_relay import _INTERVIEWER_PERSONA


class TestMatrix:
    def test_exactly_the_four_specializations(self):
        assert set(SPECIALIZATIONS) == {"hr", "dm", "ba", "fa"}

    @pytest.mark.parametrize("key", ["hr", "dm", "ba", "fa"])
    def test_every_row_is_complete(self, key):
        spec = SPECIALIZATIONS[key]
        assert spec.label
        assert spec.persona
        assert len(spec.frameworks) >= 4
        assert all(framework for framework in spec.frameworks)
        # Phrased as a prompt, not necessarily with a "?": two of the four are
        # "Walk me through..." statements in the spec.
        assert len(spec.sample_question) > 30

    def test_the_spec_sample_questions(self):
        # The spec's own wording, pinned so a casual edit is a deliberate act.
        assert "sexual harassment claim" in SPECIALIZATIONS["hr"].sample_question
        assert "CAC has increased by 40%" in SPECIALIZATIONS["dm"].sample_question
        assert "customer churn" in SPECIALIZATIONS["ba"].sample_question
        assert "$10 depreciation" in SPECIALIZATIONS["fa"].sample_question

    def test_lookup_is_case_insensitive_and_tolerant(self):
        assert get_specialization("HR") is SPECIALIZATIONS["hr"]
        assert get_specialization(" fa ") is SPECIALIZATIONS["fa"]

    def test_lookup_misses(self):
        assert get_specialization(None) is None
        assert get_specialization("") is None
        assert get_specialization("marketing") is None


class TestStateMachine:
    def test_starts_at_opening(self):
        machine = InterviewStateMachine(SPECIALIZATIONS["hr"])
        assert machine.phase is InterviewPhase.OPENING
        assert machine.answers == 0

    def test_full_arc_on_completed_answers(self):
        machine = InterviewStateMachine(SPECIALIZATIONS["dm"])
        # answer 1 -> probing
        assert machine.student_answered() is True
        assert machine.phase is InterviewPhase.PROBING
        # answer 2 stays probing
        assert machine.student_answered() is False
        assert machine.phase is InterviewPhase.PROBING
        # answer 3 -> deep dive
        assert machine.student_answered() is True
        assert machine.phase is InterviewPhase.DEEP_DIVE
        # answer 4 stays
        assert machine.student_answered() is False
        # answer 5 -> wrap up
        assert machine.student_answered() is True
        assert machine.phase is InterviewPhase.WRAP_UP

    def test_wrap_up_is_sticky(self):
        machine = InterviewStateMachine(SPECIALIZATIONS["ba"])
        for _ in range(5):
            machine.student_answered()
        assert machine.phase is InterviewPhase.WRAP_UP
        # Answers during the verdict must not re-arm question phases.
        assert machine.student_answered() is False
        assert machine.phase is InterviewPhase.WRAP_UP

    def test_end_is_terminal_from_any_phase(self):
        machine = InterviewStateMachine(SPECIALIZATIONS["fa"])
        machine.end()
        assert machine.phase is InterviewPhase.ENDED
        assert machine.student_answered() is False

    def test_illegal_transition_raises(self):
        machine = InterviewStateMachine(SPECIALIZATIONS["hr"])
        with pytest.raises(ValueError, match="Illegal interview transition"):
            machine._transition_to(InterviewPhase.DEEP_DIVE)

    def test_generic_interview_still_runs(self):
        # No specialization: the machine exists but the relay never advances it.
        machine = InterviewStateMachine(None)
        assert machine.specialization is None
        assert machine.phase is InterviewPhase.OPENING


class TestInstructionComposition:
    def test_base_persona_leads_and_is_verbatim(self):
        instructions = build_instructions(SPECIALIZATIONS["hr"], _INTERVIEWER_PERSONA)
        assert instructions.startswith(_INTERVIEWER_PERSONA)

    def test_opening_carries_persona_frameworks_and_sample_question(self):
        spec = SPECIALIZATIONS["fa"]
        instructions = build_instructions(spec, _INTERVIEWER_PERSONA)
        assert spec.persona in instructions
        assert spec.label in instructions
        for framework in spec.frameworks:
            assert framework in instructions
        assert spec.sample_question in instructions
        assert "## Current phase: opening" in instructions

    def test_wrap_up_forbids_new_questions(self):
        instructions = build_instructions(
            SPECIALIZATIONS["ba"], _INTERVIEWER_PERSONA, InterviewPhase.WRAP_UP
        )
        assert "## Current phase: wrap_up" in instructions
        assert "Ask no further questions" in instructions

    def test_ended_has_no_directive(self):
        with pytest.raises(ValueError):
            build_instructions(
                SPECIALIZATIONS["hr"], _INTERVIEWER_PERSONA, InterviewPhase.ENDED
            )

    def test_rule_1_disclosure_survives_every_phase(self):
        # The "you cannot see the dashboard" disclosure is part of the base
        # persona; a composition that dropped it would let the model invent a
        # CGPA out loud.
        for phase in (
            InterviewPhase.OPENING,
            InterviewPhase.PROBING,
            InterviewPhase.DEEP_DIVE,
            InterviewPhase.WRAP_UP,
        ):
            instructions = build_instructions(
                SPECIALIZATIONS["dm"], _INTERVIEWER_PERSONA, phase
            )
            assert "cannot see" in instructions
