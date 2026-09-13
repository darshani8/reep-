"""Leave requests — submit and the two-approver decision flow.

Any signed-in user submits. Staff (MENTOR/ADMIN) approve, and two
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
programme); the Main Admin sees all. The group test itself lives in mentor.py and
is imported rather than re-implemented — two copies of a scope rule is how one of
them quietly stops matching the other.

One consequence to know before you "fix" it: a request from a user who is not a
student (a mentor's own leave) has no group to belong to, so it is decidable by
the Main Admin only. That is the deliberate reading of "no group => nobody" —
the alternative, letting group-less mentors keep the staff queue, hands the queue
straight back to the account this rule is here to keep out.

SINCE B2.1 THE APPROVER'S THREE ENDPOINTS ALSO REQUIRE `mentor.leave_approve`
(`_require_leave_approver` below). The SUBMIT path does not, and must not: every
signed-in account applies for its own leave, faculty with no mentees included.
"""

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..governance import require_capability
from ..identity import get_current_session
from ..policies import scope_filter
from ..scope_views import scope_header
from ..models.leave import LeaveDecision, LeaveRequest, LeaveStatus
from ..models.user import Student, User
# _assert_can_access_student is private to mentor.py on purpose, and importing it
# anyway is the lesser evil: it is the ONE implementation of "a MENTOR only for a
# student in their own group", and a second copy here would be the copy that
# stops tracking the first.
from .mentor import _assert_can_access_student, require_mentor

router = APIRouter(prefix="/leaves", tags=["leaves"])


class AltRow(BaseModel):
    """One line of the form's Alternate Arrangements table."""

    date: str = ""
    staff_name: str = ""
    cls: str = ""
    time: str = ""
    remarks: str = ""


class LeaveIn(BaseModel):
    from_date: date
    to_date: date
    # The form's "Purpose" cell. Still `reason` in the schema — renaming a
    # column that four call sites and a scope-rule docstring refer to, to match
    # a label, would be churn for no gain.
    reason: str = Field(min_length=1, max_length=2000)
    # Printed options only: the form lists these five and strikes off the rest,
    # so this is a choice among them and not an open leave-type vocabulary.
    leave_kind: str | None = Field(default=None, pattern="^(CASUAL|PERMISSION|OOD|RH|LOP)$")
    credit: str | None = Field(default=None, max_length=200)
    alt_name: str | None = Field(default=None, max_length=200)
    alt_rows: list[AltRow] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def dates_run_forwards(self) -> "LeaveIn":
        """A leave that ends before it starts is not a leave, and it was
        reaching the official form.

        The two dates were declared independently and nothing related them, so
        20 Dec -> 10 Dec was accepted, stored with a span of MINUS TEN days,
        listed in the approver's queue with a live "Mark Sanctioned" button, and
        rendered onto the college's own PDF. Found in the browser, not by a test.

        The check lives HERE, on the schema, deliberately: the owner's standing
        instruction is that the leave form and its buttons do not change, so the
        one safe place to refuse it is before the request is ever built. A
        single day is legal — `from == to` is how PERMISSION and a one-day
        CASUAL leave are both written on the paper form.
        """
        if self.to_date < self.from_date:
            raise ValueError(
                "The last day of leave cannot fall before the first day. "
                f"You asked for {self.from_date.isoformat()} to {self.to_date.isoformat()}."
            )
        return self


class LeaveOut(BaseModel):
    id: str
    from_date: date
    to_date: date
    reason: str
    status: str
    leave_kind: str | None
    credit: str | None
    alt_name: str | None
    alt_rows: list[AltRow]

    # The form prints the applicant's institutional identity beside their name,
    # so the document can be rendered from one response rather than the client
    # stitching it together from /auth/me.
    requester_name: str
    requester_designation: str | None
    requester_department: str | None

    # The two signature blocks. A signature is a NAME AND A TIME, and neither
    # half is printed without the other: an approval with no timestamp, or a
    # timestamp with no approver, is exactly the ambiguity a signed form exists
    # to remove.
    signed_at: datetime | None
    director_name: str | None
    director_decided_at: datetime | None
    director_note: str | None


