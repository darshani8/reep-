"""Source-level guard on the voice worker's privacy boundary (AGENTS.md rule 1).

The guarantee that a student's marks, attendance and USN never reach Groq or
LiveKit is ARCHITECTURAL, not a matter of prompt wording: `voice_agent.py` holds
no database connection, imports nothing from `app/`, and builds its system prompt
from one constant that contains no student data. A remote model cannot leak what
was never put in front of it.

That property is invisible in any behavioural test — a worker that had quietly
grown a `SELECT` would pass every one of them while streaming a student's record
to a third party. So it is asserted against the SOURCE.

These tests read the file as TEXT rather than importing it. Importing pulls in
livekit-agents, onnxruntime and Silero, which live in a separate Python 3.12 venv
that the API suite does not have — and would also run `_load_env_file()`, leaking
real credentials into the pytest process.
"""

from pathlib import Path

import pytest

WORKER = Path(__file__).resolve().parent.parent / "voice_agent.py"


@pytest.fixture(scope="module")
def source() -> str:
    return WORKER.read_text(encoding="utf-8")


# Anything that would give the worker a route to student records. Each is a
# substring check against the whole file, which is blunt on purpose: this test
# should fire on a plausible-looking mistake, not just an exact one.
FORBIDDEN_DB_ACCESS = [
    "SessionLocal",
    "from app.",
    "import app",
    "sqlalchemy",
    "psycopg",
]


@pytest.mark.parametrize("needle", FORBIDDEN_DB_ACCESS)
def test_worker_has_no_database_access(source: str, needle: str) -> None:
    """The worker must stay DB-free.

    It reaches the server over HTTP and only ever posts transcripts and
    heartbeats. A direct session here would put every table — including
    `students` — one import away from a process that talks to a remote LLM.
    """
    # Skip the module docstring: it DESCRIBES this constraint, so the words
    # legitimately appear there.
    body = source.split('"""', 2)[-1]
    assert needle not in body, (
        f"voice_agent.py contains {needle!r} — the voice worker must not reach "
        "the database directly (AGENTS.md rule 1)."
    )


def test_worker_only_calls_the_two_worker_endpoints(source: str) -> None:
    """Only /api/voice/heartbeat and /api/voice/transcript.

    Calling something like /api/student/... would pull a student's own records
    into the worker process, one f-string away from the prompt. The worker
    authenticates with a shared secret, not a student session, so those endpoints
    are not meant to be reachable from here at all.
    """
    import re

    called = set(re.findall(r'"(/api/[^"]*)"', source))
    assert called == {"/api/voice/heartbeat", "/api/voice/transcript"}, (
        f"unexpected API paths in voice_agent.py: {called}"
    )


def test_system_prompt_is_the_constant_verbatim(source: str) -> None:
    """The prompt must be BASE_INSTRUCTIONS, unmodified.

    This is the actual enforcement point for rule 1. `BASE_INSTRUCTIONS` is a
    literal with no student data in it; the moment anything concatenates or
    formats into it — a name, a USN, "the student's CGPA is …" — that data
    travels to Groq on the next turn. Assigning the constant straight across is
    what makes "no student record reaches the model" checkable rather than
    aspirational.
    """
    assert "instructions=BASE_INSTRUCTIONS" in source.replace(" ", ""), (
        "the agent's instructions must be BASE_INSTRUCTIONS itself"
    )
    assert "BASE_INSTRUCTIONS +" not in source, (
        "nothing may be concatenated onto the system prompt — that is how "
        "student data would reach the model (AGENTS.md rule 1)"
    )
    assert "BASE_INSTRUCTIONS.format" not in source, (
        "the system prompt must not be formatted with runtime values "
        "(AGENTS.md rule 1)"
    )


def test_agent_name_matches_the_server(source: str) -> None:
    """The dispatch name must agree with the API, or no agent ever joins.

    A NAMED agent opts out of LiveKit's automatic dispatch, so the API attaches
    an explicit RoomAgentDispatch carrying VOICE_AGENT_NAME. Renaming either side
    alone produces the most confusing failure available: the token mints, the
    room opens, the student's microphone publishes, and nothing arrives — with
    both processes reporting themselves healthy.
    """
    from app.routers.voice import VOICE_AGENT_NAME

    assert f'agent_name="{VOICE_AGENT_NAME}"' in source, (
        f"voice_agent.py must register under {VOICE_AGENT_NAME!r} to match "
        "app/routers/voice.py"
    )
