"""Mentor area — staff (MENTOR / DIRECTOR / ADMIN) views of their mentees.

Scope rule (mirrors mentorScope()/menteeWhere() in the Next.js app, and the
AGENTS.md guidance): a MENTOR sees only students in their Mentor group;
DIRECTOR/ADMIN see all. A MENTOR with NO Mentor group (no mentorId in the
session) sees NOBODY — never the whole programme.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_session
from ..models.user import Student, User

router = APIRouter(prefix="/mentor", tags=["mentor"])

_STAFF = {"MENTOR", "DIRECTOR", "ADMIN"}


def require_mentor(session: dict) -> dict:
    if session.get("role") not in _STAFF:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Staff access required.")
    return session


class MenteeOut(BaseModel):
    student_id: str
    name: str
    usn: str | None
    current_stage: str
    current_semester: int


@router.get("/mentees", response_model=list[MenteeOut])
def mentees(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[MenteeOut]:
    require_mentor(session)
    query = select(Student, User.name).join(User, Student.user_id == User.id)

    if session["role"] == "MENTOR":
        mentor_id = session.get("mentorId")
        if not mentor_id:
            return []  # no Mentor group => nobody (never the whole programme)
        query = query.where(Student.mentor_id == mentor_id)
    # DIRECTOR / ADMIN: no narrowing — the whole programme.

    rows = db.execute(query.order_by(User.name)).all()
    return [
        MenteeOut(
            student_id=student.id,
            name=name,
            usn=student.usn,
            current_stage=student.current_stage.value,
            current_semester=student.current_semester,
        )
        for student, name in rows
    ]