def _leave_out(lr: LeaveRequest, db: Session) -> LeaveOut:
    requester = db.get(User, lr.requester_user_id)
    # The PROGRAM DIRECTOR block prints only for a request that reached a final
    # decision. A first-of-two approval is a step, not a sanction, and printing a
    # name against it would show the form as signed off when it is not.
    director = None
    if lr.status in (LeaveStatus.APPROVED, LeaveStatus.REJECTED):
        approver_id = lr.second_approver_user_id or lr.first_approver_user_id
        director = db.get(User, approver_id) if approver_id else None
    return LeaveOut(
        id=lr.id,
        from_date=lr.from_date,
        to_date=lr.to_date,
        reason=lr.reason,
        status=lr.status.value,
        leave_kind=lr.leave_kind,
        credit=lr.credit,
        alt_name=lr.alt_name,
        alt_rows=[AltRow(**r) for r in (lr.alt_rows or [])],
        requester_name=requester.name if requester else "",
        requester_designation=requester.designation if requester else None,
        requester_department=requester.department if requester else None,
        signed_at=lr.signed_at,
        director_name=director.name if director else None,
        director_decided_at=lr.second_decided_at or lr.first_decided_at,
        director_note=lr.second_note or lr.first_note,
    )


def _require_leave_approver(db: Session, session: dict) -> None:
    """The approver's gate: staff, holding `mentor.leave_approve`.

    COMPOSED WITH `require_mentor`, NOT IN PLACE OF IT. The two answer different
    questions and both have to pass: `require_mentor` says this is a member of
    staff, the capability says this member of staff is one of the people who
    sign leave. Dropping the role gate would make a grant the only fence on an
    endpoint that reads free-text medical reasons, and rule 2's group check
    (`_assert_can_decide`) still runs after both.

    B2.3 MADE THIS DERIVED, WHICH IS WHY IT CHANGES ANYTHING AT ALL.
    `mentor.leave_approve` is not in `ROLE_BASELINE["MENTOR"]`; it is one of the
    four functions a faculty account holds by currently mentoring somebody
    (app/mentor_functions.py). So a faculty member with no mentees is refused
    here with a 403 that says why, where before they got a 200 and an empty
    queue -- the same outcome, told honestly. The Main Admin holds it by
    baseline, because it is the second of the two signatures and removing it
    would break sanctioning outright.

    IT IS NOT ON THE SUBMIT PATH, AND THAT IS THE POINT. `POST /api/leaves` and
    `GET /api/leaves/mine` are open to every signed-in account, including a
    faculty member with no mentees, because applying for your own leave is not
    an approver's act. Putting this on the form is how a new lecturer discovers
    they cannot ask for a day off.

    CALLED BEFORE ANY id IS LOOKED UP, on the decision path especially. A
    refusal that depended on whether the leave exists would turn this endpoint
    into the membership oracle `_assert_can_decide` flattens its 404s to
    prevent: the answer here is the same for every id, known or invented.
    """
    require_mentor(session)
    require_capability(db, session, "mentor.leave_approve")


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
        leave_kind=body.leave_kind,
        credit=body.credit,
        alt_name=body.alt_name,
        alt_rows=[r.model_dump() for r in body.alt_rows],
        status=LeaveStatus.SUBMITTED,
        # Submitting IS signing on this form — the applicant's signature block is
        # what sends it — so the stamp is taken here rather than left for a
        # second call that could never arrive.
        signed_at=datetime.now(timezone.utc),
    )
    db.add(lr)
    db.commit()
    db.refresh(lr)
    return _leave_out(lr, db)


@router.get("/mine", response_model=list[LeaveOut])
def my_leaves(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[LeaveOut]:
    rows = db.scalars(
        select(LeaveRequest)
        .where(LeaveRequest.requester_user_id == session["userId"])
        .order_by(LeaveRequest.created_at.desc())
    ).all()
    return [_leave_out(lr, db) for lr in rows]


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
    if session["role"] == "ADMIN":
        return
    student = db.scalar(select(Student).where(Student.user_id == lr.requester_user_id))
    if student is None:
        # Not a student's request (staff leave). A MENTOR has no group claim over
        # it, so it belongs to the Main Admin — see the module docstring.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Leave request not found."
        )
    try:
        _assert_can_access_student(session, student.id, db)
    except HTTPException:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Leave request not found."
        ) from None


LEAVE_CAPABILITY = "mentor.leave_approve"


