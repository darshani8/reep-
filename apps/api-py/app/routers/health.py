"""Liveness probe — no DB, so it answers even before Postgres is up."""

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "reep-api-py"}
