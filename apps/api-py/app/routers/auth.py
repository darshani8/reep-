"""Auth endpoints — the first working vertical slice.

Mirrors the Next.js `authenticate()` flow: verify the password, record the
login + the per-day streak row, mint the same session payload, and set the same
httpOnly reep_session cookie.
"""

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import get_current_session
from ..models.user import LoginDay, User
from ..schemas.auth import LoginRequest, SessionUser
from ..security import (
    SESSION_COOKIE,
    SESSION_TTL_SECONDS,
    create_session_token,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])


def _payload_for(user: User) -> dict:
    payload = {
        "userId": user.id,
        "email": user.email,
        "name": user.name,
        "role": user.role.value,
    }
    if user.student is not None:
        payload["studentId"] = user.student.id
    if user.mentor is not None:
        payload["mentorId"] = user.mentor.id
    return payload


@router.post("/login", response_model=SessionUser)
def login(body: LoginRequest, response: Response, db: Session = Depends(get_db)) -> SessionUser:
    email = body.email.strip().lower()
    user = db.scalar(select(User).where(User.email == email))
    # One message for both cases — never reveal which of email/password was wrong.
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        )

    now = datetime.now(timezone.utc)
    user.last_login_at = now
    # Local calendar date, matching the Next.js streak bucketing.
    local = datetime.now()
    today = date(local.year, local.month, local.day)
    already = db.scalar(
        select(LoginDay).where(LoginDay.user_id == user.id, LoginDay.day == today)
    )
    if already is None:
        db.add(LoginDay(user_id=user.id, day=today))
    db.commit()

    payload = _payload_for(user)
    token = create_session_token(payload)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        secure=settings.is_prod,
        path="/",
        max_age=SESSION_TTL_SECONDS,
    )
    return SessionUser(**payload)


@router.get("/me", response_model=SessionUser)
def me(session: dict = Depends(get_current_session)) -> SessionUser:
    return SessionUser(**session)


@router.post("/logout")
def logout(response: Response) -> dict:
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}
