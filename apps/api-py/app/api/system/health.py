"""Liveness and readiness probes.

Two endpoints, deliberately different:

  /health   LIVENESS  — is this process alive? Touches nothing, so it answers
                        even before Postgres is up. An orchestrator restarts a
                        container that fails this.
  /ready    READINESS — can this process actually serve requests? Checks the
                        dependencies a request needs. An orchestrator takes a
                        pod out of the load balancer when this fails, WITHOUT
                        killing it — the right response to a database blip.

Conflating the two is a common outage amplifier: if liveness checks the DB, a
brief Postgres wobble restarts every API container at once and turns a
recoverable dependency blip into a full outage.
"""

from fastapi import APIRouter, Response, status
from sqlalchemy import text

from app.config import settings
from app.db import SessionLocal

router = APIRouter()


@router.get("/health")
def health() -> dict:
    """Liveness. Intentionally dependency-free."""
    return {"status": "ok", "service": "reep-api-py"}


@router.get("/ready")
def ready(response: Response) -> dict:
    """Readiness — reports each dependency separately so a failing probe says
    WHICH one broke instead of just 'not ready'.

    Returns 503 when a hard dependency is down. Voice is reported but never
    fails the probe: the dashboard is fully usable without it, so a missing
    LiveKit key must not pull the whole API out of rotation."""
    checks: dict[str, object] = {}
    healthy = True

    # Hard dependency: every meaningful request reads Postgres.
    try:
        with SessionLocal() as db:
            db.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as exc:  # noqa: BLE001 — the reason is the useful part
        checks["database"] = f"error: {type(exc).__name__}"
        healthy = False

    # Soft dependency: voice degrades on its own and says so via /api/voice/status.
    checks["voice"] = {
        "livekit_configured": settings.livekit_ready,
        "speech_key_configured": settings.voice_model_key_present,
        # Surfaced because a blank worker secret is an OPEN ingestion endpoint
        # in production — worth seeing on a readiness dashboard, not only in
        # the 500 the endpoint itself returns.
        "worker_auth_configured": bool(settings.voice_worker_secret),
        "maintenance": bool(settings.voice_maintenance_message.strip()),
    }

    if not healthy:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {"status": "ok" if healthy else "degraded", "checks": checks}
