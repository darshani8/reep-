"""Request dependencies: read the session from the reep_session cookie."""

from fastapi import HTTPException, Request, WebSocket, WebSocketException, status

from .security import SESSION_COOKIE, verify_session_token


def _with_live_mentor_id(payload: dict) -> dict:
    """A faculty member becomes a mentor when the Main Admin assigns them their
    first student (routers/director.py::set_student_mentor creates the group),
    and that can happen while they are signed in. Their cookie was minted
    before the group existed, so it carries no `mentorId` - and every rule-2
    reader keys on that claim, which would show them nobody until they signed
    out and back in. So, in that ONE case (role MENTOR, claim absent), the
    group is looked up live: one indexed read, and the claim is filled for
    this request. A mentor with no group still gets nothing - the lookup finds
    no row and the claim stays absent, which is rule 2 exactly as before."""
    if payload.get("role") == "MENTOR" and not payload.get("mentorId") and payload.get("userId"):
        from sqlalchemy import select

        from .db import SessionLocal
        from .models.user import Mentor

        with SessionLocal() as db:
            mentor_id = db.scalar(select(Mentor.id).where(Mentor.user_id == payload["userId"]))
        if mentor_id:
            payload["mentorId"] = mentor_id
    return payload


def get_current_session(request: Request) -> dict:
    token = request.cookies.get(SESSION_COOKIE)
    payload = verify_session_token(token) if token else None
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sign in required.")
    return _with_live_mentor_id(payload)


def get_ws_session(websocket: WebSocket) -> dict:
    """Session for a WebSocket route. Same cookie, same verification, different
    failure vocabulary — a WS scope cannot carry an HTTP response.

    Two things force this to be a sibling rather than a reuse of the function
    above, and both fail SILENTLY if ignored:

      * The parameter must be annotated `WebSocket`, not `Request`. FastAPI
        fills a Request-annotated parameter only when the connection IS a
        Request (fastapi/dependencies/utils.py), so on a websocket scope the
        argument is never supplied and the dependency raises TypeError before
        the handshake completes — the browser gets a failed connection with no
        close code at all.
      * HTTPException is routed to FastAPI's http_exception_handler, which
        emits `http.response.start` — illegal on a websocket scope.
        WebSocketException is the only exception the exception middleware can
        serve here, and 1008 is the code FastAPI's own WS validation handler
        uses.

    Callers that want the browser to learn WHY should accept the socket first
    and call this explicitly, catching WebSocketException: a close sent before
    accept fails the HTTP upgrade, and the browser WebSocket API surfaces
    neither code nor reason for that. See app/routers/interview.py.
    """
    token = websocket.cookies.get(SESSION_COOKIE)
    payload = verify_session_token(token) if token else None
    if not payload:
        raise WebSocketException(
            code=status.WS_1008_POLICY_VIOLATION, reason="Sign in required."
        )
    return payload
