"""Background LiveKit voice worker — Gemini Live (native speech-to-speech).

Runs as a SEPARATE process from the FastAPI server, in its own environment (the
audio/ML deps are heavy and usually want Python 3.12):

    pip install -r requirements-voice.txt
    # env: GEMINI_API_KEY, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
    python voice_agent.py dev            # `start` in production

Flow: it joins the LiveKit room the browser connected to, resolves the
session_id (the room is named reep-<session_id> and the participant identity IS
the session_id), loads that session's history from the SAME SQLite memory bank
the text chat uses (app/memory.py — imports only stdlib, so this worker does not
need the FastAPI deps), seeds Gemini Live with it, and saves both sides'
transcripts back. One memory, shared by text and voice.

Targets livekit-agents ~1.5 with the Google Gemini Live plugin. The two spots
marked "VERIFY" use APIs that can shift between minor versions — confirm them
against your installed livekit-agents before the first run. This worker needs
live LiveKit + Gemini credentials to run and so is not exercised by the repo's
tests.
"""

from __future__ import annotations

import logging
import os

from livekit import agents
from livekit.agents import Agent, AgentServer, AgentSession, JobContext
from livekit.plugins import google

from app.memory import get_history, save_message

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("reep-voice")

# Gemini Live reads the Google/Gemini key from the environment.
os.environ.setdefault("GOOGLE_API_KEY", os.getenv("GEMINI_API_KEY", ""))

GEMINI_LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"

BASE_INSTRUCTIONS = (
    "You are the REEP student voice assistant for a college placement dashboard. "
    "Speak naturally and concisely. Use the prior conversation below (from the "
    "student's text chat, same session) for continuity."
)


def _resolve_session_id(ctx: JobContext) -> str:
    """The token set identity = session_id and room = reep-<session_id>; use
    either. VERIFY: remote_participants access can vary by version."""
    for participant in ctx.room.remote_participants.values():
        if participant.identity:
            return participant.identity
    name = ctx.room.name or ""
    return name[len("reep-") :] if name.startswith("reep-") else name


def _history_prompt(session_id: str) -> str:
    turns = get_history(session_id, limit=40)
    if not turns:
        return ""
    lines = [f"{t['role']}: {t['content']}" for t in turns]
    return "Prior conversation:\n" + "\n".join(lines)


server = AgentServer()


@server.rtc_session(agent_name="reep-voice")
async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    session_id = _resolve_session_id(ctx)
    log.info("voice session for session_id=%s (room=%s)", session_id, ctx.room.name)

    instructions = BASE_INSTRUCTIONS
    prior = _history_prompt(session_id)
    if prior:
        instructions = f"{BASE_INSTRUCTIONS}\n\n{prior}"

    session = AgentSession(
        llm=google.realtime.RealtimeModel(
            model=GEMINI_LIVE_MODEL,
            voice="Puck",
            temperature=0.8,
        )
    )

    # Persist both sides' transcripts to the shared memory as they are produced.
    # VERIFY: the event name and item shape can differ across livekit-agents
    # minor versions; the getattr chain below tolerates the common variants.
    @session.on("conversation_item_added")
    def _on_item(ev) -> None:  # noqa: ANN001
        item = getattr(ev, "item", ev)
        role = getattr(item, "role", None)
        text = (
            getattr(item, "text_content", None)
            or getattr(item, "content", None)
            or getattr(item, "text", None)
        )
        if role in ("user", "assistant") and text:
            try:
                save_message(session_id, role, text if isinstance(text, str) else str(text))
            except Exception:  # never let persistence kill the call
                log.exception("failed to persist transcript")

    await session.start(agent=Agent(instructions=instructions), room=ctx.room)


if __name__ == "__main__":
    agents.cli.run_app(server)
