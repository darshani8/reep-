"""Leave requests — submit and the two-approver decision flow.

Any signed-in user submits. Staff (MENTOR/DIRECTOR/ADMIN) approve, and two
DISTINCT approvers are required: the first moves SUBMITTED -> FIRST_APPROVED, a
different second moves FIRST_APPROVED -> APPROVED. A rejection at either stage
ends it as REJECTED. You cannot approve your own request or sign twice.

Staff scope here is the SAME rule as the mentor area (AGENTS.md rule 2), and it
is not decoration: `reason` is free text and is routinely medical or personal.
Gating on `require_mentor` alone — which is what this file did until the 2026-08
audit — meant a MENTOR with no Mentor group, the account the rule exists to
exclude, listed every pending request programme-wide with the reason attached and
could approve or reject any of them. So: a MENTOR sees only requests from
students in their own group; a MENTOR with NO group sees NOBODY (never the whole
programme); DIRECTOR/ADMIN see all. The group test itself lives in mentor.py and
is imported rather than re-implemented — two copies of a scope rule is how one of
them quietly stops matching the other.

One consequence to know before you "fix" it: a request from a user who is not a
student (a mentor's own leave) has no group to belong to, so it is decidable by
DIRECTOR/ADMIN only. That is the deliberate reading of "no group => nobody" —
the alternative, letting group-less mentors keep the staff queue, hands the queue
straight back to the account this rule is here to keep out.
"""

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..identity import get_current_session
from ..models.leave import LeaveDecision, LeaveRequest, LeaveStatus
from ..models.user import Student
# _assert_can_access_student is private to mentor.py on purpose, and importing it
# anyway is the lesser evil: it is the ONE implementation of "a MENTOR only for a
# student in their own group", and a second copy here would be the copy that
# stops tracking the first.
from .mentor import _assert_can_access_student, require_mentor

router = APIRouter(prefix="/leaves", tags=["leaves"])


class LeaveIn(BaseModel):
    from_date: date
    to_date: date
    reason: str = Field(min_length=1, max_length=2000)


class LeaveOut(BaseModel):
    id: str
    from_date: date
    to_date: date
    reason: str
    status: str


def _leave_out(lr: LeaveRequest) -> LeaveOut:
    return LeaveOut(
        id=lr.id,
        from_date=lr.from_date,
        to_date=lr.to_date,
        reason=lr.reason,
        status=lr.status.value,
    )


@router.post("", response_model=LeaveOut, status_code=status.HTTP_201_CREATED)
def submit_leave(
    body: LeaveIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> LeaveOut:
    lr = LeaveRequest(
        requester_user_id=session["userId"],
        from_date=body.from_date,
        to_date=body.to_date,
        reason=body.reason,
        status=LeaveStatus.SUBMITTED,
    )
    db.add(lr)
    db.commit()
    db.refresh(lr)
    return _leave_out(lr)


@router.get("/mine", response_model=list[LeaveOut])
def my_leaves(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[LeaveOut]:
    rows = db.scalars(
        select(LeaveRequest)
        .where(LeaveRequest.requester_user_id == session["userId"])
        .order_by(LeaveRequest.created_at.desc())
    ).all()
    return [_leave_out(lr) for lr in rows]


def _assert_can_decide(session: dict, lr: LeaveRequest, db: Session) -> None:
    """Staff only, and only for a requester inside the caller's own scope.

    Resolves the requester back to their Student row and hands the group test to
    mentor._assert_can_access_student. Doing it here rather than inline keeps the
    decision endpoint honest about the same rule the list obeys — before this,
    /pending could be narrowed and the decision path would still have taken any
    leave id anyone happened to learn.

    Every refusal is flattened to the SAME 404 the missing-leave path returns, so
    a mentor cannot separate "that id exists but is not yours" from "no such
    leave". Left distinguishable, the endpoint is a membership oracle over the
    whole programme: guess ids, read the error, learn who has leave pending.
    """
    require_mentor(session)
    if session["role"] in ("DIRECTOR", "ADMIN"):
        return
    student = db.scalar(select(Student).where(Student.user_id == lr.requester_user_id))
    if student is None:
        # Not a student's request (staff leave). A MENTOR has no group claim over
        # it, so it belongs to DIRECTOR/ADMIN — see the module docstring.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Leave request not found."
        )
    try:
        _assert_can_access_student(session, student.id, db)
    except HTTPException:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Leave request not found."
        ) from None


