"""Transactional audit/outbox and idempotency helpers for v1 commands."""

import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models.redesign import ApiIdempotencyKey, AuditEvent, OutboxEvent


def request_context(request: Any) -> tuple[str | None, str | None]:
      return request.headers.get("X-Request-ID"), request.headers.get("X-Correlation-ID")


def request_hash(payload: Any) -> str:
      canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
      return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def replay_or_reserve(
      db: Session, *, principal_id: str, route: str, key: str | None, payload: Any
) -> ApiIdempotencyKey | None:
      """Return a stored response or reserve the key inside the current transaction."""
      if not key:
                return None
            key = key.strip()
    if not key or len(key) > 200:
              raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Idempotency-Key.")
          digest = request_hash(payload)
    row = db.scalar(
              select(ApiIdempotencyKey)
              .where(
                            ApiIdempotencyKey.principal_id == principal_id,
                            ApiIdempotencyKey.route == route,
                            ApiIdempotencyKey.key == key,
              )
              .with_for_update()
    )
    if row is not None:
              if row.request_hash != digest:
                            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Idempotency-Key was reused with a different request.")
                        if row.response_json is None:
                                      raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="An identical command is already being processed.")
                                  return row
    row = ApiIdempotencyKey(principal_id=principal_id, route=route, key=key, request_hash=digest)
    db.add(row)
    db.flush()
    return None


def store_response(row: ApiIdempotencyKey | None, *, status_code: int, body: dict) -> None:
      if row is not None:
                row.response_status = status_code
                row.response_json = body


def record_change(
      db: Session, *, session: dict, request: Any, tenant_id: str | None,
      entity_type: str, entity_id: str, action: str,
      before: dict | None, after: dict | None, event_type: str, payload: dict,
) -> None:
      request_id, correlation_id = request_context(request)
    db.add(AuditEvent(
              tenant_id=tenant_id, actor_user_id=session.get("userId"), actor_type="USER",
              request_id=request_id, correlation_id=correlation_id, entity_type=entity_type,
              entity_id=entity_id, action=action, before_json=before, after_json=after,
              metadata_json={"route": str(request.url.path)},
    ))
    event_id = uuid.uuid4().hex
    db.add(OutboxEvent(
              tenant_id=tenant_id, event_type=event_type, aggregate_type=entity_type,
              aggregate_id=entity_id, payload={
                            "event_id": event_id, "event_type": event_type, "aggregate_type": entity_type,
                            "aggregate_id": entity_id, "actor_id": session.get("userId"),
                            "tenant_id": tenant_id, "request_id": request_id, "correlation_id": correlation_id,
                            "payload": payload,
              },
    ))


def utc_now() -> datetime:
      return datetime.now(timezone.utc)
