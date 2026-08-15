"""Leave requests — submit and the two-approver decision flow.

Any signed-in user submits. Staff (MENTOR/DIRECTOR/ADMIN) approve, and two
DISTINCT approvers are required: the first moves SUBMITTED -> FIRST_APPROVED, a
different second moves FIRST_APPROVED -> APPROVED. A rejection at either stage
ends it as REJECTED. You cannot approve your own request or sign twice.
"""

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_session
from ..models.leave import LeaveDecision, LeaveRequest, LeaveStatus
from .mentor import require_mentor

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


@router.get("/pending", response_model=list[LeaveOut])
def pending_leaves(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[LeaveOut]:
    require_mentor(session)
    uid = session["userId"]
    rows = db.scalars(
        select(LeaveRequest)
        .where(
            LeaveRequest.status.in_([LeaveStatus.SUBMITTED, LeaveStatus.FIRST_APPROVED]),
            LeaveRequest.requester_user_id != uid,
        )
        .order_by(LeaveRequest.created_at)
    ).all()
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
    require_mentor(session)
    lr = db.get(LeaveRequest, leave_id)
    if lr is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Leave request not found.")
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
