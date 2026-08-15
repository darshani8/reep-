"""Voice worker liveness (Assistant V2 Phase A — voice readiness).

The real-time voice worker (voice_agent.py) runs as a SEPARATE process. It has
no inbound HTTP surface the API can poll, so it pushes a heartbeat instead: one
row per worker_id, its last_seen bumped on POST /api/voice/heartbeat. GET
/api/voice/status reads it back and calls voice "healthy" only when some worker
has checked in within the last 30 seconds. No enums — a plain liveness row.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


class VoiceWorkerHeartbeat(Base):
    __tablename__ = "voice_worker_heartbeats"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    # One row per worker process; upserted on each heartbeat.
    worker_id: Mapped[str] = mapped_column(String, unique=True)
    last_seen: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
