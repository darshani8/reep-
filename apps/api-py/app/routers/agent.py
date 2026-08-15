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

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..ai.llm import complete_chat, llm_config
from ..db import get_db
from ..deps import get_current_session
from ..memory import get_history, save_message
from ..models.agent_run import AgentRun, AgentRunStatus
from ..models.user import Role

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


def _persist_run(
    db: Session,
    session: dict,
    question: str,
    answer: str,
    outcome: AgentRunStatus,
    model: str | None,
    started: datetime,
) -> None:
    """One audit row per question — scope stamped at run time (mirrors the
    Next.js AgentRun store)."""
    scope = "self" if session.get("role") == "STUDENT" else "programme"
    db.add(
        AgentRun(
            actor_id=session["userId"],
            role=Role(session["role"]),
            scope=scope,
            question=question,
            answer=answer,
            status=outcome,
            trace=[],
            citations=[],
            model=model,
            duration_ms=int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
        )
    )
    db.commit()


@router.post("/chat", response_model=ChatOut)
def chat(
    body: ChatIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> ChatOut:
    cfg = llm_config()
    if cfg is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No LLM provider configured — set a provider key in apps/api-py/.env.",
        )

    started = datetime.now(timezone.utc)
    model_label = f"{cfg.provider}:{cfg.model}"
    save_message(body.session_id, "user", body.message)
    history = get_history(body.session_id, limit=HISTORY_LIMIT)
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, *history]

    try:
        reply = complete_chat(messages, max_tokens=1024)
    except Exception as exc:  # network / provider / quota — never 500 the UI
        _persist_run(db, session, body.message, "", AgentRunStatus.FAILED, model_label, started)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=f"LLM request failed: {exc}"
        )

    save_message(body.session_id, "assistant", reply)
    _persist_run(db, session, body.message, reply, AgentRunStatus.ANSWERED, model_label, started)
    return ChatOut(reply=reply, session_id=body.session_id, model=model_label)


class RunOut(BaseModel):
    id: str
    scope: str
    question: str
    status: str
    model: str | None
    duration_ms: int
    created_at: datetime


@router.get("/runs", response_model=list[RunOut])
def runs(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[RunOut]:
    """The caller's own recent assistant runs (audit trail)."""
    rows = db.scalars(
        select(AgentRun)
        .where(AgentRun.actor_id == session["userId"])
        .order_by(AgentRun.created_at.desc())
        .limit(50)
    ).all()
    return [
        RunOut(
            id=r.id,
            scope=r.scope,
            question=r.question,
            status=r.status.value,
            model=r.model,
            duration_ms=r.duration_ms,
            created_at=r.created_at,
        )
        for r in rows
    ]
