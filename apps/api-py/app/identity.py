"""Request dependencies: read the session from the reep_session cookie."""

from fastapi import HTTPException, Request, WebSocket, WebSocketException, status

from .security import SESSION_COOKIE, verify_session_token


def get_current_session(request: Request) -> dict:
    token = request.cookies.get(SESSION_COOKIE)
    payload = verify_session_token(token) if token else None
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sign in required.")
    return payload


def get_optional_session(request: Request) -> dict | None:
    """The session if a valid reep_session cookie is present, else None. Never raises.

    For endpoints that serve both anonymous callers and signed-in ones with the
    same handler — the password endpoints in app/routers/local_auth.py: create
    and forgot arrive with no cookie, change arrives with one. They bind a
    present session to the submitted address and require nothing when there is
    none. An invalid or expired cookie reads as "no session" rather than a 401,
    because the anonymous path is a legitimate one and a stale cookie must not
    turn a forgot-password attempt into a refusal.
    """
    token = request.cookies.get(SESSION_COOKIE)
    return verify_session_token(token) if token else None


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