def _narrow_to_scope(query, db: Session, session: dict, response: Response):
    """Narrow an approver's queue to what this session may see. One rule, two
    halves, and they are composed rather than one replacing the other.

    A MENTOR IS FENCED BY THEIR GROUP AND NOTHING ELSE, exactly as before. That
    fence is rule 2's and it is STRICTER than any scope could be — it narrows to
    this mentor's own students, not to a department's — which is the same
    argument `governance.require_capability` makes for not scoping a capability
    held as a mentor FUNCTION. It matters here mechanically as well as in
    principle: `mentor.leave_approve` is a derived function for a faculty member
    with mentees (app/mentor_functions.py) and therefore has no grant row, so
    `scope_filter` reports `nothing` for them. Applying the reach to a MENTOR
    would empty every faculty approver's queue on the deploy that shipped it.
    Read that sentence before adding a `reach.nothing` early return here.

    EVERYONE ELSE IS FENCED BY THE REACH (B1.4). Today that is the Main Admin,
    whose baseline resolves to `everything`, so nothing changes for the office
    account; it becomes load-bearing the moment `mentor.leave_approve` is
    granted to a non-mentoring account with a scope, which is what B10.7 asks
    for and what Governance can already express.

    Requests from staff — a faculty member's own leave — belong to no student
    and so hang under no reach. They stay the Main Admin's, which is what the
    module docstring already says about "no group => nobody", now said once for
    both halves: `LeaveRequest.requester_user_id` is matched against the reach's
    STUDENT users only.
    """
    if session["role"] == "MENTOR":
        mentor_id = session.get("mentorId")
        if not mentor_id:
            return None  # no Mentor group => nobody (never the whole programme)
        # Narrowed in SQL, not filtered in Python afterwards: an out-of-group
        # `reason` should never be read out of the database in the first place.
        return query.where(
            LeaveRequest.requester_user_id.in_(
                select(Student.user_id).where(Student.mentor_id == mentor_id)
            )
        )
    reach = scope_filter(db, session, LEAVE_CAPABILITY)
    scope_header(response, reach)
    if reach.everything:
        return query  # the Main Admin: the whole programme, staff leave included
    if reach.nothing:
        return None
    return query.where(
        LeaveRequest.requester_user_id.in_(
            select(Student.user_id).where(Student.id.in_(reach.student_ids()))
        )
    )


@router.get("/pending", response_model=list[LeaveOut])
def pending_leaves(
    response: Response,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[LeaveOut]:
    _require_leave_approver(db, session)
    uid = session["userId"]
    query = (
        select(LeaveRequest)
        .where(
            LeaveRequest.status.in_([LeaveStatus.SUBMITTED, LeaveStatus.FIRST_APPROVED]),
            LeaveRequest.requester_user_id != uid,
        )
        .order_by(LeaveRequest.created_at)
    )
    query = _narrow_to_scope(query, db, session, response)
    if query is None:
        return []

    rows = db.scalars(query).all()
    # Not decidable by me if I already gave the first signature.
    return [
        _leave_out(lr, db)
        for lr in rows
        if not (lr.status == LeaveStatus.FIRST_APPROVED and lr.first_approver_user_id == uid)
    ]


@router.get("/history", response_model=list[LeaveOut])
def decided_leaves(
    response: Response,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[LeaveOut]:
    """Requests that reached a final decision — the Approved and Rejected tabs of
    the approvals screen. SAME SCOPE AS /pending, through the same
    `_narrow_to_scope` and narrowed in SQL: a MENTOR sees only their own group's,
    a MENTOR with no group sees nobody, a scoped approver sees their reach, the
    Main Admin sees all. One function rather than the two copies that stood here
    — the copies were identical when they were written, which is how they stay
    identical only until one of them is edited. Own requests are excluded as they
    are from /pending — the applicant reads those under /mine, and the approvals
    screen is the other chair."""
    _require_leave_approver(db, session)
    uid = session["userId"]
    query = (
        select(LeaveRequest)
        .where(
            LeaveRequest.status.in_([LeaveStatus.APPROVED, LeaveStatus.REJECTED]),
            LeaveRequest.requester_user_id != uid,
        )
        .order_by(
            func.coalesce(LeaveRequest.second_decided_at, LeaveRequest.first_decided_at).desc(),
            LeaveRequest.created_at.desc(),
        )
        .limit(200)
    )
    query = _narrow_to_scope(query, db, session, response)
    if query is None:
        return []
    return [_leave_out(lr, db) for lr in db.scalars(query).all()]


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
    # Role AND capability first, before any DB read: neither refusal may depend
    # on whether this leave id exists, or the endpoint tells a caller which ids
    # are real by which error comes back. B2.1 added the capability HERE rather
    # than inside `_assert_can_decide`, which runs after the row is loaded — and
    # which `leave_paper.py` imports for the PDF, a read this gate has no
    # business refusing.
    _require_leave_approver(db, session)
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
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
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
    return _leave_out(lr, db)
