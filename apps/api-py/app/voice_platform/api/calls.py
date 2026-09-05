"""Call sessions as their participants and reviewers see them, plus the
call-close endpoint.

    GET  /api/platform/calls                 mine (STUDENT) / all (DIRECTOR)
    GET  /api/platform/calls/{id}            + a fresh presigned recording_s3_url
    POST /api/platform/calls/{id}/close      package whatever the buffer holds

Who may read a call: its owner; DIRECTOR/ADMIN; and a MENTOR only through
rule 2's gate on the linked interview record's student
(`_assert_can_access_student`, imported and never reimplemented).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ...db import get_db
from ...identity import get_current_session
from ...models.interview import InterviewSession
from ...models.user import Role
from ...models.voice_platform import PlatformCallSession
from ...routers.mentor import _assert_can_access_student
from ..monitoring.cloudwatch import handler_span
from ..storage import aurora
from ..storage.s3 import recording_store
from ..streaming import buffer as wav_buffer
from . import call_close
from .admin import CallOut, call_out

log = logging.getLogger("app.voice_platform.api.calls")

router = APIRouter(prefix="/api/platform/calls", tags=["voice-platform-calls"])


class CallDetailOut(CallOut):
    recording_s3_url: str | None
    recording_url_expires_in: int | None
    recording_available: bool
    recording_note: str


class CloseOut(BaseModel):
    session_id: str
    status: str
    recorded: bool
    uploaded: bool
    s3_key: str | None
    size_bytes: int
    duration_ms: int
    truncated: bool
    format: str
    notes: list[str]
    call: CallDetailOut


def _can_read(session: dict, row: PlatformCallSession, db: Session) -> None:
    role = session.get("role")
    if row.user_id == session.get("userId") or role in (Role.DIRECTOR.value, Role.ADMIN.value):
        return
    if role == Role.MENTOR.value and row.interview_session_id:
        interview = db.get(InterviewSession, row.interview_session_id)
        if interview is not None:
            _assert_can_access_student(session, interview.student_id, db)  # raises 403/404
            return
    raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your call session.")


def _detail(row: PlatformCallSession, db: Session) -> CallDetailOut:
    base = call_out(row).model_dump()
    url: str | None = None
    expires: int | None = None
    if row.recording_s3_key:
        store = recording_store()
        if store is not None:
            policy = aurora.get_recording_policy(db, row.degree_level)
            ttl = policy.presign_ttl_seconds if policy else None
            try:
                url = store.presigned_url(row.recording_s3_key, ttl)
                expires = ttl or store.presign_ttl_seconds
            except Exception as exc:  # noqa: BLE001 - a link is a convenience
                log.error("Presign failed for %s: %s", row.recording_s3_key, exc)
    meta = row.recording_meta or {}
    if row.recording_s3_key and url:
        note = "Presigned link; expires with recording_url_expires_in."
    elif row.recording_s3_key:
        note = "Recording is in S3 but no bucket client is configured on this server to sign a link."
    elif meta.get("local_path"):
        note = "Recording is on the server's audio volume (no PLATFORM_RECORDINGS_BUCKET)."
    elif row.status == "running":
        note = "Call is still running."
    else:
        note = "No recording: the policy was off, the candidate did not consent to audio storage, or nobody spoke."
    return CallDetailOut(
        **base,
        recording_s3_url=url,
        recording_url_expires_in=expires,
        recording_available=bool(row.recording_s3_key or meta.get("local_path")),
        recording_note=note,
    )


def _row_or_404(db: Session, session_id: str) -> PlatformCallSession:
    row = aurora.get_call_session(db, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Call session not found.")
    return row


@router.get("", response_model=list[CallOut])
def list_calls(
    degree: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[CallOut]:
    role = session.get("role")
    try:
        if role in (Role.DIRECTOR.value, Role.ADMIN.value):
            rows = aurora.list_call_sessions(db, degree_level=degree, limit=limit)
        else:
            rows = aurora.list_call_sessions(db, degree_level=degree, user_id=session["userId"], limit=limit)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    return [call_out(r) for r in rows]


@router.get("/{session_id}", response_model=CallDetailOut)
def get_call(session_id: str, session: dict = Depends(get_current_session), db: Session = Depends(get_db)) -> CallDetailOut:
    row = _row_or_404(db, session_id)
    _can_read(session, row, db)
    return _detail(row, db)


@router.post("/{session_id}/close", response_model=CloseOut)
@handler_span("calls.close")
async def close_call(
    session_id: str, session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> CloseOut:
    """WAV Buffer Upload for a call whose socket did not close cleanly.

    Owner or DIRECTOR/ADMIN. If the buffer is still live in this worker, it is
    rendered and uploaded now; if the row was already closed, the current state
    is returned; a row that is `running` on another worker with no buffer here
    is 409 — the honest answer is "ask that worker", not a fake close.
    """
    row = _row_or_404(db, session_id)
    if row.user_id != session.get("userId") and session.get("role") not in (Role.DIRECTOR.value, Role.ADMIN.value):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your call session.")
    live = wav_buffer.live(session_id)
    if row.status != "running" and live is None:
        db.refresh(row)
        detail = _detail(row, db)
        return CloseOut(
            session_id=row.id, status=row.status, recorded=bool(row.recording_bytes), uploaded=bool(row.recording_s3_key),
            s3_key=row.recording_s3_key, size_bytes=row.recording_bytes or 0, duration_ms=row.recording_duration_ms or 0,
            truncated=row.recording_truncated, format=str((row.recording_meta or {}).get("format", "wav")),
            notes=["already closed"], call=detail,
        )
    if live is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This call is still running and its audio buffer is not on this worker; close the socket first.",
        )
    degree = row.degree_level
    db.close()  # the close handler opens its own session on a worker thread
    report = await call_close.finish_call(
        session_id, degree_level=degree, code=1001, reason="Closed via POST /calls/{id}/close", buffer=live
    )
    fresh_db = next(get_db())
    try:
        fresh = _row_or_404(fresh_db, session_id)
        detail = _detail(fresh, fresh_db)
    finally:
        fresh_db.close()
    return CloseOut(
        session_id=session_id, status=report.status, recorded=report.recorded, uploaded=report.uploaded,
        s3_key=report.s3_key, size_bytes=report.size_bytes, duration_ms=report.duration_ms,
        truncated=report.truncated, format=report.format, notes=report.notes, call=detail,
    )