@router.get("/pending", response_model=list[LeaveOut])
def pending_leaves(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[LeaveOut]:
    require_mentor(session)
    uid = session["userId"]
    query = (
        select(LeaveRequest)
        .where(
            LeaveRequest.status.in_([LeaveStatus.SUBMITTED, LeaveStatus.FIRST_APPROVED]),
            LeaveRequest.requester_user_id != uid,
        )
        .order_by(LeaveRequest.created_at)
    )
    if session["role"] == "MENTOR":
        mentor_id = session.get("mentorId")
        if not mentor_id:
            return []  # no Mentor group => nobody (never the whole programme)
        # Narrowed in SQL, not filtered in Python afterwards: an out-of-group
        # `reason` should never be read out of the database in the first place.
        query = query.where(
            LeaveRequest.requester_user_id.in_(
                select(Student.user_id).where(Student.mentor_id == mentor_id)
            )
        )
    # DIRECTOR / ADMIN: no narrowing — the whole programme, staff leave included.

    rows = db.scalars(query).all()
    # Not decidable by me if I already gave the first signature.
    return [
        _leave_out(lr)
        for lr in rows
        if not (lr.status == LeaveStatus.FIRST_APPROVED and lr.first_approver_user_id == uid)
    ]


class LeaveDecisionIn(BaseModel):
    decision: str  # "APPROVE" | "REJECT"
    note: str | None = None


@router.post("/{leave_id}/decision", response_model=LeaveOut)
def decide_leave(
    leave_id: str,
    body: LeaveDecisionIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> LeaveOut:
    # Role first, before any DB read: a non-staff caller must not be able to tell
    # a real leave id from an invented one by which error comes back.
    require_mentor(session)
    lr = db.get(LeaveRequest, leave_id)
    if lr is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Leave request not found.")
    # Then scope. Staff was never enough on its own here — a signature on a
    # student outside your group is a decision you were never entitled to make.
    _assert_can_decide(session, lr, db)
    uid = session["userId"]
    if lr.requester_user_id == uid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot approve your own leave."
        )
    decision = body.decision.upper()
    if decision not in ("APPROVE", "REJECT"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="decision must be APPROVE or REJECT.",
        )
    now = datetime.now(timezone.utc)

    if lr.status == LeaveStatus.SUBMITTED:
        lr.first_approver_user_id = uid
        lr.first_decided_at = now
        lr.first_note = body.note
        if decision == "APPROVE":
            lr.first_decision = LeaveDecision.APPROVED
            lr.status = LeaveStatus.FIRST_APPROVED
        else:
            lr.first_decision = LeaveDecision.REJECTED
            lr.status = LeaveStatus.REJECTED
    elif lr.status == LeaveStatus.FIRST_APPROVED:
        if lr.first_approver_user_id == uid:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="You gave the first signature; a different approver must give the second.",
            )
        lr.second_approver_user_id = uid
        lr.second_decided_at = now
        lr.second_note = body.note
        if decision == "APPROVE":
            lr.second_decision = LeaveDecision.APPROVED
            lr.status = LeaveStatus.APPROVED
        else:
            lr.second_decision = LeaveDecision.REJECTED
            lr.status = LeaveStatus.REJECTED
    else:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Leave is {lr.status.value}; no decision possible.",
        )

    db.commit()
    db.refresh(lr)
    return _leave_out(lr)
