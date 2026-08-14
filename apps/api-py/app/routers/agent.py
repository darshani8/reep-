"""Agent chat — the ADK general assistant behind an authenticated endpoint.

POST /api/agent/chat  { message } -> { reply, model }

Non-streaming for now; SSE streaming (the target for the Angular chat) is the
next step. The student-data agents (Profile Manager, Resume Optimizer) are added
once their domain models are ported, and run through the egress gate.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from google.genai import types
from google.adk.runners import InMemoryRunner
from pydantic import BaseModel, Field

from ..ai.agents import build_general_agent
from ..ai.llm import LLMNotConfigured
from ..deps import get_current_session

router = APIRouter(prefix="/api/agent", tags=["agent"])


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


class ChatOut(BaseModel):
    reply: str
    model: str


@router.post("/chat", response_model=ChatOut)
async def chat(body: ChatIn, session: dict = Depends(get_current_session)) -> ChatOut:
    try:
        agent = build_general_agent()
    except LLMNotConfigured as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))

    runner = InMemoryRunner(agent=agent, app_name="reep")
    user_id = session["userId"]
    adk_session = await runner.session_service.create_session(app_name="reep", user_id=user_id)
    message = types.Content(role="user", parts=[types.Part(text=body.message)])

    reply = ""
    async for event in runner.run_async(
        user_id=user_id, session_id=adk_session.id, new_message=message
    ):
        if event.is_final_response() and event.content and event.content.parts:
            reply = event.content.parts[0].text or ""

    return ChatOut(reply=reply, model=str(getattr(agent.model, "model", "")))
