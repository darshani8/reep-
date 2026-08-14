"""LiveKit access-token minting for the voice assistant.

POST /api/voice/token { session_id } -> { token, url, room, identity }

The participant identity IS the session_id, so the background voice worker can
resolve the same SQLite conversation memory the text chat uses (one memory bank
per session, shared across text and voice). Requires a free LiveKit Cloud
project (LIVEKIT_URL/API_KEY/API_SECRET); returns 503 until configured.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from livekit import api
from pydantic import BaseModel, Field

from ..config import settings
from ..deps import get_current_session

router = APIRouter(prefix="/api/voice", tags=["voice"])


class TokenIn(BaseModel):
    session_id: str = Field(min_length=1, max_length=200)


class TokenOut(BaseModel):
    token: str
    url: str
    room: str
    identity: str


@router.post("/token", response_model=TokenOut)
def voice_token(body: TokenIn, session: dict = Depends(get_current_session)) -> TokenOut:
    if not (settings.livekit_url and settings.livekit_api_key and settings.livekit_api_secret):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Voice is not configured — set LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET.",
        )

    room = f"reep-{body.session_id}"
    token = (
        api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        # Identity = session_id: the worker reads it back to load this session's memory.
        .with_identity(body.session_id)
        .with_name(session.get("name") or body.session_id)
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room,
                can_publish=True,
                can_subscribe=True,
            )
        )
        .to_jwt()
    )
    return TokenOut(token=token, url=settings.livekit_url, room=room, identity=body.session_id)
