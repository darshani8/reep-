"""Text chat with shared, persistent memory.

POST /api/agent/chat  { session_id, message } -> { reply, session_id, model }

Per the unified-assistant spec: save the user turn to the centralized SQLite
memory, replay the whole session history to the LLM, return the reply, and save
it too — so a later turn (text OR the voice agent, same session_id) has context.

The LLM goes through the universal adapter (app/ai/llm.py), so it runs on
whatever provider is configured — Groq today, Gemini once a key is added, with
no code change. The egress gate still applies: this is a general conversational
assistant, so `carries_student_data` stays False; wire it True on any path that
injects a student's private records, and remote free models are refused.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..ai.llm import complete_chat, llm_config
from ..deps import get_current_session
from ..memory import get_history, save_message

router = APIRouter(prefix="/api/agent", tags=["agent"])

SYSTEM_PROMPT = (
    "You are the REEP student assistant for a college placement dashboard. Answer "
    "clearly and concisely, and use the earlier conversation for context. You are a "
    "general helper and do not have direct access to a student's private records; if "
    "asked for specific marks/attendance, say those come from the authenticated "
    "records view."
)

# Keep the replayed context bounded so a long session can't blow the token window.
HISTORY_LIMIT = 40


class ChatIn(BaseModel):
    session_id: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=4000)


class ChatOut(BaseModel):
    reply: str
    session_id: str
    model: str


class HistoryOut(BaseModel):
    session_id: str
    turns: list[dict]


@router.get("/history", response_model=HistoryOut)
def history(session_id: str, session: dict = Depends(get_current_session)) -> HistoryOut:
    """The unified conversation for a session — written by BOTH the text chat and
    the voice worker, so a reconnecting client can restore the full thread."""
    return HistoryOut(session_id=session_id, turns=get_history(session_id))


@router.post("/chat", response_model=ChatOut)
def chat(body: ChatIn, session: dict = Depends(get_current_session)) -> ChatOut:
    cfg = llm_config()
    if cfg is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No LLM provider configured — set a provider key in apps/api-py/.env.",
        )

    save_message(body.session_id, "user", body.message)
    history = get_history(body.session_id, limit=HISTORY_LIMIT)
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, *history]

    try:
        reply = complete_chat(messages, max_tokens=1024)
    except Exception as exc:  # network / provider / quota — never 500 the UI
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=f"LLM request failed: {exc}"
        )

    save_message(body.session_id, "assistant", reply)
    return ChatOut(reply=reply, session_id=body.session_id, model=f"{cfg.provider}:{cfg.model}")
