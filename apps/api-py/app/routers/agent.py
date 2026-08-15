"""Text chat with a SERVER-OWNED, persistent conversation.

The conversation is ALWAYS derived from the authenticated session — the client
never sends a session_id or conversation_id for writing or for deciding whose
history to read. This closes the P0 where a client-chosen `assistant-${userId}`
let a signed-in user read/write another user's thread.

  POST   /api/agent/chat          { message } -> { reply, conversation_id, model }
  POST   /api/agent/chat/stream   { message } -> SSE (same server-owned conversation)
  GET    /api/agent/history       -> { conversation_id, turns } for the CALLER
  DELETE /api/agent/conversation  -> soft-clears the caller's conversation, 204
  GET    /api/agent/runs          -> the caller's recent audit rows

The LLM goes through the universal adapter (app/ai/llm.py). The egress gate still
applies: this is a general conversational assistant, so `carries_student_data`
stays False; wire it True on any path that injects a student's private records.
Provider/exception detail is logged server-side and NEVER surfaced to the client.
"""

import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import conversations as convo
from .. import knowledge
from ..ai.llm import complete_chat, llm_config, stream_chat
from ..db import SessionLocal, get_db
from ..deps import get_current_session
from ..models.agent_run import AgentRun, AgentRunStatus
from ..models.user import Role

log = logging.getLogger(__name__)

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

# Shown to the client on any provider/network/quota failure. The real cause is
# logged server-side — never leaked to the caller.
FRIENDLY_ERROR = "The assistant is temporarily unavailable, please try again."


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


class ChatOut(BaseModel):
    reply: str
    conversation_id: str
    model: str


class HistoryOut(BaseModel):
    conversation_id: str
    turns: list[dict]


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

    # Server-owned: the conversation is derived from the session, never the body.
    conversation = convo.get_or_create(db, session["userId"], Role(session["role"]))
    convo.append_message(db, conversation.id, "user", body.message)
    turns = convo.history(db, conversation.id, limit=HISTORY_LIMIT)
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, *turns]

    try:
        reply = complete_chat(messages, max_tokens=1024)
    except Exception:  # network / provider / quota — never 500 the UI, never leak
        log.exception("agent chat LLM call failed (conversation=%s)", conversation.id)
        _persist_run(db, session, body.message, "", AgentRunStatus.FAILED, model_label, started)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=FRIENDLY_ERROR
        )

    convo.append_message(db, conversation.id, "assistant", reply)
    _persist_run(db, session, body.message, reply, AgentRunStatus.ANSWERED, model_label, started)
    return ChatOut(reply=reply, conversation_id=conversation.id, model=model_label)


@router.post("/chat/stream")
def chat_stream(
    body: ChatIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """Server-Sent Events variant of /chat: streams the reply token-by-token as
    `data: {"delta": "..."}` frames, then `data: [DONE]`. Same server-owned
    conversation. The full turn is saved and an AgentRun row is written once the
    stream ends — from a fresh Session, since the request's own session is torn
    down when this handler returns and the generator keeps running."""
    cfg = llm_config()
    if cfg is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No LLM provider configured — set a provider key in apps/api-py/.env.",
        )

    started = datetime.now(timezone.utc)
    model_label = f"{cfg.provider}:{cfg.model}"

    # Resolve + persist the user turn on the request's own session, so the
    # conversation id is settled before the generator (with a fresh session) runs.
    conversation = convo.get_or_create(db, session["userId"], Role(session["role"]))
    conversation_id = conversation.id
    convo.append_message(db, conversation_id, "user", body.message)
    turns = convo.history(db, conversation_id, limit=HISTORY_LIMIT)
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, *turns]

    def event_stream():
        chunks: list[str] = []
        outcome = AgentRunStatus.ANSWERED
        yield f"data: {json.dumps({'conversation_id': conversation_id, 'model': model_label})}\n\n"
        try:
            for delta in stream_chat(messages, max_tokens=1024):
                chunks.append(delta)
                yield f"data: {json.dumps({'delta': delta})}\n\n"
        except Exception:  # provider/network/quota — reported in-band, never leaked
            log.exception("agent stream LLM call failed (conversation=%s)", conversation_id)
            outcome = AgentRunStatus.FAILED
            yield f"data: {json.dumps({'error': FRIENDLY_ERROR})}\n\n"

        reply = "".join(chunks)
        # Fresh session: the injected request scope is already gone by now.
        with SessionLocal() as fresh:
            if reply:
                convo.append_message(fresh, conversation_id, "assistant", reply)
            _persist_run(fresh, session, body.message, reply, outcome, model_label, started)
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/history", response_model=HistoryOut)
def history(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> HistoryOut:
    """The CALLER's current conversation — resolved from the session, no id in.
    A user can only ever read their own thread; there is no parameter to name
    someone else's."""
    conversation = convo.current_conversation(db, session["userId"])
    if conversation is None:
        return HistoryOut(conversation_id="", turns=[])
    return HistoryOut(
        conversation_id=conversation.id,
        turns=convo.history(db, conversation.id, limit=HISTORY_LIMIT),
    )


@router.delete("/conversation", status_code=status.HTTP_204_NO_CONTENT)
def delete_conversation(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> Response:
    """Soft-clear the caller's current conversation. The next chat opens a fresh
    thread. Scoped to the session — a client cannot clear anyone else's."""
    convo.clear(db, session["userId"])
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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


class KnowledgeHit(BaseModel):
    chunk_text: str
    document_title: str
    source_type: str
    source_url: str | None
    anchor: str | None
    score: float


class KnowledgeSearchOut(BaseModel):
    results: list[KnowledgeHit]


@router.get("/knowledge/search", response_model=KnowledgeSearchOut)
def knowledge_search(
    q: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> KnowledgeSearchOut:
    """Retrieve APPROVED Knowledge-Base chunks that ground an answer to `q`.

    STUDENT-only and scoped to the 'student' audience: this surfaces the
    "explain the rules" layer (policy/FAQ/guidance), never any live student
    fact. Returns an empty list when nothing approved matches, so the caller can
    say "no approved answer" rather than inventing one. Meant for the
    frontend/orchestrator to build grounded, cited replies later.
    """
    if session.get("role") != Role.STUDENT.value:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Knowledge search is available to student accounts.",
        )
    hits = knowledge.search(db, q, audience="student", limit=5)
    return KnowledgeSearchOut(results=[KnowledgeHit(**h) for h in hits])
