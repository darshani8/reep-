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
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import conversations as convo
from .. import knowledge
from ..ai import orchestrator
from ..ai.llm import complete_chat, llm_config, stream_chat
from ..db import SessionLocal, get_db
from ..deps import get_current_session
from ..models.agent_run import AgentRun, AgentRunStatus
from ..models.conversation import Message
from ..models.feedback import AssistantFeedback, FeedbackRating
from ..models.user import Role
from ..redaction import redact_pii

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


class AskIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


class ActionOut(BaseModel):
    label: str
    route: str
    reason: str


class SourceOut(BaseModel):
    label: str
    type: str  # "student-record" | "policy"


class AssistantResponse(BaseModel):
    answer: str
    actions: list[ActionOut] = []
    sources: list[SourceOut] = []
    limitations: list[str] = []


class AskOut(AssistantResponse):
    conversation_id: str
    model: str
    run_id: str  # the AgentRun id for THIS turn — attach feedback to it


def _persist_run(
    db: Session,
    session: dict,
    question: str,
    answer: str,
    outcome: AgentRunStatus,
    model: str | None,
    started: datetime,
    trace: list | None = None,
    citations: list | None = None,
    intent: str | None = None,
    resolved: bool | None = None,
) -> str:
    """One audit row per question — scope stamped at run time (mirrors the
    Next.js AgentRun store). The structured assistant path stores its actions in
    `trace` and its sources in `citations`, and stamps the grounding signal
    (`intent`, `resolved`). Returns the new run's id so the caller can hand it to
    the client for feedback."""
    scope = "self" if session.get("role") == "STUDENT" else "programme"
    run = AgentRun(
        actor_id=session["userId"],
        role=Role(session["role"]),
        scope=scope,
        question=question,
        answer=answer,
        status=outcome,
        trace=trace or [],
        citations=citations or [],
        model=model,
        intent=intent,
        resolved=resolved,
        duration_ms=int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
    )
    db.add(run)
    db.commit()
    return run.id


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
    # Captured BEFORE the user turn is appended is not required (the predicate
    # counts assistant turns), but read it before the reply exists so the
    # greeting decision is made from the same state the answer was built on.
    first_reply = convo.awaiting_first_reply(db, conversation.id)
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

    if first_reply:
        reply = convo.open_with_greeting(reply)

    convo.append_message(db, conversation.id, "assistant", reply)
    if first_reply:
        convo.mark_greeted(db, conversation.id)
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
    first_reply = convo.awaiting_first_reply(db, conversation_id)
    convo.append_message(db, conversation_id, "user", body.message)
    turns = convo.history(db, conversation_id, limit=HISTORY_LIMIT)
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, *turns]

    def event_stream():
        chunks: list[str] = []
        outcome = AgentRunStatus.ANSWERED
        yield f"data: {json.dumps({'conversation_id': conversation_id, 'model': model_label})}\n\n"
        # The greeting must reach a STREAMING client too. Emitted as the first
        # delta so the student sees it immediately, and kept in `chunks` so the
        # persisted turn matches exactly what was displayed — otherwise the
        # transcript and the screen disagree about what the assistant said.
        if first_reply:
            opening = f"{convo.GREETING}! "
            chunks.append(opening)
            yield f"data: {json.dumps({'delta': opening})}\n\n"
        try:
            for delta in stream_chat(messages, max_tokens=1024):
                chunks.append(delta)
                yield f"data: {json.dumps({'delta': delta})}\n\n"
        except Exception:  # provider/network/quota — reported in-band, never leaked
            log.exception("agent stream LLM call failed (conversation=%s)", conversation_id)
            outcome = AgentRunStatus.FAILED
            yield f"data: {json.dumps({'error': FRIENDLY_ERROR})}\n\n"

        reply = "".join(chunks)
        # A failed turn must not be stored as an assistant message OR consume
        # the greeting. Without this, a provider outage on the very first turn
        # leaves `chunks` holding nothing but "Jai Shri Gurudev! " — a bare
        # greeting persisted as the answer, replayed to the model as context on
        # the next turn, and the student never greeted again.
        model_said_something = outcome == AgentRunStatus.ANSWERED and any(
            c for c in chunks[1:] if c.strip()
        ) if first_reply else bool(reply.strip())

        # Fresh session: the injected request scope is already gone by now.
        with SessionLocal() as fresh:
            if model_said_something:
                convo.append_message(fresh, conversation_id, "assistant", reply)
                if first_reply:
                    convo.mark_greeted(fresh, conversation_id)
            _persist_run(fresh, session, body.message, reply, outcome, model_label, started)
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/ask", response_model=AskOut)
def ask(
    body: AskIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> AskOut:
    """The STRUCTURED, tool-backed assistant path.

    Unlike /chat (free-form prose), this runs the orchestrator: it classifies the
    question, grounds the answer in read-only student tools or approved knowledge,
    and returns a typed AssistantResponse (answer + actions + sources +
    limitations). The conversation is server-owned (derived from the session), the
    user turn and the assistant's answer text are persisted, and one AgentRun audit
    row records the structured actions/sources in trace/citations.

    Personalised (student-data) intents only run for STUDENT accounts; a non-student
    still gets policy/general answers with a stated limitation. The orchestrator
    degrades gracefully on any LLM/provider fault, so this endpoint does not 502.
    """
    started = datetime.now(timezone.utc)
    cfg = llm_config()
    model_label = f"{cfg.provider}:{cfg.model}" if cfg else "deterministic"

    # Server-owned: the conversation is derived from the session, never the body.
    conversation = convo.get_or_create(db, session["userId"], Role(session["role"]))
    first_reply = convo.awaiting_first_reply(db, conversation.id)
    convo.append_message(db, conversation.id, "user", body.message)

    result = orchestrator.answer_question(
        db, session.get("studentId"), session.get("role"), body.message
    )

    # ONE choke point for the compulsory greeting on this surface. Every
    # orchestrator branch — the six deterministic student-data builders, policy,
    # general, the non-student refusal and the exception fallback — returns
    # through this single `result["answer"]`, so greeting here cannot be missed
    # by a path, and a future branch inherits it for free.
    if first_reply:
        result["answer"] = convo.open_with_greeting(result["answer"])

    convo.append_message(db, conversation.id, "assistant", result["answer"])
    if first_reply:
        # Stamp only AFTER the greeted answer is persisted.
        convo.mark_greeted(db, conversation.id)
    run_id = _persist_run(
        db,
        session,
        body.message,
        result["answer"],
        AgentRunStatus.ANSWERED,
        model_label,
        started,
        trace=result["actions"],
        citations=result["sources"],
        intent=result.get("intent"),
        resolved=result.get("resolved"),
    )

    # `result` also carries intent/resolved (grounding signal, persisted above);
    # only the AssistantResponse fields belong on the wire.
    return AskOut(
        answer=result["answer"],
        actions=result["actions"],
        sources=result["sources"],
        limitations=result["limitations"],
        conversation_id=conversation.id,
        model=model_label,
        run_id=run_id,
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


# --- Feedback ----------------------------------------------------------------


class FeedbackIn(BaseModel):
    run_id: str
    rating: FeedbackRating
    note: str | None = Field(default=None, max_length=2000)


class FeedbackOut(BaseModel):
    ok: bool


@router.post("/feedback", response_model=FeedbackOut)
def feedback(
    body: FeedbackIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> FeedbackOut:
    """Rate the assistant turn identified by `run_id`.

    The caller MUST own the run (AgentRun.actor_id == the session user) — a run
    owned by anyone else is reported as 404, identical to a run that doesn't
    exist, so feedback can't be used to probe whether another user's run id is
    real. One row per (run, owner): a re-vote UPSERTs, never duplicates. The
    free-text note is PII-redacted before it is stored.
    """
    run = db.get(AgentRun, body.run_id)
    if run is None or run.actor_id != session["userId"]:
        # No existence leak: not-found and not-owned look the same.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Run not found."
        )

    note = redact_pii(body.note)
    existing = db.scalar(
        select(AssistantFeedback).where(
            AssistantFeedback.run_id == body.run_id,
            AssistantFeedback.owner_user_id == session["userId"],
        )
    )
    if existing is not None:
        existing.rating = body.rating
        existing.note = note
    else:
        db.add(
            AssistantFeedback(
                run_id=body.run_id,
                owner_user_id=session["userId"],
                rating=body.rating,
                note=note,
            )
        )
    db.commit()
    return FeedbackOut(ok=True)


# --- Metrics (DIRECTOR/ADMIN) ------------------------------------------------


@router.get("/metrics")
def metrics(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> dict:
    """Assistant health for staff — DIRECTOR/ADMIN only (403 otherwise).

    Aggregates over AgentRun (+ AssistantFeedback + voice Messages):
    resolution/refusal rates from the `resolved` grounding signal, latency, and
    breakdowns by intent/model/status, plus voice-turn and feedback tallies.

    NOTE: TTFT (time-to-first-token) is a STREAMING-path metric; /ask is
    non-streaming, so `avg_duration_ms` here is the compose-latency proxy (full
    request duration), not TTFT.
    """
    role = session.get("role")
    if role not in (Role.DIRECTOR.value, Role.ADMIN.value):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Assistant metrics are available to directors and admins.",
        )

    total_runs = db.scalar(select(func.count()).select_from(AgentRun)) or 0
    resolved_true = (
        db.scalar(
            select(func.count()).select_from(AgentRun).where(AgentRun.resolved.is_(True))
        )
        or 0
    )
    resolved_known = (
        db.scalar(
            select(func.count())
            .select_from(AgentRun)
            .where(AgentRun.resolved.isnot(None))
        )
        or 0
    )
    avg_duration = db.scalar(select(func.avg(AgentRun.duration_ms))) or 0

    resolution_rate = (resolved_true / total_runs) if total_runs else 0.0
    refusal_rate = (
        (1 - resolved_true / resolved_known) if resolved_known else 0.0
    )

    by_intent = {
        intent: count
        for intent, count in db.execute(
            select(AgentRun.intent, func.count())
            .where(AgentRun.intent.isnot(None))
            .group_by(AgentRun.intent)
        ).all()
    }
    by_model = {
        (model or "unknown"): count
        for model, count in db.execute(
            select(AgentRun.model, func.count()).group_by(AgentRun.model)
        ).all()
    }
    by_status = {
        st.value.lower(): count
        for st, count in db.execute(
            select(AgentRun.status, func.count()).group_by(AgentRun.status)
        ).all()
    }

    voice_turns = (
        db.scalar(
            select(func.count()).select_from(Message).where(Message.channel == "voice")
        )
        or 0
    )

    fb_counts = {
        rating: count
        for rating, count in db.execute(
            select(AssistantFeedback.rating, func.count()).group_by(
                AssistantFeedback.rating
            )
        ).all()
    }
    feedback_out = {
        "helpful": fb_counts.get(FeedbackRating.HELPFUL, 0),
        "not_helpful": fb_counts.get(FeedbackRating.NOT_HELPFUL, 0),
        "report": fb_counts.get(FeedbackRating.REPORT, 0),
    }

    return {
        "total_runs": total_runs,
        "resolution_rate": round(resolution_rate, 4),
        "refusal_rate": round(refusal_rate, 4),
        "avg_duration_ms": round(float(avg_duration), 1),
        "by_intent": by_intent,
        "by_model": by_model,
        "by_status": by_status,
        "voice_turns": voice_turns,
        "feedback": feedback_out,
    }
