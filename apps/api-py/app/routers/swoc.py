"""SWOC — Strengths, Weaknesses, Opportunities, Challenges: the editor.

    GET    /admin/swoc                        every student with their entries
    POST   /admin/swoc/{student_id}           add an entry (kind, text, weight)
    PATCH  /admin/swoc/entries/{entry_id}     edit text / weight
    DELETE /admin/swoc/entries/{entry_id}     remove

The MODEL IS NOT NEW. `swoc_entries` (app/models/swoc.py) has carried the
board since the Prisma port — one row per observation, attributed to a
VIEWPOINT (placement cell, mentor, programme manager) and weighted 1-5 — and
the student already reads it: `GET /student/swoc`, and inside
`GET /student/overview` as `swoc`, drawn on the Mentor / TPO Log and now on
the landing. What was missing was a WRITER. This is it.

GATED BY A CAPABILITY, NOT A ROLE — `admin.swoc`. The placement office holds
it by baseline; a faculty member holds it only when an administrator grants it
in Governance. "From TPO and mentor inputs" means more than one hand writes
the board, and Governance is where the owner decides whose. PROGRAMME scope
like the other admin screens: the grant is the decision to let that person
write for every student.

THE VIEWPOINT IS DERIVED, NOT TYPED. A MENTOR's entry is a MENTOR entry; a
the Main Admin's is the PLACEMENT cell's. The board is deliberately
un-averaged — disagreement between viewpoints is itself the finding — and a
select box that lets a mentor file an opinion as the office's would erase the
one thing the source column exists to keep.

Every write goes through record_change with the before/after snapshot: a line
that tells a student what their weakness is must be traceable to who wrote it
and what it replaced.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..architecture_events import record_change
from ..db import get_db
from ..governance import require_capability
from ..identity import get_current_session
from ..models.cohort import Cohort
from ..models.swoc import SwocEntry, SwocKind, SwocSource
from ..models.user import Student, User

router = APIRouter(prefix="/admin/swoc", tags=["swoc"])

CAPABILITY = "admin.swoc"

#: One quadrant line is a sentence or two, not an essay: the card draws it in a tile.
MAX_SWOC_CHARS = 400

#: The board's order, the same the student's card draws.
KINDS: tuple[str, ...] = tuple(k.value for k in SwocKind)


def _source_for(session: dict) -> SwocSource:
    """A mentor speaks as MENTOR; the office (the Main Admin) as PLACEMENT."""
    return SwocSource.MENTOR if session.get("role") == "MENTOR" else SwocSource.PLACEMENT


# ------------------------------------------------------------- schemas --


def _clean_text(v: object) -> str:
    if not isinstance(v, str):
        raise ValueError("must be text")
    collapsed = " ".join(v.split())
    if not collapsed:
        raise ValueError("must not be blank")
    if len(collapsed) > MAX_SWOC_CHARS:
        raise ValueError(f"at most {MAX_SWOC_CHARS} characters")
    return collapsed


class SwocEntryOut(BaseModel):
    id: str
    kind: str
    source: str
    text: str
    weight: int
    #: Who wrote it — the author's name, or null if that account is gone.
    author: str | None
    recorded_at: datetime


class SwocEntryIn(BaseModel):
    kind: str
    text: str
    weight: int = Field(default=3, ge=1, le=5)

    @field_validator("kind", mode="before")
    @classmethod
    def _kind(cls, v: object) -> str:
        key = str(v or "").strip().upper()
        if key not in KINDS:
            raise ValueError("kind must be one of " + ", ".join(k.lower() for k in KINDS))
        return key

    @field_validator("text", mode="before")
    @classmethod
    def _text(cls, v: object) -> str:
        return _clean_text(v)


class SwocEntryPatch(BaseModel):
    text: str | None = None
    weight: int | None = Field(default=None, ge=1, le=5)

    @field_validator("text", mode="before")
    @classmethod
    def _text(cls, v: object) -> str | None:
        return None if v is None else _clean_text(v)


class SwocStudentRow(BaseModel):
    """One line of the editor's list: who, plus everything written about them."""

    student_id: str
    name: str
    usn: str | None
    batch: str | None
    entries: list[SwocEntryOut]


