"""The Specialization Matrix for the mock interviewer, and its state machine.

One interview no longer has one fixed persona. The student picks a
specialization on the assistant screen, the client sends it as
`?specialization=hr|dm|ba|fa` on the /api/interview handshake, and this module
answers the two questions the relay then has:

    1. WHO is interviewing?  -- the Specialization row: the AI persona, the
       core frameworks under assessment, and the opening question.
    2. WHERE in the interview are we?  -- InterviewStateMachine, advanced by
       the relay on each COMPLETED student answer, whose phase directive is
       what steers the model from the opening question through to the verdict.

RULE 1 (AGENTS.md) is untouched by all of this. A specialization key is chosen
by the student in the UI and carries nothing from their record; the composed
instructions are a fixed string per (specialization, phase) pair, exactly as
_INTERVIEWER_PERSONA was a fixed string before. No marks, USN, attendance or
resume text enters them, and the base persona's "you cannot see the dashboard"
disclosure is included verbatim in every composition.

The phase change reaches the model as a mid-session session.update carrying
the re-composed instructions. Instructions are replaceable mid-session; the
voice is not, which is why the relay's phase update sends ONLY instructions.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Final


# ---------------------------------------------------------------------------
# The matrix
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Specialization:
    """One row of the Specialization Matrix.

    `persona` is a noun phrase, not a sentence ("an empathetic yet compliant
    Chief Human Resources Officer (CHRO)"), so build_instructions can embed it
    without rewording. `sample_question` is the question the OPENING phase
    must ask; the model is told to rephrase it naturally, not recite it.
    """

    key: str
    label: str
    persona: str
    frameworks: tuple[str, ...]
    sample_question: str


# VERBATIM from the product spec -- persona wording, framework lists and
# sample questions are what every student is assessed against, same status as
# _INTERVIEWER_PERSONA in app/interview_relay.py.
SPECIALIZATIONS: Final[dict[str, Specialization]] = {
    spec.key: spec
    for spec in (
        Specialization(
            key="hr",
            label="Human Resources (HR)",
            persona=(
                "an empathetic yet compliant Chief Human Resources Officer (CHRO)"
            ),
            frameworks=(
                "the STAR method",
                "behavioral competencies",
                "labor laws",
                "conflict resolution",
                "talent acquisition",
            ),
            sample_question=(
                "Walk me through how you would handle a sexual harassment "
                "claim involving a top-performing executive."
            ),
        ),
        Specialization(
            key="dm",
            label="Digital Marketing (DM)",
            persona="a growth-oriented, data-driven Chief Marketing Officer (CMO)",
            frameworks=(
                "CAC/LTV ratios",
                "ROAS",
                "SEO/SEM strategies",
                "A/B testing",
                "funnel optimization",
                "brand positioning",
            ),
            sample_question=(
                "Our CAC has increased by 40% on Meta ads this quarter. What "
                "is your step-by-step diagnostic framework?"
            ),
        ),
        Specialization(
            key="ba",
            label="Business Analytics (BA)",
            persona="a highly technical, problem-solving Director of Analytics",
            frameworks=(
                "SQL/Python logic",
                "data modeling",
                "predictive analytics",
                "A/B test statistical significance",
                "data visualization",
            ),
            sample_question=(
                "How would you design a machine learning pipeline to predict "
                "customer churn using messy e-commerce logs?"
            ),
        ),
        Specialization(
            key="fa",
            label="Financial Analytics (FA)",
            persona="a sharp, risk-conscious Managing Director / CFO",
            frameworks=(
                "DCF modeling",
                "financial ratios",
                "risk mitigation",
                "valuation techniques",
                "M&A frameworks",
            ),
            sample_question=(
                "Walk me through how a $10 depreciation expense flows through "
                "the three financial statements."
            ),
        ),
    )
}


def get_specialization(key: str | None) -> Specialization | None:
    """The row for a client-supplied key, or None. Case-insensitive.

    None means two different things to the two callers, on purpose: the router
    treats None-for-a-given-key as a refusal (close 4010), while the relay
    treats a None KEY as the generic interview that predates the matrix.
    """
    if not key:
        return None
    return SPECIALIZATIONS.get(key.strip().lower())


# ---------------------------------------------------------------------------
# The state machine
# ---------------------------------------------------------------------------


class InterviewPhase(StrEnum):
    """The explicit lifecycle of one specialized interview.

    Driven by COMPLETED student answers (the relay sees one
    conversation.item.input_audio_transcription.completed per answer), never
    inferred from wall-clock time: a fast student and a deliberate one get the
    same arc.
    """

    OPENING = "opening"  # intro + the specialization's sample question
    PROBING = "probing"  # framework-by-framework follow-ups
    DEEP_DIVE = "deep_dive"  # one hard, ambiguous scenario, pressed on trade-offs
    WRAP_UP = "wrap_up"  # no new questions; spoken verdict and close
    ENDED = "ended"  # socket closed; terminal


# Answer counts at which the relay advances the phase. The interview cap is 15
# minutes; five substantive answers in that window is a full interview, so
# WRAP_UP after the fifth leaves the model room to deliver the verdict before
# the relay's own hard cap ends the session.
_PROBING_AFTER_ANSWERS: Final[int] = 1
_DEEP_DIVE_AFTER_ANSWERS: Final[int] = 3
_WRAP_UP_AFTER_ANSWERS: Final[int] = 5

# Every legal edge. The machine is small enough that an explicit map beats a
# convention: an illegal jump is a relay bug and must raise, not silently pass.
_TRANSITIONS: Final[dict[InterviewPhase, frozenset[InterviewPhase]]] = {
    InterviewPhase.OPENING: frozenset(
        {InterviewPhase.PROBING, InterviewPhase.WRAP_UP, InterviewPhase.ENDED}
    ),
    InterviewPhase.PROBING: frozenset(
        {InterviewPhase.DEEP_DIVE, InterviewPhase.WRAP_UP, InterviewPhase.ENDED}
    ),
    InterviewPhase.DEEP_DIVE: frozenset(
        {InterviewPhase.WRAP_UP, InterviewPhase.ENDED}
    ),
    InterviewPhase.WRAP_UP: frozenset({InterviewPhase.ENDED}),
    InterviewPhase.ENDED: frozenset(),
}


class InterviewStateMachine:
    """One interview's position in the arc. All state lives here per session.

    The relay owns the only instance and calls `student_answered()` from the
    user-transcript hook; a True return means the phase changed and the model
    needs the re-composed instructions. This class never does I/O, so it is
    unit-tested directly.
    """

    __slots__ = ("_specialization", "_phase", "_answers")

    def __init__(self, specialization: Specialization | None = None) -> None:
        self._specialization = specialization
        self._phase = InterviewPhase.OPENING
        self._answers = 0

    @property
    def specialization(self) -> Specialization | None:
        return self._specialization

    @property
    def phase(self) -> InterviewPhase:
        return self._phase

    @property
    def answers(self) -> int:
        return self._answers

    def student_answered(self) -> bool:
        """Record one completed student answer. True iff the phase changed.

        WRAP_UP is sticky: answers given during the verdict (the student
        thanking the interviewer, asking a closing question) must not re-arm
        question phases. ENDED absorbs everything.
        """
        if self._phase in (InterviewPhase.WRAP_UP, InterviewPhase.ENDED):
            return False
        self._answers += 1
        if self._answers >= _WRAP_UP_AFTER_ANSWERS:
            return self._transition_to(InterviewPhase.WRAP_UP)
        if self._answers >= _DEEP_DIVE_AFTER_ANSWERS:
            return self._transition_to(InterviewPhase.DEEP_DIVE)
        if self._answers >= _PROBING_AFTER_ANSWERS:
            return self._transition_to(InterviewPhase.PROBING)
        return False

    def end(self) -> None:
        """Terminal, from any phase -- the socket is closing."""
        self._transition_to(InterviewPhase.ENDED)

    def _transition_to(self, target: InterviewPhase) -> bool:
        if target is self._phase:
            return False
        if target not in _TRANSITIONS[self._phase]:
            # A jump the map does not allow is a bug in the caller, and raising
            # here is what keeps a miscounted threshold from producing a
            # directive the phase never warranted.
            raise ValueError(f"Illegal interview transition {self._phase} -> {target}")
        self._phase = target
        return True


# ---------------------------------------------------------------------------
# Instruction composition
# ---------------------------------------------------------------------------

# Per-phase steering, appended to the composed instructions and REPLACED on
# every phase change. These are directives to the model, not prose for the
# student, and they are deliberately imperative and short: everything else the
# interviewer needs is already in the base persona and the specialization row.
def _phase_directive(spec: Specialization, phase: InterviewPhase) -> str:
    frameworks = ", ".join(spec.frameworks)
    if phase is InterviewPhase.OPENING:
        return (
            f"Introduce yourself in one sentence as {spec.persona}, then open "
            "the interview with this question, rephrased naturally rather than "
            f'recited: "{spec.sample_question}"'
        )
    if phase is InterviewPhase.PROBING:
        return (
            "Probe the core frameworks one at a time: "
            f"{frameworks}. When an answer stays at the surface, ask a "
            'follow-up "why" or "how exactly" before moving on.'
        )
    if phase is InterviewPhase.DEEP_DIVE:
        return (
            "Raise the difficulty. Present ONE realistic, ambiguous scenario "
            f"from {spec.label} and press on trade-offs, risks and edge cases "
            "rather than accepting a textbook answer."
        )
    if phase is InterviewPhase.WRAP_UP:
        return (
            "Ask no further questions. Deliver a concise spoken verdict on the "
            "whole interview: two genuine strengths, one priority improvement "
            "tied to the frameworks above, and one concrete drill to practise. "
            "Then thank the student and close the interview."
        )
    # ENDED produces no directive: nothing is sent upstream once the socket is
    # closing, and a caller composing instructions for ENDED has a bug.
    raise ValueError("ENDED has no phase directive")


def build_instructions(
    spec: Specialization,
    base_persona: str,
    phase: InterviewPhase = InterviewPhase.OPENING,
) -> str:
    """The full instructions for one (specialization, phase) pair.

    `base_persona` comes first and VERBATIM -- it carries the conduct rules
    (one question at a time, micro-feedback, no interruptions) and the rule-1
    disclosure, and neither the specialization block nor the phase directive
    may dilute them. The relay calls this once at session.update time and again
    on every phase change, so it must be a pure function of its arguments.
    """
    frameworks = ", ".join(spec.frameworks)
    return (
        f"{base_persona}\n"
        "\n"
        f"## Specialization: {spec.label}\n"
        f"For this session you are {spec.persona}, interviewing this student "
        f"for a {spec.label} role. Assess their command of these core "
        f"frameworks and concepts over the course of the interview: "
        f"{frameworks}.\n"
        "\n"
        f"## Current phase: {phase.value}\n"
        f"{_phase_directive(spec, phase)}"
    )
