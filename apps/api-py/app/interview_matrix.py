"""The Specialization Matrix for the mock interviewer, and its state machine.

One interview no longer has one fixed persona. The student picks a
specialization on the assistant screen, the client sends it as
`?specialization=hr|dm|ba|fa` on the /api/interview handshake, and this module
answers the two questions the relay then has:

    1. WHO is interviewing?  -- the Specialization row: the AI persona, the
       core frameworks under assessment, the voice the role speaks with, and
       the sample question worked in during probing.
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

Two more things live here under Interview Engine v3, and both are here rather
than in the relay ON PURPOSE:

    3. IS THAT AN ANSWER?  -- classify_answer, a word count and a filler list.
       Deterministic and local because it runs between the student finishing
       and the interviewer replying: a model call here would be latency on
       every single turn.
    4. WHAT DO WE SAY WHEN IT IS NOT?  -- build_turn_instructions composes the
       per-response override for a clarification. Instruction composition stays
       in ONE module so the base persona keeps arriving first and verbatim, and
       so that "everything this app authors upstream is a fixed string" is a
       property you can check by reading one file. Nothing here ever composes
       the student's own words into an instruction, and that shape is the
       guardrail: the moment student text goes into `instructions`, the next
       editor puts a resume in there.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Final

# The answer floor is operator-tunable, so it is read from config rather than
# frozen here. This is still an I/O-free module: settings is a value object
# read at call time, not a database.
from .config import settings


# ---------------------------------------------------------------------------
# The matrix
# ---------------------------------------------------------------------------


# The voices the relay may put on the wire. GA-only names (marin, cedar) are
# included because the GA session shape is the default; the beta surface
# ignores an unknown name by falling back to its default, which is why the
# relay validates the operator-supplied OPENAI_REALTIME_VOICE against this set
# and says so in the log rather than discovering the fallback mid-interview.
KNOWN_REALTIME_VOICES: Final[frozenset[str]] = frozenset(
    {"alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse",
     "marin", "cedar"}
)


@dataclass(frozen=True, slots=True)
class Specialization:
    """One row of the Specialization Matrix.

    `persona` is a noun phrase, not a sentence ("an empathetic yet compliant
    Chief Human Resources Officer (CHRO)"), so build_instructions can embed it
    without rewording. `sample_question` is the question the PROBING phase
    must work in early; the model is told to rephrase it naturally, not recite
    it. `voice` is the OpenAI Realtime voice the role speaks with -- a CHRO
    should not sound like a CFO -- frozen onto the session in the single
    startup session.update, because upstream cannot change it after the first
    audio.
    """

    key: str
    label: str
    persona: str
    frameworks: tuple[str, ...]
    sample_question: str
    voice: str
    # The course the student was actually taught, module by module, when the
    # programme has one. `frameworks` is what a PRACTITIONER is assessed on and
    # is pitched at the industry bar; `syllabus` is what this cohort has sat in
    # a classroom for, and the two are not the same interview. Optional, and
    # empty for any track with no mapped course - build_instructions omits the
    # block entirely rather than composing an empty heading.
    syllabus: tuple[str, ...] = ()


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
            voice="coral",
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
            # 22MDM23 Fundamentals of Digital Marketing, the course this cohort
            # sits. Compressed to what can be ASKED rather than recited: the
            # interviewer needs the shape of the syllabus and its vocabulary,
            # not the answer key. The source bank has 100 questions WITH model
            # answers; sending those upstream would let the model mark a student
            # against a memorised script, and would put ~15 kB into a string
            # that is re-sent on every phase change.
            syllabus=(
                "Module 1 - Foundations: digital versus traditional marketing, "
                "its advantages and limitations, the P-O-E-M framework (paid, "
                "owned and earned media), segmentation, target marketing, "
                "message customization, personalization, and the structure of a "
                "digital marketing plan.",
                "Module 2 - Display advertising: banner, video, rich-media and "
                "responsive formats; buying models; contextual, placement, "
                "interest, geographic, language, demographic and mobile "
                "targeting; remarketing; programmatic; YouTube advertising.",
                "Module 3 - Search advertising: ad placement and Ad Rank, "
                "keywords and keyword research, campaign construction, landing "
                "pages and landing-page relevance, performance reporting.",
                "Module 4 - Social and mobile: organic versus paid social, "
                "platform selection by audience and objective, engagement, "
                "influencer marketing, user-generated content, the mobile "
                "marketing toolkit, location-based services, QR codes, "
                "augmented reality, gamification, mobile analytics.",
                "Module 5 - SEO: crawling, indexing and ranking; on-page versus "
                "off-page SEO; long-tail keywords; backlinks; SEO maintenance; "
                "organic traffic; web analytics metrics.",
                "Metric arithmetic the student is expected to do out loud: "
                "CTR = clicks / impressions x 100; CPC = cost / clicks; "
                "CPM = cost / impressions x 1000; cost per conversion = cost / "
                "conversions; conversion rate = conversions / interactions x "
                "100; ROAS = attributed revenue / cost.",
            ),
            voice="marin",
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
            voice="cedar",
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
            voice="ash",
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

    OPENING = "opening"  # greet, set expectations, ask the student to self-introduce
    PROBING = "probing"  # framework-by-framework follow-ups incl. the sample question
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

    def force_wrap_up(self) -> bool:
        """Jump straight to WRAP_UP because the clock, not the arc, ran out.

        True iff the phase changed. The relay calls this when the session cap
        is close enough that a verdict started later would be cut off
        mid-sentence -- the failure this engine exists to remove is a
        fifteen-minute interview that ends with no verdict at all, and an early
        verdict beats no verdict. Deliberately NOT student_answered(), so a
        clock decision can never inflate the answer count: a mentor reading
        that number must be reading answers, not deadlines.
        """
        if self._phase in (InterviewPhase.WRAP_UP, InterviewPhase.ENDED):
            return False
        return self._transition_to(InterviewPhase.WRAP_UP)

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
            f"Open the interview the way a real one begins: greet the student "
            f"briefly, introduce yourself in one sentence as {spec.persona}, "
            "set expectations in one short sentence (a focused conversation of "
            "about 15 minutes with a few questions and honest feedback at the "
            "end), then ask the student to introduce themselves and say what "
            f"drew them to {spec.label}. Ask nothing else yet -- no domain "
            "questions in this phase."
        )
    if phase is InterviewPhase.PROBING:
        if spec.syllabus:
            return (
                "Probe one topic at a time, moving across the syllabus modules "
                "rather than staying inside one. Mix definition questions with "
                "at least one where the student must compute a metric out loud "
                "from figures you give them. Assess against these frameworks: "
                f"{frameworks}. When an answer stays at the surface, ask a "
                'follow-up "why" or "how exactly" before moving on. Early in '
                "this phase, work in this question, rephrased naturally rather "
                f'than recited: "{spec.sample_question}".'
            )
        return (
            "Probe the core frameworks one at a time: "
            f"{frameworks}. When an answer stays at the surface, ask a "
            'follow-up "why" or "how exactly" before moving on. Early in this '
            "phase, work in this question, rephrased naturally rather than "
            f'recited: "{spec.sample_question}".'
        )
    if phase is InterviewPhase.DEEP_DIVE:
        if spec.syllabus:
            return (
                "Raise the difficulty. Present ONE realistic, ambiguous "
                f"{spec.label} scenario spanning at least two syllabus modules "
                "and having no textbook answer - a campaign whose numbers are "
                "healthy at one funnel stage and poor at the next is the shape "
                "to aim for. Press on trade-offs, risks and what they would "
                "measure, not on definitions they have already given you."
            )
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


# ---------------------------------------------------------------------------
# Answer validation
# ---------------------------------------------------------------------------

# Deliberately SHORT. Its job is to catch a cough and an acknowledgement, not to
# judge content: an interviewer that decided "not a real answer" from a word
# list would be marking students on vocabulary. Everything past that is the
# word-count floor, which a human can reason about and an operator can tune.
_FILLER_WORDS: Final[frozenset[str]] = frozenset(
    {
        "um", "uh", "erm", "hmm", "mm", "mhm", "yeah", "yes", "no", "ok",
        "okay", "sure", "right", "thanks", "thank", "you", "sorry", "what",
        "huh", "pardon",
    }
)

# Apostrophes are kept so "don't" is ONE word, not two: the floor measures how
# much the student said, and splitting contractions inflates it.
_WORD_RE: Final[re.Pattern[str]] = re.compile(r"[a-z0-9']+")


def classify_answer(transcript: str) -> str:
    """'accepted' | 'empty' | 'filler' | 'too_short'. No I/O, no model call.

    This runs between the student finishing and the interviewer replying, which
    is why it is a word count and not a judgement: a round trip here would be
    latency on every single turn of every interview.

    The four verdicts are kept distinct rather than collapsed to a bool because
    they are stored on the turn record and read by a human afterwards -- "the
    transcriber returned nothing" and "the student said 'yeah'" are different
    facts about an interview, and a single False loses that.
    """
    words = _WORD_RE.findall(transcript.casefold())
    if not words:
        return "empty"
    floor = settings.interview_min_answer_words
    if floor <= 0:
        # 0 is a MEANING, not a typo (see config.py): the gate is off and every
        # transcript counts, which is exactly the pre-v3 behaviour.
        return "accepted"
    if all(word in _FILLER_WORDS for word in words):
        return "filler"
    if len(words) < floor:
        return "too_short"
    return "accepted"


# ---------------------------------------------------------------------------
# Instruction composition
# ---------------------------------------------------------------------------

# The per-response overrides for the turns that are NOT "ask the next question".
# Every one of them is a fixed string that says what the interviewer should do
# and never what the student said: the audio is already in the session and the
# model has it, so quoting it back would buy nothing and cost the property this
# module's header states.
_TURN_DIRECTIVES: Final[dict[str, str]] = {
    "clarify": (
        "The student's last answer was too brief to assess. Stay on the SAME "
        "question: ask one short, specific follow-up that tells them what kind "
        "of detail you are looking for. Do not move on to a new question, and "
        "do not repeat the question word for word."
    ),
    "unheard": (
        "You did not hear the student's last answer. Say so briefly and "
        "without blaming them, ask them to say it again, and stay on the same "
        "question."
    ),
    "resume": (
        "The student spoke before you had finished asking. Do not treat what "
        "they said as their answer: finish the question you were asking, or "
        "put it more briefly, and then wait for them."
    ),
    "verdict": (
        "Stop the interview here, regardless of how many questions have been "
        "asked, and deliver the closing verdict now: two genuine strengths, "
        "one priority improvement, and one concrete drill to practise. Then "
        "thank the student and close. Ask no further questions."
    ),
    "invite_questions": (
        "The questioning part of the interview is done. Before you give your "
        "verdict, hand the floor to the student the way a real interview ends: "
        "ask whether they have any questions for you about the role or the "
        "company. If they do, answer briefly and honestly in character, then "
        "wait. Do not deliver the verdict yet."
    ),
}

# The scorecard directive, issued once as a text-only response after the spoken
# verdict, in the SAME session -- which already holds the whole interview, so
# nothing about the student has to be sent to fetch it. It names no student and
# quotes no transcript, for the reason the block above gives.
#
# No response_format / json_schema: that parameter is unverified on both API
# generations and a rejected parameter costs the entire report. The JSON is
# DEMANDED here and PARSED DEFENSIVELY at the other end -- degrade, never
# assert.
REPORT_DIRECTIVE: Final[str] = (
    "The interview is over. Assess the student on this interview only -- what "
    "they actually said in this session, not what you assume about them.\n"
    "Reply with a single JSON object and nothing else: no prose, no code "
    "fence, no explanation before or after it. Use exactly these keys:\n"
    '{"overall": <integer 0-100>, "communication": <integer 0-100>, '
    '"domain": <integer 0-100>, "structure": <integer 0-100>, '
    '"strengths": [<2-3 short strings>], "improvements": [<1-2 short strings>], '
    '"drill": "<one concrete task they can practise this week>", '
    '"summary": "<one short paragraph addressed to the student>"}\n'
    "Score against the bar for a graduate hire. If the student barely spoke, "
    "say that in the summary and score it honestly rather than inventing "
    "detail they did not give you."
)


# How the interviewer SOUNDS, composed into every (specialization, phase)
# instruction right after the base persona and before the specialization
# block. The persona says what the interviewer DOES (one question at a time,
# micro-feedback); this says how it comes across out loud -- a realtime voice
# model reciting written-English scaffolding ("Firstly... Secondly...",
# bullet points) is the single biggest tell that the interview is a chatbot.
_DELIVERY_STYLE: Final[str] = (
    "You are speaking aloud, not writing, so sound like a real interviewer "
    "across the table. Begin each turn with one short, genuine acknowledgement "
    "of what the student just said -- vary the phrase, never the same one "
    "twice in a row -- then at most one or two sentences of feedback or "
    "follow-up, then your single question. Plain spoken sentences only: no "
    "numbered lists, no bullet points, no headings, no 'Firstly, Secondly' "
    "recitations. Warm but professional; this is a practice interview, not an "
    "interrogation."
)


def build_turn_instructions(
    spec: Specialization | None,
    base_persona: str,
    phase: InterviewPhase,
    kind: str,
) -> str:
    """The per-response instruction override for one non-standard turn.

    `kind` is one of _TURN_DIRECTIVES. The result REPLACES the session persona
    for the single response it is attached to -- that is how a per-response
    `instructions` behaves upstream -- so it must be self-contained: the base
    persona verbatim, the specialization block and phase directive if there is
    one, and only then the turn directive. Composing the turn directive alone
    would drop the conduct rules and the rule-1 disclosure on exactly the turn
    where the interviewer is improvising.

    `spec` is None for the generic interview that predates the matrix: there is
    no specialization block to compose and the phase never advances, so the
    persona and the turn directive are the whole of it.
    """
    directive = _TURN_DIRECTIVES.get(kind)
    if directive is None:
        # A typo in a kind string would otherwise ship an interviewer with no
        # turn directive at all, which reads as the model ignoring the relay.
        raise ValueError(f"Unknown turn kind {kind!r}")
    head = base_persona if spec is None else build_instructions(spec, base_persona, phase)
    return f"{head}\n\n## This turn\n{directive}"


def build_instructions(
    spec: Specialization,
    base_persona: str,
    phase: InterviewPhase = InterviewPhase.OPENING,
) -> str:
    """The full instructions for one (specialization, phase) pair.

    `base_persona` comes first and VERBATIM -- it carries the conduct rules
    (one question at a time, micro-feedback, no interruptions) and the rule-1
    disclosure, and neither the specialization block nor the phase directive
    may dilute them. The delivery-style block follows it: how the interviewer
    SOUNDS, which is the same for every specialization and every phase. The
    relay calls this once at session.update time and again on every phase
    change, so it must be a pure function of its arguments.
    """
    frameworks = ", ".join(spec.frameworks)
    syllabus_block = ""
    if spec.syllabus:
        modules = "\n".join(f"- {line}" for line in spec.syllabus)
        syllabus_block = (
            "\n## The course this student has actually studied\n"
            "Draw your questions from this syllabus and use its vocabulary. "
            "Where the syllabus and the frameworks above disagree on level, the "
            "syllabus decides the QUESTION and the frameworks set the bar for "
            "the ANSWER: ask what they were taught, then press for the "
            "commercial judgement the framework list implies.\n"
            f"{modules}\n"
        )
    return (
        f"{base_persona}\n"
        "\n"
        f"{_DELIVERY_STYLE}\n"
        "\n"
        f"## Specialization: {spec.label}\n"
        f"For this session you are {spec.persona}, interviewing this student "
        f"for a {spec.label} role. Assess their command of these core "
        f"frameworks and concepts over the course of the interview: "
        f"{frameworks}.\n"
        f"{syllabus_block}"
        "\n"
        f"## Current phase: {phase.value}\n"
        f"{_phase_directive(spec, phase)}"
    )