# ------------------------------------------------------------- helpers --


def _out(e: SwocEntry, author: str | None) -> SwocEntryOut:
    return SwocEntryOut(
        id=e.id, kind=e.kind.value, source=e.source.value, text=e.text, weight=e.weight,
        author=author, recorded_at=e.recorded_at,
    )


def _snapshot(e: SwocEntry) -> dict:
    return {"student_id": e.student_id, "kind": e.kind.value, "source": e.source.value, "text": e.text, "weight": e.weight}


def _audit(db: Session, session: dict, request: Request, e: SwocEntry, action: str,
           before: dict | None, after: dict | None) -> None:
    record_change(
        db, session=session, request=request, tenant_id=None,
        entity_type="swoc_entry", entity_id=e.id, action=action,
        before=before, after=after,
        event_type=f"swoc.{action.lower()}",
        payload={"student_id": e.student_id, "kind": e.kind.value, "source": e.source.value},
    )


def _entry_or_404(db: Session, entry_id: str) -> SwocEntry:
    e = db.get(SwocEntry, entry_id)
    if e is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such entry.")
    return e


# ----------------------------------------------------------- the list --


@router.get("", response_model=list[SwocStudentRow])
def list_swoc(
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[SwocStudentRow]:
    require_capability(db, session, CAPABILITY)
    students = db.execute(
        select(Student.id, User.name, Student.usn, Cohort.name, Cohort.batch_label)
        .join(User, User.id == Student.user_id)
        .outerjoin(Cohort, Cohort.id == Student.cohort_id)
        .order_by(User.name, Student.usn)
    ).all()
    entries = db.execute(
        select(SwocEntry, User.name)
        .outerjoin(User, User.id == SwocEntry.author_user_id)
        .order_by(SwocEntry.student_id, SwocEntry.kind, SwocEntry.weight.desc(), SwocEntry.recorded_at)
    ).all()
    by_student: dict[str, list[SwocEntryOut]] = {}
    for e, author in entries:
        by_student.setdefault(e.student_id, []).append(_out(e, author))
    return [
        SwocStudentRow(
            student_id=sid, name=name, usn=usn,
            batch=f"{cohort_name} · {batch_label}" if cohort_name else None,
            entries=by_student.get(sid, []),
        )
        for sid, name, usn, cohort_name, batch_label in students
    ]


# --------------------------------------------------------- the writes --


@router.post("/{student_id}", response_model=SwocEntryOut, status_code=status.HTTP_201_CREATED)
def add_entry(
    student_id: str,
    body: SwocEntryIn,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> SwocEntryOut:
    require_capability(db, session, CAPABILITY)
    if db.get(Student, student_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such student.")
    e = SwocEntry(
        student_id=student_id,
        source=_source_for(session),
        kind=SwocKind(body.kind),
        text=body.text,
        weight=body.weight,
        author_user_id=session.get("userId"),
    )
    db.add(e)
    db.flush()
    _audit(db, session, request, e, "CREATE", None, _snapshot(e))
    db.commit()
    db.refresh(e)
    return _out(e, session.get("name"))


@router.patch("/entries/{entry_id}", response_model=SwocEntryOut)
def edit_entry(
    entry_id: str,
    body: SwocEntryPatch,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> SwocEntryOut:
    require_capability(db, session, CAPABILITY)
    e = _entry_or_404(db, entry_id)
    before = _snapshot(e)
    if body.text is not None:
        e.text = body.text
    if body.weight is not None:
        e.weight = body.weight
    db.flush()
    _audit(db, session, request, e, "UPDATE", before, _snapshot(e))
    db.commit()
    db.refresh(e)
    author = db.scalar(select(User.name).where(User.id == e.author_user_id)) if e.author_user_id else None
    return _out(e, author)


@router.delete("/entries/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_entry(
    entry_id: str,
    request: Request,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> Response:
    require_capability(db, session, CAPABILITY)
    e = _entry_or_404(db, entry_id)
    _audit(db, session, request, e, "DELETE", _snapshot(e), None)
    db.delete(e)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
