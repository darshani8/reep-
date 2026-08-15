"""Mentor area — staff (MENTOR / DIRECTOR / ADMIN) views of their mentees.

Scope rule (mirrors mentorScope()/menteeWhere() in the Next.js app, and the
AGENTS.md guidance): a MENTOR sees only students in their Mentor group;
DIRECTOR/ADMIN see all. A MENTOR with NO Mentor group (no mentorId in the
session) sees NOBODY — never the whole programme.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_session
from ..models.mentor_note import MentorAction, MentorNote
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


def _assert_can_access_student(session: dict, student_id: str, db: Session) -> None:
    """Staff only, and a MENTOR only for a student in their own group."""
    require_mentor(session)
    if session["role"] in ("DIRECTOR", "ADMIN"):
        if db.get(Student, student_id) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")
        return
    mentor_id = session.get("mentorId")
    student = db.get(Student, student_id)
    if not mentor_id or student is None or student.mentor_id != mentor_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Student not in your mentor group."
        )


class NoteOut(BaseModel):
    id: str
    note_text: str
    linked_action: str
    meeting_at: datetime
    created_at: datetime


class NoteIn(BaseModel):
    note_text: str = Field(min_length=1, max_length=4000)
    linked_action: str = "NONE"
    meeting_at: datetime | None = None


def _note_out(note: MentorNote) -> NoteOut:
    return NoteOut(
        id=note.id,
        note_text=note.note_text,
        linked_action=note.linked_action.value,
        meeting_at=note.meeting_at,
        created_at=note.created_at,
    )


@router.get("/students/{student_id}/notes", response_model=list[NoteOut])
def list_notes(
    student_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[NoteOut]:
    _assert_can_access_student(session, student_id, db)
    rows = db.scalars(
        select(MentorNote)
        .where(MentorNote.student_id == student_id)
        .order_by(MentorNote.meeting_at.desc())
    ).all()
    return [_note_out(n) for n in rows]


@router.post(
    "/students/{student_id}/notes", response_model=NoteOut, status_code=status.HTTP_201_CREATED
)
def add_note(
    student_id: str,
    body: NoteIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> NoteOut:
    _assert_can_access_student(session, student_id, db)
    mentor_id = session.get("mentorId")
    if not mentor_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only a mentor (with a Mentor profile) can author notes.",
        )
    try:
        action = MentorAction(body.linked_action)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid linked_action."
        )
    note = MentorNote(
        mentor_id=mentor_id,
        student_id=student_id,
        note_text=body.note_text,
        linked_action=action,
        meeting_at=body.meeting_at or datetime.now(timezone.utc),
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    return _note_out(note)
