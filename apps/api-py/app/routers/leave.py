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
student (a mentor's own leave) has no group to belong to, so no MENTOR has a
group claim over it. The alternative — letting group-less mentors keep the staff
queue — hands the queue straight back to the account this rule is here to keep
out, and is still refused.

B10.1 ADDED A THIRD DOOR BESIDE THOSE TWO, BECAUSE THE PAIR OF THEM DEADLOCKED.
`decide_leave` requires two DISTINCT signatures and `app.grant_access` permits
exactly ONE ADMIN account, so "decidable by the Main Admin only" meant a staff
leave request reached FIRST_APPROVED and could never reach APPROVED — on every
real deployment, silently, with a live "Mark Sanctioned" button. The same
deadlock caught any student with no `mentor_id`. The third door is a SCOPED
GRANT of `mentor.leave_approve`, made in Governance at `ScopeLevel.DEPARTMENT`
or `COLLEGE`, with a reason and an audit row; `_assert_can_decide` documents
why it is asked of `granted_reaches` and never of `require_capability`, and
`app/models/leave.py` documents why the vocabulary has no "HOD" in it.

A DEPLOYMENT STILL NEEDS THE OFFICE TO MAKE ONE SUCH GRANT before a second
signature exists for staff leave. That is not an oversight to be designed
around: the only alternative this product's shape permits is a rule that admits
faculty accounts by role rather than by decision, and the rule at the top of
this docstring is the record of why that was removed.

SINCE B2.1 THE APPROVER'S THREE ENDPOINTS ALSO REQUIRE `mentor.leave_approve`
(`_require_leave_approver` below). The SUBMIT path does not, and must not: every
signed-in account applies for its own leave, faculty with no mentees included.
Neither does `POST /{id}/cancel`, for the same reason: withdrawing your own
request is not an approver's act.

WHAT THE APPLICANT SEES AND WHAT A THIRD PARTY SEES ARE DIFFERENT PROJECTIONS
(B10.7). `_leave_out` carries `reason` and is for the applicant and the people
who sign; `_leave_brief` carries dates, the printed option, the state and the
one alternate row addressed to the caller, and is for anybody else with a reason
to open the record.
"""

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..governance import (
    ancestry_of_student,
    ancestry_of_user,
    granted_reaches,
    reaches_target,
    require_capability,
)
from ..identity import get_current_session
from ..leave_mail import notify_transition
from ..leave_policy import submit_refusal
from ..policies import scope_filter
from ..scope_views import scope_header
from ..models.leave import (
    SIGNED_AS_DELEGATE,
    SIGNED_AS_MAIN_ADMIN,
    SIGNED_AS_MENTOR,
    LeaveDecision,
    LeaveRequest,
    LeaveStatus,
)
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

    # WHICH FUNCTION EACH SIGNATURE WAS GIVEN IN (B10.1), added at the END of
    # the model so every existing field keeps its place in the payload. NULL on
    # every row decided before these columns existed, and on every step nobody
    # has signed yet; the console and `app/leave_paper.py` must render that as
    # nothing at all rather than guessing a function from who the signer is
    # today. See `app/models/leave.py` for why there is no "HOD" in this set.
    first_signed_as: str | None = None
    second_signed_as: str | None = None


#: The reduced projection's field set, pinned here and asserted in
#: `tests/test_leave_chain.py`. A field added to `LeaveBrief` without a line in
#: this tuple fails that test, which is the only thing standing between "the
#: alternate sees the dates" and "the alternate sees the reason".
BRIEF_FIELDS: tuple[str, ...] = (
    "id",
    "from_date",
    "to_date",
    "leave_kind",
    "status",
    "requester_name",
    "alt_row",
)


class LeaveBrief(BaseModel):
    """WHAT SOMEBODY WHO IS NOT THE APPLICANT AND NOT AN APPROVER MAY SEE (B10.7).

    `LeaveOut` carries `reason` — the form's "Purpose" cell, which is free text
    and is routinely medical — to whoever is handed a row. Until now that was
    safe BY ACCIDENT OF WHO CALLS IT: `/mine` answers the applicant and the two
    queues are behind `mentor.leave_approve` plus rule 2. It is not a property
    of the projection, and B10.6's alternate is a THIRD kind of reader — a
    colleague who is neither the applicant nor an approver, given a reason to
    open the record because their name is in the Alternate Arrangements table.
    Handing them `_leave_out` would hand them a diagnosis.

    So the shape is the fence, not the call site: this model CANNOT carry a
    reason, a credit line, an approver's note or an attachment, because it has
    no field for one. Dates, the printed option, the state, who is asking them
    to cover, and the one alternate row addressed to them — which is everything
    needed to answer "can you take my Tuesday class" and nothing else.

    Split BEFORE the new readers land rather than after, deliberately: a
    reduced projection introduced alongside its first caller is a reduced
    projection that gets skipped the second time somebody is in a hurry.
    """

    id: str
    from_date: date
    to_date: date
    leave_kind: str | None
    status: str
    #: Who is asking. A name and nothing else — no designation, no department:
    #: the alternate is a colleague who already knows them.
    requester_name: str
    #: The one row of the Alternate Arrangements table addressed to this caller,
    #: not the whole table. The other rows name other colleagues' classes.
    alt_row: AltRow | None = None


def _requester_name(lr: LeaveRequest, db: Session) -> str:
    requester = db.get(User, lr.requester_user_id)
    return requester.name if requester else ""


def _leave_brief(lr: LeaveRequest, db: Session, *, alt_row: AltRow | None = None) -> LeaveBrief:
    """The reduced projection. Takes the caller's alternate row rather than
    finding it, because "which row is addressed to you" is B10.6's question and
    this module has no business answering it twice."""
    return LeaveBrief(
        id=lr.id,
        from_date=lr.from_date,
        to_date=lr.to_date,
        leave_kind=lr.leave_kind,
        status=lr.status.value,
        requester_name=_requester_name(lr, db),
        alt_row=alt_row,
    )


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
        first_signed_as=lr.first_signed_as,
        second_signed_as=lr.second_signed_as,
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
    """Apply for leave. THE REQUEST AND THE RESPONSE ARE THE SAME SHAPE THEY
    HAVE ALWAYS BEEN — B10.2 adds two REFUSALS, not a field.

    The owner's standing instruction is that the leave form and its buttons do
    not change, and `dates_run_forwards` on `LeaveIn` already established what
    that leaves room for: a request that must not exist can be refused before it
    is built, because a refusal needs no control on the form. These two cannot
    live on the schema — they read the database and the session user — so they
    are the first thing the endpoint does, before a row is constructed.

    BOTH ARE SILENT ON A DEPLOYMENT THAT HAS RECORDED NO ALLOWANCE for this
    applicant and this kind of leave. `app/leave_policy.py` says why at length;
    the short version is that a table nobody has filled in must not change what
    the form accepts, and `tests/test_leave_dates.py` submits a deliberately
    overlapping pair to hold that down.
    """
    refusal = submit_refusal(
        db,
        user_id=session["userId"],
        from_date=body.from_date,
        to_date=body.to_date,
        leave_kind=body.leave_kind,
    )
    if refusal:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=refusal)
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
    # B10.5, AND IT IS OFF UNLESS `LEAVE_MAIL_ENABLED` IS SET. After the commit,
    # never before: `deliver_once` commits its own MailLog, so calling it first
    # would commit a half-written request, and a mail about a request that has
    # not landed is worse than a late one. It never raises and it returns None
    # when the feature is off, so this line cannot change what this endpoint
    # answers — which is the whole point, on an endpoint that must not change.
    notify_transition(db, lr)
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


#: The two states an applicant may still withdraw from (B10.4). REJECTED and
#: APPROVED are both TERMINAL and for the same reason: somebody signed them.
#: Cancelling a rejection would let an applicant rewrite a decision that was
#: made about them, and cancelling a sanction would take back a day the office
#: has already granted — on a paper form that has been printed and filed.
CANCELLABLE = (LeaveStatus.SUBMITTED, LeaveStatus.FIRST_APPROVED)


@router.post("/{leave_id}/cancel", response_model=LeaveOut)
def cancel_leave(
    leave_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> LeaveOut:
    """Withdraw your own request (B10.4).

    THE APPLICANT'S OWN ENDPOINT, LIKE `/mine`, AND DELIBERATELY NOT AN
    APPROVER'S. `_require_leave_approver` is not called here and must not be:
    every signed-in account applies for its own leave, students included, and a
    capability gate on this path is how a student discovers they can ask for a
    day off and not take it back. `requester_user_id` is the only door, so an
    approver cannot withdraw somebody else's request either — that is what
    REJECT is for, and it leaves their name on it.

    THE REFUSAL FOR SOMEBODY ELSE'S LEAVE IS THE SAME 404 AS A MISSING ID, for
    `_assert_can_decide`'s reason: told apart, this endpoint is a membership
    oracle over the whole programme — guess ids, read the error, learn who has
    leave pending. A 403 here would be exactly that, and it would be worse than
    the decision path's because anybody signed in could ask.

    `LeaveStatus.CANCELLED` and its Postgres label have existed since
    `a80068bf03da`, and `leave_paper.SANCTIONED_WORDS` already prints
    "Cancelled": there is no enum work in B10.4 and nobody should add any.
    """
    lr = db.get(LeaveRequest, leave_id)
    if lr is None or lr.requester_user_id != session.get("userId"):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Leave request not found."
        )
    if lr.status not in CANCELLABLE:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Leave is {lr.status.value}; it can no longer be withdrawn. "
                "Only a request that is still awaiting a signature can be cancelled."
            ),
        )
    lr.status = LeaveStatus.CANCELLED
    # `updated_at` moves for any edit at all, so it cannot answer "when was this
    # withdrawn" on a row somebody touched afterwards. That is what this column
    # is for.
    lr.cancelled_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(lr)
    return _leave_out(lr, db)


def _assert_can_decide(session: dict, lr: LeaveRequest, db: Session) -> str:
    """Staff only, and only for a requester inside the caller's own scope.
    RETURNS THE FUNCTION the caller is admitted in — one of
    `models.leave.SIGNED_AS` — which is what the decision path stamps on the row
    and the paper prints.

    Resolves the requester back to their Student row and hands the group test to
    mentor._assert_can_access_student. Doing it here rather than inline keeps the
    decision endpoint honest about the same rule the list obeys — before this,
    /pending could be narrowed and the decision path would still have taken any
    leave id anyone happened to learn.

    Every refusal is flattened to the SAME 404 the missing-leave path returns, so
    a mentor cannot separate "that id exists but is not yours" from "no such
    leave". Left distinguishable, the endpoint is a membership oracle over the
    whole programme: guess ids, read the error, learn who has leave pending.

    ==================================================================
    B10.1 — THE THIRD DOOR, AND THE DEADLOCK IT EXISTS TO BREAK
    ==================================================================

    Until Phase 4 this function had two doors: `role == "ADMIN"`, and a MENTOR
    with the applicant in their own group. Everything else was a 404, INCLUDING
    every request whose applicant has no `students` row at all. A faculty
    member's own leave is exactly that, and so is a student nobody has been
    assigned yet.

    That is a DEADLOCK, not an inconvenience. `decide_leave` requires the second
    signature from a DIFFERENT user, and `app.grant_access` permits exactly ONE
    ADMIN account on a deployment. So a staff leave request reached
    FIRST_APPROVED and could never reach APPROVED: the office signed once and
    there was nobody alive who could sign again. `tests/test_leave_paper.py`
    never saw it because it mints two `Role.ADMIN` users through `make_user`,
    which does not go through `grant_access`.

    THE THIRD DOOR IS A SCOPED GRANT AND NOTHING ELSE. Not "a MENTOR with no
    group may see staff leave" — that is the account this module's whole scope
    rule exists to keep out, and re-admitting it here would hand the queue, with
    every medical `reason` in it, straight back. What is admitted is a faculty
    account somebody DECIDED should sign leave for these people:
    `mentor.leave_approve` granted in Governance at `ScopeLevel.DEPARTMENT` or
    `COLLEGE`, with a reason, on the audit trail, revocable in an hour.

    WHAT IS NOT BUILT, AND WHY. 04 asks for "first signature = mentor or HOD of
    the requester's department, second = principal function". There is no HOD
    ACCOUNT in this product — `departments.head` is a free-text String — no
    `Role.HOD`, and no principal concept anywhere; `app/models/leave.py`'s
    SIGNED_AS block says it at length. A grant scoped to a department is the
    same sentence said in the vocabulary this product actually has.
    """
    require_mentor(session)
    if session["role"] == "ADMIN":
        return SIGNED_AS_MAIN_ADMIN
    student = db.scalar(select(Student).where(Student.user_id == lr.requester_user_id))
    if student is not None:
        try:
            _assert_can_access_student(session, student.id, db)
            return SIGNED_AS_MENTOR
        except HTTPException:
            # Not in this mentor's group. That is not the end of the question
            # any more — it is the end of the MENTOR answer to it.
            pass
    if _holds_scoped_leave_grant(db, session, lr, student):
        return SIGNED_AS_DELEGATE
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Leave request not found.")


LEAVE_CAPABILITY = "mentor.leave_approve"


def _holds_scoped_leave_grant(
    db: Session, session: dict, lr: LeaveRequest, student: Student | None
) -> bool:
    """Does this caller hold a GRANT of `mentor.leave_approve` that reaches the
    applicant?

    IT ASKS `granted_reaches` DIRECTLY AND MUST NEVER BE REWRITTEN AS
    `require_capability(..., target=...)`, WHICH LOOKS IDENTICAL AND IS NOT.
    That function SHORT-CIRCUITS before it ever looks at a scope, twice: once
    for a key in the caller's `ROLE_BASELINE`, and once for a key a MENTOR holds
    as a derived FUNCTION (app/governance.py). `mentor.leave_approve` is exactly
    such a function for every faculty account that currently mentors anybody
    (app/mentor_functions.py), so a `require_capability` written here would
    return `None` for them without reading a grant — and this function would
    then say "yes" for every faculty member with one mentee, about every staff
    leave request and every student on the deployment. A fence that is a no-op
    for most of the people it fences. `mentor_history.holds_handover_for` refuses
    `reaches_target` for the mirror-image reason and says so in the same words.

    Both walks are here because both kinds of applicant exist on this form:
    `ancestry_of_student` for a student (it reads BOTH department pointers, so a
    student in no batch is still reachable through `students.department_id`),
    `ancestry_of_user` for a member of staff. An UNFILED applicant — no
    department either way — has an empty ancestry and is reached by no scoped
    grant at all; that is `reaches_target`'s documented rule and it is right
    here, because a department-scoped signature over somebody in no department
    is a signature about nothing.

    A PROGRAMME-WIDE GRANT (`scope_level` and `scope_id` both NULL) reaches
    everybody, including the unfiled, and that is deliberate: nothing in this
    product issues one of those for `mentor.leave_approve` by itself — the Main
    Admin holds the key by BASELINE, not by a grant — so such a row can only
    have been written by the office in Governance, naming a person, with a
    reason. It means what it says.
    """
    reaches = granted_reaches(db, str(session.get("userId") or ""), LEAVE_CAPABILITY)
    if not reaches:
        return False
    ancestry = (
        ancestry_of_student(db, student.id)
        if student is not None
        else ancestry_of_user(db, lr.requester_user_id)
    )
    return reaches_target(reaches, ancestry)


def _narrow_to_scope(query, db: Session, session: dict, response: Response):
    """Narrow an approver's queue to what this session may see. One rule, two
    halves, and they are composed rather than one replacing the other.

    A MENTOR'S GROUP IS ALWAYS A DOOR, exactly as before, and B10.1 only ever
    ADDED a second one beside it (see below). That first fence is rule 2's and
    it is STRICTER than any scope could be — it narrows to
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

    B10.1 ADDED THE SECOND HALF TO THE MENTOR BRANCH, AS A UNION AND NEVER AS A
    REPLACEMENT. The group fence above is untouched — deleting it is the mistake
    `tests/test_scoped_lists.py` names out loud ("the mentor's own mentee's leave
    vanished — the reach was applied to a function") — but a faculty account that
    the office has GRANTED `mentor.leave_approve` over a department can now sign
    that department's requests, and a queue that showed them nothing would make
    the grant invisible to the only person it was written for. A mentoring
    account with no grant reaches `nothing` and the union is the group fence
    exactly, byte for byte.

    Requests from STAFF — a faculty member's own leave — belong to no student,
    and until B10.1 that meant they hung under no reach at all and stayed the
    Main Admin's. They hang under `Reach.user_ids()` now, which is the same
    spine read one rung differently (`governance.ancestry_of_user`: a faculty
    account is filed under a department and nothing else). That is what makes a
    staff request decidable by somebody other than the single office account —
    see `_assert_can_decide` on the deadlock.

    NO `X-Reep-Scope` HEADER ON THE MENTOR BRANCH, deliberately. The three words
    the header may carry describe a REACH, and a mentor's queue is bounded by
    their group as well; "narrowed" would be true and useless, and "programme"
    could never be right. The header stays exactly where it was.
    """
    if session["role"] == "MENTOR":
        clauses = []
        mentor_id = session.get("mentorId")
        if mentor_id:
            # Narrowed in SQL, not filtered in Python afterwards: an out-of-group
            # `reason` should never be read out of the database in the first place.
            clauses.append(
                LeaveRequest.requester_user_id.in_(
                    select(Student.user_id).where(Student.mentor_id == mentor_id)
                )
            )
        granted = scope_filter(db, session, LEAVE_CAPABILITY)
        if granted.everything:
            # A programme-wide grant, written by hand in Governance. A faculty
            # account never reaches here through a FUNCTION: `scope_filter` reads
            # ROLE_BASELINE and grants, and neither carries a mentor function.
            return query
        if not granted.nothing:
            clauses.append(
                LeaveRequest.requester_user_id.in_(
                    select(Student.user_id).where(Student.id.in_(granted.student_ids()))
                )
            )
            clauses.append(LeaveRequest.requester_user_id.in_(granted.user_ids()))
        if not clauses:
            return None  # no Mentor group and no grant => nobody (never the whole programme)
        return query.where(or_(*clauses))
    reach = scope_filter(db, session, LEAVE_CAPABILITY)
    scope_header(response, reach)
    if reach.everything:
        return query  # the Main Admin: the whole programme, staff leave included
    if reach.nothing:
        return None
    return query.where(
        or_(
            LeaveRequest.requester_user_id.in_(
                select(Student.user_id).where(Student.id.in_(reach.student_ids()))
            ),
            LeaveRequest.requester_user_id.in_(reach.user_ids()),
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


#: What `/history` answers when nobody asks for anything in particular — the
#: Approved and Rejected tabs, exactly the pair it has always returned.
HISTORY_DEFAULT_STATUSES = (LeaveStatus.APPROVED, LeaveStatus.REJECTED)
#: And what `?status=` may name. CANCELLED is settled but it is not DECIDED, so
#: it is reachable only by asking: a withdrawn request appearing unbidden in the
#: Rejected-and-Approved list would read as a decision somebody made.
HISTORY_STATUSES: dict[str, LeaveStatus] = {
    LeaveStatus.APPROVED.value: LeaveStatus.APPROVED,
    LeaveStatus.REJECTED.value: LeaveStatus.REJECTED,
    LeaveStatus.CANCELLED.value: LeaveStatus.CANCELLED,
}


@router.get("/history", response_model=list[LeaveOut])
def decided_leaves(
    response: Response,
    status_filter: str | None = Query(
        default=None,
        alias="status",
        description="APPROVED, REJECTED or CANCELLED. Omit for the settled queue (approved and rejected).",
    ),
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[LeaveOut]:
    """Requests that are settled — the Approved, Rejected and Cancelled tabs of
    the approvals screen. SAME SCOPE AS /pending, through the same
    `_narrow_to_scope` and narrowed in SQL: a MENTOR sees only their own group's
    (plus anything an explicit grant reaches), a MENTOR with neither sees nobody,
    a scoped approver sees their reach, the Main Admin sees all. One function
    rather than the two copies that stood here — the copies were identical when
    they were written, which is how they stay identical only until one of them is
    edited. Own requests are excluded as they are from /pending — the applicant
    reads those under /mine, and the approvals screen is the other chair.

    `?status=` IS ADDITIVE AND THE DEFAULT IS UNCHANGED (B10.4). Omitting it
    returns exactly what this endpoint has always returned, in exactly the same
    order. It exists because a CANCELLED row is returned by NEITHER queue today
    — `/pending` filters SUBMITTED and FIRST_APPROVED, this one filtered
    APPROVED and REJECTED — so the console's "Cancelled" tab could not be lit by
    filtering on the client however hard it tried. Widening the default instead
    would have put withdrawn requests into the Approved and Rejected tabs of
    every screen already built against this endpoint.
    """
    _require_leave_approver(db, session)
    if status_filter is None:
        wanted = list(HISTORY_DEFAULT_STATUSES)
    elif status_filter.upper() in HISTORY_STATUSES:
        wanted = [HISTORY_STATUSES[status_filter.upper()]]
    else:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                "status must be one of "
                + ", ".join(sorted(HISTORY_STATUSES))
                + ". SUBMITTED and FIRST_APPROVED are the pending queue."
            ),
        )
    uid = session["userId"]
    query = (
        select(LeaveRequest)
        .where(
            LeaveRequest.status.in_(wanted),
            LeaveRequest.requester_user_id != uid,
        )
        .order_by(
            # `cancelled_at` first and it changes nothing for the other two: it
            # is NULL on every row that was never withdrawn, so the coalesce
            # falls through to the decision stamps exactly as it did before. A
            # request cancelled AFTER its first signature sorts by the
            # withdrawal, which is the last thing that happened to it.
            func.coalesce(
                LeaveRequest.cancelled_at,
                LeaveRequest.second_decided_at,
                LeaveRequest.first_decided_at,
            ).desc(),
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
    #
    # It hands back the FUNCTION it admitted on (B10.1), which is stamped beside
    # the signature below. Taken from the gate rather than re-derived afterwards
    # for the reason two copies of any scope rule in this file are avoided: a
    # second derivation is a second answer to "how did this person get in", and
    # the one printed on the college's form would be the one nothing tested.
    signed_as = _assert_can_decide(session, lr, db)
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
        lr.first_signed_as = signed_as
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
        lr.second_signed_as = signed_as
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
    # B10.5, off by default, after the commit. See `submit_leave`. A first
    # signature and a final decision are different messages carrying different
    # dedupe keys, so signing both steps sends two and retrying either sends
    # neither again. CANCELLED has no message at all: the applicant withdrew it
    # themselves and does not need telling what they just did.
    notify_transition(db, lr)
    return _leave_out(lr, db)
