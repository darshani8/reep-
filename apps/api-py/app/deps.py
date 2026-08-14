"""Request dependencies: read the session from the reep_session cookie."""

from fastapi import HTTPException, Request, status

from .security import SESSION_COOKIE, verify_session_token


def get_current_session(request: Request) -> dict:
    token = request.cookies.get(SESSION_COOKIE)
    payload = verify_session_token(token) if token else None
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sign in required.")
    return payload
