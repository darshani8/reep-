"""Unit tests for the voice worker's two parsing adapters.

`_extract_turn` and `_resolve_conversation_id` sit between the LiveKit SDK and
the database: everything that ever gets written as a student's spoken turn passes
through them. They are pure functions over duck-typed objects, so they are worth
testing directly — and both encode a decision that a later reader would plausibly
"simplify" back into the bug it was fixing.

IMPORT STRATEGY. `voice_agent.py` lives in a separate Python 3.12 venv
(livekit-agents, onnxruntime, Silero) that this suite does not have, so the heavy
imports are stubbed with MagicMock. Importing also runs `_load_env_file()`, which
`setdefault`s the real apps/api-py/.env into os.environ — that would leak
credentials into the whole pytest session and change what other tests observe, so
the environment is snapshotted and restored around the import.
"""

import importlib.util
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

WORKER_PATH = Path(__file__).resolve().parent.parent / "voice_agent.py"

# Everything voice_agent imports that only exists in the worker's own venv.
_STUB_MODULES = [
    "edge_tts",
    "livekit",
    "livekit.agents",
    "livekit.agents.voice",
    "livekit.agents.voice.room_io",
    "livekit.plugins",
]


@pytest.fixture(scope="module")
def worker():
    """Import voice_agent with the audio/ML stack stubbed out."""
    saved_modules = {name: sys.modules.get(name) for name in _STUB_MODULES}
    saved_env = dict(os.environ)

    for name in _STUB_MODULES:
        sys.modules[name] = MagicMock()
    # `from livekit import agents` resolves through the package attribute.
    sys.modules["livekit"].agents = sys.modules["livekit.agents"]
    sys.modules["livekit.plugins"].groq = MagicMock()
    sys.modules["livekit.plugins"].noise_cancellation = MagicMock()
    sys.modules["livekit.plugins"].silero = MagicMock()

    try:
        spec = importlib.util.spec_from_file_location("_voice_agent_under_test", WORKER_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        yield module
    finally:
        # Restore os.environ exactly: _load_env_file() uses setdefault, so keys it
        # CREATED would survive a plain monkeypatch teardown and leak .env values
        # (including a real GROQ key) into every test that runs after this one.
        os.environ.clear()
        os.environ.update(saved_env)
        for name, original in saved_modules.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original


# ---------------------------------------------------------------------------
# _extract_turn
# ---------------------------------------------------------------------------
def _item(**kwargs):
    """A ChatMessage-shaped stand-in. Only the attributes given exist."""
    return SimpleNamespace(**kwargs)


def test_extract_turn_reads_a_normal_final_turn(worker):
    turn = worker._extract_turn(
        _item(role="user", text_content="what jobs am I eligible for?", id="turn-7")
    )
    assert turn is not None
    assert (turn.role, turn.text, turn.is_final, turn.turn_id) == (
        "user",
        "what jobs am I eligible for?",
        True,
        "turn-7",
    )


def test_extract_turn_ignores_a_list_valued_content(worker):
    """`.content` is a LIST of parts and must never be used as the text.

    This is the bug the function exists to prevent: falling back to `.content`
    means an audio- or image-only turn stringifies to a Python repr —
    "[ImageContent(id='img_…')]" — and that repr gets persisted as the student's
    spoken words, into the same conversation the text chat reads back.
    """
    turn = worker._extract_turn(
        _item(role="user", content=["ImageContent(id='img_1')"], text_content=None)
    )
    assert turn is None


def test_extract_turn_ignores_a_text_attribute(worker):
    """Only `.text_content`. `.text` is not the SDK's contract here."""
    assert worker._extract_turn(_item(role="user", text="hello", text_content=None)) is None


@pytest.mark.parametrize("blank", ["", "   ", "\n\t "])
def test_extract_turn_drops_whitespace_only_text(worker, blank):
    """A turn of pure whitespace is not something the student said.

    Persisting it would put an empty bubble in the transcript and an empty user
    turn into the next prompt.
    """
    assert worker._extract_turn(_item(role="user", text_content=blank)) is None


def test_extract_turn_drops_a_missing_text_content(worker):
    assert worker._extract_turn(_item(role="user")) is None


@pytest.mark.parametrize("role", ["system", "tool", "developer", None])
def test_extract_turn_accepts_only_user_and_assistant(worker, role):
    """The server rejects any other speaker with a 422, so filtering here keeps
    the worker from generating requests that can only fail — and stops a
    'system' turn ever being offered for storage, which would be a
    prompt-injection vector on every later request."""
    assert worker._extract_turn(_item(role=role, text_content="hello")) is None


def test_extract_turn_treats_an_absent_finality_flag_as_final(worker):
    """`conversation_item_added` only fires for committed items in 1.6.10, so an
    item with no finality flag is final. Assuming interim instead would discard
    every turn."""
    turn = worker._extract_turn(_item(role="assistant", text_content="Two of three."))
    assert turn is not None and turn.is_final is True


@pytest.mark.parametrize(
    "flags,expected",
    [
        ({"is_final": False}, False),
        ({"is_final": True}, True),
        ({"final": False}, False),
        ({"interim": True}, False),
        ({"interim": False}, True),
    ],
)
def test_extract_turn_honours_whichever_finality_flag_is_present(worker, flags, expected):
    turn = worker._extract_turn(_item(role="user", text_content="hi", **flags))
    assert turn is not None and turn.is_final is expected


def test_extract_turn_stringifies_a_non_string_turn_id(worker):
    """turn_id becomes provider_turn_id, which the server validates as a string."""
    turn = worker._extract_turn(_item(role="user", text_content="hi", id=12345))
    assert turn is not None and turn.turn_id == "12345"


# ---------------------------------------------------------------------------
# _resolve_conversation_id
# ---------------------------------------------------------------------------
def _ctx(room_name=None, identities=()):
    participants = {
        f"p{i}": SimpleNamespace(identity=ident) for i, ident in enumerate(identities)
    }
    room = SimpleNamespace(name=room_name, remote_participants=participants)
    return SimpleNamespace(room=room)


def test_resolve_conversation_id_prefers_the_room_name(worker):
    """The room name wins over participant identity, deliberately.

    It is available the moment ctx.connect() returns, whereas remote_participants
    races the browser's join — an empty mapping would silently mis-resolve. It
    also cannot be confused by a second participant joining.
    """
    ctx = _ctx(room_name=f"{worker.ROOM_PREFIX}CID", identities=["A-DIFFERENT-IDENTITY"])
    assert worker._resolve_conversation_id(ctx) == "CID"


def test_resolve_conversation_id_strips_the_per_call_nonce(worker):
    """Rooms are reep-conversation-<id>-<nonce>.

    The nonce exists so every call is a NEW room — LiveKit applies a token's
    agent dispatch only at room creation, so reusing a lingering room silently
    drops the agent. Conversation ids are dash-free uuid4 hex, so the first dash
    after the prefix separates id from nonce. Failing to strip it would resolve a
    conversation id that does not exist, and every transcript POST would 404.
    """
    cid = "0f9c1a2b3d4e5f60718293a4b5c6d7e8"
    ctx = _ctx(room_name=f"{worker.ROOM_PREFIX}{cid}-a1b2c3d4")
    assert worker._resolve_conversation_id(ctx) == cid


def test_resolve_conversation_id_falls_back_to_participant_identity(worker):
    """A room whose name lacks the prefix is not one this server named."""
    ctx = _ctx(room_name="some-other-room", identities=["IDENT-FROM-PARTICIPANT"])
    assert worker._resolve_conversation_id(ctx) == "IDENT-FROM-PARTICIPANT"


def test_resolve_conversation_id_survives_a_roomless_context(worker):
    """Never raise. A failure here would kill the session before a word is said."""
    assert worker._resolve_conversation_id(SimpleNamespace(room=None)) == ""


# ---------------------------------------------------------------------------
# Configuration the deployment depends on
# ---------------------------------------------------------------------------
def test_agent_server_bounds_the_drain_and_the_prefork_fan_out(worker):
    """The SDK defaults are wrong for this deployment and must stay overridden.

    drain_timeout defaults to 3600 — an hour of waiting on SIGTERM, which would
    force an hour-long stop_grace_period or a SIGKILL through a live call.
    num_idle_processes defaults to 24 in prod; each child carries this module's
    ~2 GB import set, so a container sized for a college cohort OOMs during
    startup, before taking a single call.
    """
    # AgentServer is a MagicMock here, so inspect what the module PASSED to it —
    # which is the thing under test. (The resolved value was also confirmed for
    # real in the worker's own venv: server._drain_timeout == 900.)
    kwargs = sys.modules["livekit.agents"].AgentServer.call_args.kwargs
    assert kwargs["drain_timeout"] == 900
    assert kwargs["num_idle_processes"] == 1
    # Must stay strictly above the 5s bound in the transcript shutdown callback,
    # or the parent SIGKILLs the job process mid-write.
    assert kwargs["shutdown_process_timeout"] > 5
    assert kwargs["job_memory_limit_mb"] > 0


def test_the_greeting_is_the_required_one(worker):
    """The greeting is a product requirement, not a nicety."""
    assert worker.GREETING.startswith("Jai Shri Gurudev")
