"""B10.1/B10.2/B10.4/B10.7/B10.8 — who may sign a leave request, what the
submit path refuses, how an applicant withdraws, and what a non-approver sees.

The five things this module holds down, and what comes back if it is deleted:

1. THE DEADLOCK. `_assert_can_decide` resolved the applicant to a `students`
   row and 404'd a MENTOR when there wasn't one, so a FACULTY member's own leave
   was decidable by `role == "ADMIN"` alone — while `app.grant_access` permits
   exactly ONE ADMIN account and `decide_leave` demands the second signature
   from a DIFFERENT user. Every staff leave request on every real deployment
   reached FIRST_APPROVED and stopped there for ever, with a live "Mark
   Sanctioned" button on the console. `tests/test_leave_paper.py` could not see
   it because it mints two `Role.ADMIN` users through `make_user`, which does
   not go through `grant_access`. Both halves are asserted below: the deadlock
   as it was, and the grant that breaks it.
2. THE SHORT-CIRCUIT TRAP. `governance.require_capability` returns BEFORE it
   looks at a scope for a baseline key and for a capability a MENTOR holds as a
   derived FUNCTION — and `mentor.leave_approve` is such a function for every
   faculty account that currently mentors anybody. So a scoped check written as
   `require_capability(..., target=...)` would be a no-op for most of the people
   it fences, and would hand every mentoring lecturer every staff member's
   medical `reason` on the deployment that shipped it. The door asks
   `granted_reaches` directly, and `test_a_mentor_function_is_not_a_grant`
   asserts the difference between the two in one place.
3. THE SUBMIT CHECKS ARE SILENT UNTIL THE OFFICE RECORDS AN ALLOWANCE. Delete
   `test_the_submit_checks_sleep_until_a_balance_exists` and a table nobody has
   filled in starts refusing requests the form accepted yesterday — on the
   college's own paper form, which the owner asked not to change.
4. CANCELLED IS REACHABLE ONLY BY ASKING. Neither queue returned a withdrawn
   request before B10.4; widening `/history`'s default instead would have put
   them into the Approved and Rejected tabs of a console already built against
   it.
5. THE REDUCED PROJECTION IS A SHAPE, NOT A CONVENTION. `LeaveOut.reason` is
   free text and routinely medical. `LeaveBrief` cannot carry one because it has
   no field for one, and `test_the_reduced_projection_cannot_carry_a_reason`
   is what stops the next reader adding it "just for the alternate's screen".
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

import pytest
from sqlalchemy import delete, select, update

from conftest import TEST_PASSWORD, requires_db

from app.db import SessionLocal
from app.leave_policy import academic_year_for
from app.models.cohort import Cohort
from app.models.governance import CapabilityGrant, ScopeLevel, SubjectKind
from app.models.institution import STATUS_ACTIVE, College, Department
from app.models.job import DegreeLevel
from app.models.leave import SIGNED_AS, LeaveRequest, LeaveStatus
from app.models.leave_policy import AcademicCalendarDay, LeaveBalance
from app.models.user import Mentor, Role, Student, User
from app.seed_roster import SSO_ONLY_PASSWORD_HASH

LEAVES = "/api/leaves"
LEAVE_CAPABILITY = "mentor.leave_approve"


# ----------------------------------------------------------------- fixtures --


@pytest.fixture
def chain(make_user):
    """One college, two departments, a batch and a student in each.

    DEPENDS ON `make_user` so that pytest sets THAT fixture up first and tears
    it down LAST. The order is load-bearing rather than tidy: a `make_user`
    faculty account filed under one of these departments, or a `Mentor` group
    one of these students points at, blocks the delete either way round — and
    the failure surfaces as an IntegrityError inside somebody else's teardown.
    """
    tag = uuid.uuid4().hex[:6]
    made: dict[str, str] = {"tag": tag}
    with SessionLocal() as db:
        college = College(code=f"LC{tag.upper()}", name="Leave Chain College", status=STATUS_ACTIVE)
        db.add(college)
        db.flush()
        here = Department(college_id=college.id, name="Chain Here", code=f"CH{tag}")
        there = Department(college_id=college.id, name="Chain There", code=f"CT{tag}")
        db.add_all([here, there])
        db.flush()

        def batch(code: str, department_id: str) -> Cohort:
            return Cohort(
                code=f"{code}-{tag}", name=f"Batch {code}", batch_label="2026-28",
                degree_level=DegreeLevel.PG, department_id=department_id,
                start_date=datetime(2026, 8, 1, tzinfo=timezone.utc),
                end_date=datetime(2028, 7, 31, tzinfo=timezone.utc),
            )

        b_here, b_there = batch("LH", here.id), batch("LT", there.id)
        db.add_all([b_here, b_there])
        db.flush()

        def student(label: str, cohort: Cohort) -> tuple[User, Student]:
            u = User(
                email=f"{label}-{tag}@chain.test", name=f"{label.title()} {tag}",
                role=Role.STUDENT, password_hash=SSO_ONLY_PASSWORD_HASH,
            )
            db.add(u)
            db.flush()
            s = Student(user_id=u.id, usn=f"{label[:4].upper()}{tag}", cohort_id=cohort.id)
            db.add(s)
            return u, s

        u_here, s_here = student("chere", b_here)
        u_there, s_there = student("cthere", b_there)
        db.flush()

        def leave(user: User) -> LeaveRequest:
            return LeaveRequest(
                requester_user_id=user.id,
                from_date=date(2026, 11, 2), to_date=date(2026, 11, 3),
                reason=f"leave-chain fixture {tag}", status=LeaveStatus.SUBMITTED,
                signed_at=datetime.now(timezone.utc),
            )

        leaves = [leave(u_here), leave(u_there)]
        db.add_all(leaves)
        db.commit()
        made |= {
            "college": college.id, "here": here.id, "there": there.id,
            "batch_here": b_here.id, "batch_there": b_there.id,
            "student_here": s_here.id, "student_there": s_there.id,
            "user_here": u_here.id, "user_there": u_there.id,
            "leave_here": leaves[0].id, "leave_there": leaves[1].id,
        }

    yield made

    with SessionLocal() as db:
        departments = [made["here"], made["there"]]
        users = [made["user_here"], made["user_there"]]
        students = [made["student_here"], made["student_there"]]
        # Unseat and unfile before deleting: `students.mentor_id` and
        # `users.department_id` carry no ON DELETE, so anything still pointing
        # here takes this teardown down with it.
        db.execute(update(Student).where(Student.id.in_(students)).values(mentor_id=None))
        db.execute(
            update(User).where(User.department_id.in_(departments)).values(department_id=None)
        )
        db.execute(
            update(Student)
            .where(Student.department_id.in_(departments))
            .values(department_id=None)
        )
        db.flush()
        db.execute(delete(LeaveBalance).where(LeaveBalance.user_id.in_(users)))
        db.execute(delete(LeaveRequest).where(LeaveRequest.requester_user_id.in_(users)))
        db.execute(
            delete(AcademicCalendarDay).where(
                AcademicCalendarDay.college_id == made["college"]
            )
        )
        db.execute(delete(Student).where(Student.id.in_(students)))
        db.execute(delete(User).where(User.id.in_(users)))
        db.execute(
            delete(Cohort).where(Cohort.id.in_([made["batch_here"], made["batch_there"]]))
        )
        db.execute(delete(Department).where(Department.id.in_(departments)))
        db.execute(delete(College).where(College.id == made["college"]))
        db.commit()


@pytest.fixture
def scoped_grant():
    """One capability, scoped to one rung, written as a ROW.

    Not through `POST /api/admin/governance/grants`, for `test_scoped_lists.py`'s
    reason: a `carries_pii` key lands `pending_approval` under B2.4 and holds
    nothing until a second Main Admin approves it, which would make these tests
    pass for the wrong reason.
    """
    made: list[str] = []

    def _grant(user_id: str, key: str, level: ScopeLevel | None, target_id: str | None) -> str:
        with SessionLocal() as db:
            row = CapabilityGrant(
                capability=key, subject_kind=SubjectKind.USER, subject_user_id=user_id,
                scope_level=level, scope_id=target_id,
                reason="the leave-chain tests need a scoped grant, twenty characters plus",
            )
            db.add(row)
            db.commit()
            made.append(row.id)
            return row.id

    yield _grant

    with SessionLocal() as db:
        db.execute(delete(CapabilityGrant).where(CapabilityGrant.id.in_(made)))
        db.commit()


def _file_under(user_id: str, department_id: str | None) -> None:
    """Put a staff account in a department — where `ancestry_of_user` reads it."""
    with SessionLocal() as db:
        db.get(User, user_id).department_id = department_id
        db.commit()


def _seat(student_id: str, faculty_user_id: str) -> str:
    """Give a faculty account a mentee, which is what derives the four
    `mentor.*` FUNCTIONS (app/mentor_functions.py) — including
    `mentor.leave_approve`. Returns the group id."""
    with SessionLocal() as db:
        group = Mentor(user_id=faculty_user_id)
        db.add(group)
        db.flush()
        db.get(Student, student_id).mentor_id = group.id
        db.commit()
        return group.id


def _unseat(student_id: str, group_id: str) -> None:
    with SessionLocal() as db:
        student = db.get(Student, student_id)
        if student is not None:
            student.mentor_id = None
        db.flush()
        db.execute(delete(Mentor).where(Mentor.id == group_id))
        db.commit()


def _submit(client, headers, **extra) -> dict:
    body = {
        "from_date": "2026-11-10",
        "to_date": "2026-11-11",
        "reason": "Family function at home.",
        "leave_kind": "CASUAL",
    }
    body.update(extra)
    r = client.post(LEAVES, headers=headers, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _status(leave_id: str) -> str:
    with SessionLocal() as db:
        return db.get(LeaveRequest, leave_id).status.value


def _drop(leave_id: str) -> None:
    with SessionLocal() as db:
        db.execute(delete(LeaveRequest).where(LeaveRequest.id == leave_id))
        db.commit()


# ------------------------------------------------------------ B10.1 the chain --


@requires_db
def test_a_staff_leave_request_deadlocked_and_a_scoped_grant_breaks_it(
    client, make_user, login, chain, scoped_grant
):
    """THE BUG, and the fix, in one run.

    A faculty member applies for leave. They have no `students` row, so
    `_assert_can_decide`'s mentor branch has nothing to test them against and
    every MENTOR gets a flattened 404 — INCLUDING a faculty member who mentors
    half the department, because a mentor group is a claim over STUDENTS.
    `role == "ADMIN"` was therefore the only door, `grant_access` permits one
    ADMIN account, and `decide_leave` requires the second signature from a
    different user. One signature, for ever.

    The half that is NOT relaxed is asserted first and asserted again after the
    grant: the mentoring colleague with no grant is refused throughout. The fix
    is not "a faculty member may sign staff leave"; it is "the office decided,
    in Governance, with a reason, that THIS person signs leave for THIS
    department".
    """
    applicant = make_user(f"lc-app-{chain['tag']}", Role.MENTOR)
    colleague = make_user(f"lc-col-{chain['tag']}", Role.MENTOR)
    office = make_user(f"lc-adm-{chain['tag']}", Role.ADMIN)
    _file_under(applicant.user_id, chain["here"])
    _file_under(colleague.user_id, chain["here"])
    # The colleague mentors somebody, so they hold `mentor.leave_approve` as a
    # derived FUNCTION and are admitted by `_require_leave_approver`. Signing in
    # AFTER the group exists: `mentorId` is minted at login.
    group = _seat(chain["student_here"], colleague.user_id)
    leave_id = None
    try:
        colleague_h = login(colleague.email, TEST_PASSWORD)
        leave_id = _submit(client, applicant.headers)["id"]
        approve = {"decision": "APPROVE", "note": None}

        # THE DEADLOCK, first half: the mentoring colleague cannot sign at all,
        # and the refusal is the same 404 an invented id gets.
        refused = client.post(f"{LEAVES}/{leave_id}/decision", headers=colleague_h, json=approve)
        invented = client.post(f"{LEAVES}/no-such-leave/decision", headers=colleague_h, json=approve)
        assert refused.status_code == 404, refused.text
        assert (invented.status_code, invented.json()) == (refused.status_code, refused.json())

        # The office signs once...
        first = client.post(f"{LEAVES}/{leave_id}/decision", headers=office.headers, json=approve)
        assert first.status_code == 200, first.text
        assert first.json()["status"] == "FIRST_APPROVED"
        assert first.json()["first_signed_as"] == "MAIN_ADMIN"

        # ...and cannot sign again, which is the rule that makes this a deadlock
        # rather than an inconvenience.
        again = client.post(f"{LEAVES}/{leave_id}/decision", headers=office.headers, json=approve)
        assert again.status_code == 409, again.text
        assert "different approver" in again.text
        # THE DEADLOCK, second half: and still nobody else can.
        stuck = client.post(f"{LEAVES}/{leave_id}/decision", headers=colleague_h, json=approve)
        assert stuck.status_code == 404, stuck.text
        assert _status(leave_id) == "FIRST_APPROVED"

        # THE FIX: the office grants the colleague `mentor.leave_approve` over
        # the department the applicant is filed under.
        scoped_grant(colleague.user_id, LEAVE_CAPABILITY, ScopeLevel.DEPARTMENT, chain["here"])
        second = client.post(f"{LEAVES}/{leave_id}/decision", headers=colleague_h, json=approve)
        assert second.status_code == 200, second.text
        assert second.json()["status"] == "APPROVED"
        assert second.json()["second_signed_as"] == "DELEGATE"
        assert second.json()["first_signed_as"] == "MAIN_ADMIN", "the first stamp is not rewritten"
    finally:
        if leave_id:
            _drop(leave_id)
        _unseat(chain["student_here"], group)


@requires_db
def test_a_mentor_function_is_not_a_grant(client, make_user, login, chain):
    """THE TRAP, asserted where it can be read.

    `require_capability(db, session, key, target=...)` SHORT-CIRCUITS for a
    capability a MENTOR holds as a derived function: it returns before it reads
    a single grant, so it says "yes, and in scope" about a department the holder
    has nothing to do with. `_holds_scoped_leave_grant` asks `granted_reaches`
    instead and says no.

    Delete this and the obvious tidy-up — "use require_capability, that is what
    it is for" — turns every faculty member with one mentee into an approver for
    every staff leave request on the deployment, silently, with no test failing.
    """
    from app.governance import ancestry_of_user, granted_reaches, require_capability
    from app.routers.leave import _holds_scoped_leave_grant

    colleague = make_user(f"lc-trap-{chain['tag']}", Role.MENTOR)
    applicant = make_user(f"lc-trapapp-{chain['tag']}", Role.MENTOR)
    _file_under(applicant.user_id, chain["there"])
    group = _seat(chain["student_here"], colleague.user_id)
    leave_id = None
    try:
        login(colleague.email, TEST_PASSWORD)  # the group exists before the claim is minted
        leave_id = _submit(client, applicant.headers)["id"]
        session = {"role": "MENTOR", "userId": colleague.user_id}
        with SessionLocal() as db:
            lr = db.get(LeaveRequest, leave_id)
            ancestry = ancestry_of_user(db, applicant.user_id)
            assert ancestry, "the applicant is filed under a department"

            # The function is held...
            assert require_capability(db, session, LEAVE_CAPABILITY, target=ancestry) is None, (
                "require_capability short-circuits on a mentor function — if this "
                "ever raises, re-read _holds_scoped_leave_grant before celebrating"
            )
            # ...and it is not a grant, and the door knows the difference.
            assert granted_reaches(db, colleague.user_id, LEAVE_CAPABILITY) == []
            assert _holds_scoped_leave_grant(db, session, lr, None) is False
    finally:
        if leave_id:
            _drop(leave_id)
        _unseat(chain["student_here"], group)


@requires_db
def test_a_department_scoped_approver_reaches_that_department_and_no_further(
    client, make_user, chain, scoped_grant
):
    """The fence the third door hangs on, on a student AND on a staff applicant.

    A grant scoped to one department reaches its students and its filed staff.
    It reaches neither of the other department's, and the refusal is the same
    flattened 404 everything else in this module returns.
    """
    approver = make_user(f"lc-appr-{chain['tag']}", Role.MENTOR)
    outsider = make_user(f"lc-out-{chain['tag']}", Role.MENTOR)
    _file_under(approver.user_id, chain["here"])
    _file_under(outsider.user_id, chain["there"])
    scoped_grant(approver.user_id, LEAVE_CAPABILITY, ScopeLevel.DEPARTMENT, chain["here"])
    staff_leave = None
    try:
        staff_leave = _submit(client, outsider.headers)["id"]
        approve = {"decision": "APPROVE", "note": None}

        # The student in reach: signed, and the function is recorded.
        mine = client.post(
            f"{LEAVES}/{chain['leave_here']}/decision", headers=approver.headers, json=approve
        )
        assert mine.status_code == 200, mine.text
        assert mine.json()["first_signed_as"] == "DELEGATE"

        # The student out of reach, and the staff member out of reach.
        for leave_id in (chain["leave_there"], staff_leave):
            r = client.post(f"{LEAVES}/{leave_id}/decision", headers=approver.headers, json=approve)
            assert r.status_code == 404, f"{leave_id}: {r.text}"

        # And the queue agrees with the signature, which is the property that
        # makes the grant visible to the person who was given it.
        pending = client.get(f"{LEAVES}/pending", headers=approver.headers)
        assert pending.status_code == 200, pending.text
        seen = {row["id"] for row in pending.json()}
        assert chain["leave_there"] not in seen
        assert staff_leave not in seen
    finally:
        if staff_leave:
            _drop(staff_leave)


@requires_db
def test_a_grant_over_the_college_reaches_its_staff_leave_queue(
    client, make_user, chain, scoped_grant
):
    """The staff half of `_narrow_to_scope`, which hung under nothing before B10.1.

    A faculty member's own leave belongs to no student, so the reach's STUDENT
    projection can never match it. `Reach.user_ids()` is the same spine read one
    rung differently, and without it the queue of the person who can now sign a
    colleague's leave is empty — a capability nobody can find is a capability
    nobody uses.
    """
    approver = make_user(f"lc-coll-{chain['tag']}", Role.MENTOR)
    applicant = make_user(f"lc-collapp-{chain['tag']}", Role.MENTOR)
    _file_under(approver.user_id, chain["there"])
    _file_under(applicant.user_id, chain["here"])
    scoped_grant(approver.user_id, LEAVE_CAPABILITY, ScopeLevel.COLLEGE, chain["college"])
    leave_id = None
    try:
        leave_id = _submit(client, applicant.headers)["id"]
        r = client.get(f"{LEAVES}/pending", headers=approver.headers)
        assert r.status_code == 200, r.text
        seen = {row["id"] for row in r.json()}
        assert leave_id in seen, "a college-wide approver cannot see their college's staff leave"
        assert chain["leave_here"] in seen, "...nor its students'"
        assert r.headers.get("X-Reep-Scope") is None, (
            "the MENTOR branch does not stamp a scope header; the word would "
            "describe the reach and not the group fence beside it"
        )
    finally:
        if leave_id:
            _drop(leave_id)


@requires_db
def test_a_mentor_with_neither_a_group_nor_a_grant_still_sees_nobody(client, make_user, chain):
    """The rule the third door must not have relaxed, restated on the queue.

    `test_auth_rbac.py` asserts the 403 before any id lookup; this asserts the
    other half — that composing a reach INTO the mentor branch did not turn
    "no group" into "the whole programme" for an account that somehow reaches
    the query.
    """
    from app.policies import scope_filter
    from app.routers.leave import _narrow_to_scope

    loner = make_user(f"lc-loner-{chain['tag']}", Role.MENTOR)
    with SessionLocal() as db:
        session = {"role": "MENTOR", "userId": loner.user_id}
        assert scope_filter(db, session, LEAVE_CAPABILITY).nothing
        narrowed = _narrow_to_scope(select(LeaveRequest), db, session, None)
        assert narrowed is None, "no group and no grant must narrow to nobody, not to everybody"


# ---------------------------------------------------------- B10.4 the withdraw --


@requires_db
def test_the_applicant_withdraws_their_own_request_and_nobody_else_can(
    client, make_user, chain
):
    """Cancel is the APPLICANT's, it is not an approver's act, and it is not a
    way to rewrite a decision.

    REJECTED is terminal here for the same reason APPROVED is: somebody signed
    it. An applicant who could cancel a rejection would be editing a record
    made about them; the rejection stays on the paper and a fresh request is the
    honest way forward.
    """
    applicant = make_user(f"lc-can-{chain['tag']}", Role.MENTOR)
    stranger = make_user(f"lc-str-{chain['tag']}", Role.MENTOR)
    office = make_user(f"lc-canadm-{chain['tag']}", Role.ADMIN)
    ids: list[str] = []
    try:
        plain = _submit(client, applicant.headers)["id"]
        ids.append(plain)

        # A stranger's refusal is the same 404 as an id that does not exist:
        # this endpoint is open to every signed-in account, so a 403 here would
        # be a membership oracle anybody could query.
        mine = client.post(f"{LEAVES}/{plain}/cancel", headers=stranger.headers)
        nothing = client.post(f"{LEAVES}/no-such-leave/cancel", headers=stranger.headers)
        assert mine.status_code == 404, mine.text
        assert (nothing.status_code, nothing.json()) == (mine.status_code, mine.json())

        r = client.post(f"{LEAVES}/{plain}/cancel", headers=applicant.headers)
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "CANCELLED"
        with SessionLocal() as db:
            assert db.get(LeaveRequest, plain).cancelled_at is not None

        # Twice is a 409, not a second cancellation.
        assert client.post(f"{LEAVES}/{plain}/cancel", headers=applicant.headers).status_code == 409

        # FIRST_APPROVED is still the applicant's to withdraw — one signature is
        # a step, not a sanction.
        half = _submit(client, applicant.headers, from_date="2026-11-20", to_date="2026-11-21")["id"]
        ids.append(half)
        assert client.post(
            f"{LEAVES}/{half}/decision", headers=office.headers, json={"decision": "APPROVE"}
        ).status_code == 200
        assert _status(half) == "FIRST_APPROVED"
        assert client.post(f"{LEAVES}/{half}/cancel", headers=applicant.headers).status_code == 200

        # A REJECTED request is terminal.
        done = _submit(client, applicant.headers, from_date="2026-11-25", to_date="2026-11-26")["id"]
        ids.append(done)
        assert client.post(
            f"{LEAVES}/{done}/decision", headers=office.headers, json={"decision": "REJECT"}
        ).status_code == 200
        refused = client.post(f"{LEAVES}/{done}/cancel", headers=applicant.headers)
        assert refused.status_code == 409, refused.text
        assert "REJECTED" in refused.text
    finally:
        for leave_id in ids:
            _drop(leave_id)


@requires_db
def test_a_cancelled_request_is_reachable_only_by_asking_for_it(client, make_user, chain):
    """B10.4's other half: the console's "Cancelled" tab could not be lit by
    filtering on the client, because NEITHER queue returned a cancelled row.

    The default is unchanged and is asserted as such — widening it would have
    dropped withdrawn requests into the Approved and Rejected tabs of every
    screen already built against this endpoint.
    """
    applicant = make_user(f"lc-hist-{chain['tag']}", Role.MENTOR)
    office = make_user(f"lc-histadm-{chain['tag']}", Role.ADMIN)
    ids: list[str] = []
    try:
        gone = _submit(client, applicant.headers)["id"]
        ids.append(gone)
        assert client.post(f"{LEAVES}/{gone}/cancel", headers=applicant.headers).status_code == 200

        kept = _submit(client, applicant.headers, from_date="2026-11-20", to_date="2026-11-21")["id"]
        ids.append(kept)
        assert client.post(
            f"{LEAVES}/{kept}/decision", headers=office.headers, json={"decision": "APPROVE"}
        ).status_code == 200
        assert client.post(
            f"{LEAVES}/{kept}/decision", headers=office.headers, json={"decision": "APPROVE"}
        ).status_code == 409, "one account cannot give both signatures"

        def ids_at(path: str) -> set[str]:
            r = client.get(path, headers=office.headers)
            assert r.status_code == 200, r.text
            return {row["id"] for row in r.json()}

        assert gone not in ids_at(f"{LEAVES}/pending")
        assert gone not in ids_at(f"{LEAVES}/history"), "the default queue grew a cancelled row"
        assert gone in ids_at(f"{LEAVES}/history?status=CANCELLED")
        assert gone not in ids_at(f"{LEAVES}/history?status=REJECTED")
        assert kept not in ids_at(f"{LEAVES}/history?status=CANCELLED")

        bad = client.get(f"{LEAVES}/history?status=SUBMITTED", headers=office.headers)
        assert bad.status_code == 422, bad.text
        assert "pending queue" in bad.text
    finally:
        for leave_id in ids:
            _drop(leave_id)


# ----------------------------------------------------- B10.2 the submit checks --


def _balance(user_id: str, kind: str, entitled: int, consumed: int = 0) -> None:
    with SessionLocal() as db:
        db.add(
            LeaveBalance(
                user_id=user_id, kind=kind, academic_year=academic_year_for(date(2026, 11, 10)),
                entitled_days=entitled, consumed_days=consumed,
            )
        )
        db.commit()


@requires_db
def test_the_submit_checks_sleep_until_a_balance_exists(client, make_user, chain):
    """A table nobody has filled in must not change what the form accepts.

    `interview_policies`' rule applied to leave: no row is seeded, and the
    absence of one IS the default. `tests/test_leave_dates.py` submits
    `today..today` and then `today..today+3` for one account and asserts both
    are 201 — a deliberately overlapping pair — so an overlap check that fired
    without an allowance would take that module with it, and would refuse
    requests the office has been signing by hand for a year.
    """
    applicant = make_user(f"lc-sleep-{chain['tag']}", Role.MENTOR)
    ids: list[str] = []
    try:
        ids.append(_submit(client, applicant.headers)["id"])
        # Exactly the same days again: accepted, because nothing has been recorded.
        ids.append(_submit(client, applicant.headers)["id"])

        _balance(applicant.user_id, "CASUAL", entitled=10)
        clash = client.post(
            LEAVES,
            headers=applicant.headers,
            json={
                "from_date": "2026-11-11", "to_date": "2026-11-12",
                "reason": "Family function at home.", "leave_kind": "CASUAL",
            },
        )
        assert clash.status_code == 422, clash.text
        assert "overlaps" in clash.text and "2026-11-10" in clash.text

        # A kind the office has recorded nothing for is still not checked.
        ids.append(_submit(client, applicant.headers, leave_kind="OOD")["id"])
    finally:
        for leave_id in ids:
            _drop(leave_id)


@requires_db
def test_a_request_past_the_balance_is_refused_and_the_refusal_names_lop(
    client, make_user, chain
):
    """B10.2's LOP "fallback" is a REFUSAL, never a silent rewrite.

    Rewriting `leave_kind` to LOP would change which of the five printed options
    is STRUCK THROUGH on the college's own form: the applicant asks for Casual
    Leave and collects a PDF saying Loss Of Pay, having agreed to nothing.
    Nobody should find out their leave became unpaid by reading a PDF.
    """
    applicant = make_user(f"lc-bal-{chain['tag']}", Role.MENTOR)
    ids: list[str] = []
    try:
        _balance(applicant.user_id, "CASUAL", entitled=2, consumed=1)
        over = client.post(
            LEAVES,
            headers=applicant.headers,
            json={
                "from_date": "2026-11-10", "to_date": "2026-11-12",
                "reason": "Family function at home.", "leave_kind": "CASUAL",
            },
        )
        assert over.status_code == 422, over.text
        assert "3 working day(s)" in over.text
        assert "1 of 2 day(s) left" in over.text
        assert "LOP (loss of pay)" in over.text

        # And the kind is untouched: nothing was stored at all.
        with SessionLocal() as db:
            assert db.scalar(
                select(LeaveRequest.id).where(
                    LeaveRequest.requester_user_id == applicant.user_id
                )
            ) is None

        # The one day that does fit is accepted, kind intact.
        inside = _submit(client, applicant.headers, to_date="2026-11-10")
        ids.append(inside["id"])
        assert inside["leave_kind"] == "CASUAL"
    finally:
        for leave_id in ids:
            _drop(leave_id)


@requires_db
def test_a_lop_refusal_does_not_advise_applying_for_lop(client, make_user, chain):
    """A hint that tells somebody applying for LOP to apply for LOP is the kind
    of message that makes a product look like it is not reading the request."""
    applicant = make_user(f"lc-lop-{chain['tag']}", Role.MENTOR)
    _balance(applicant.user_id, "LOP", entitled=1)
    r = client.post(
        LEAVES,
        headers=applicant.headers,
        json={
            "from_date": "2026-11-10", "to_date": "2026-11-12",
            "reason": "Unpaid.", "leave_kind": "LOP",
        },
    )
    assert r.status_code == 422, r.text
    assert "LOP (loss of pay)" not in r.text
    assert "adjust your balance" in r.text


@requires_db
def test_the_calendar_stops_a_holiday_eating_a_day_of_the_balance(client, make_user, chain):
    """The college's own closed days are not leave.

    A day counts unless `academic_calendar` carries a `holiday` row for it at
    the applicant's college — no weekday rule is invented here, because nothing
    in this product writes down which days the college works and the Angular
    form computes its own day count from the two dates. See
    `app/leave_policy.py` on why a silent Sunday subtraction would put the
    server's number and the applicant's number quietly out of step.
    """
    applicant = make_user(f"lc-cal-{chain['tag']}", Role.MENTOR)
    _file_under(applicant.user_id, chain["here"])
    _balance(applicant.user_id, "CASUAL", entitled=1)
    ids: list[str] = []
    try:
        body = {
            "from_date": "2026-11-10", "to_date": "2026-11-12",
            "reason": "Family function at home.", "leave_kind": "CASUAL",
        }
        assert client.post(LEAVES, headers=applicant.headers, json=body).status_code == 422

        with SessionLocal() as db:
            db.add_all([
                AcademicCalendarDay(
                    college_id=chain["college"], day=date(2026, 11, 11),
                    kind="holiday", label="Chain holiday",
                ),
                AcademicCalendarDay(
                    college_id=chain["college"], day=date(2026, 11, 12),
                    kind="holiday", label="Chain holiday II",
                ),
            ])
            db.commit()

        ok = client.post(LEAVES, headers=applicant.headers, json=body)
        assert ok.status_code == 201, ok.text
        ids.append(ok.json()["id"])
    finally:
        for leave_id in ids:
            _drop(leave_id)


def test_the_academic_year_label_is_the_conventional_spelling() -> None:
    """It exists to FIND a row the office typed, and the balance screen should
    pre-fill the same function's output so the two agree by construction. A miss
    switches the check off — see `app/leave_policy.py` on why that is the safe
    failure and consulting "whichever row this person has" is not."""
    assert academic_year_for(date(2026, 9, 13)) == "2026-27"
    assert academic_year_for(date(2026, 6, 1)) == "2026-27"
    assert academic_year_for(date(2026, 5, 31)) == "2025-26"
    assert academic_year_for(date(2027, 1, 4)) == "2026-27"


# ------------------------------------------------ B10.7 the reduced projection --


def test_the_reduced_projection_cannot_carry_a_reason() -> None:
    """`LeaveOut.reason` is the form's Purpose cell: free text, routinely
    medical. B10.6's alternate is a colleague who is neither the applicant nor
    an approver, and handing them `_leave_out` hands them a diagnosis.

    Asserted on the SHAPE rather than on a call site, because "the alternate
    endpoint happens to use the other function" is a property one careless
    import undoes. Pinned to an exact field set so a field ADDED to `LeaveBrief`
    has to be added here too, on purpose, by somebody reading this docstring.
    """
    from app.routers.leave import BRIEF_FIELDS, LeaveBrief, LeaveOut

    assert tuple(LeaveBrief.model_fields) == BRIEF_FIELDS
    forbidden = {"reason", "credit", "alt_name", "alt_rows", "director_note",
                 "first_note", "second_note", "requester_designation", "requester_department"}
    assert not (set(LeaveBrief.model_fields) & forbidden), (
        "the reduced projection grew a field a third party has no business reading"
    )
    # And the full one still carries everything it always did — this is a split,
    # not a trim: `/mine`, the two queues and the paper all read it.
    assert forbidden - set(LeaveOut.model_fields) == {"first_note", "second_note"}


@requires_db
def test_the_brief_of_a_real_request_holds_no_free_text(client, make_user, chain):
    """The shape check above, exercised against a row rather than a class."""
    from app.routers.leave import AltRow, _leave_brief

    applicant = make_user(f"lc-brief-{chain['tag']}", Role.MENTOR)
    leave_id = _submit(client, applicant.headers, reason="Post-operative review.")["id"]
    try:
        with SessionLocal() as db:
            brief = _leave_brief(
                db.get(LeaveRequest, leave_id), db, alt_row=AltRow(staff_name="Kavya N")
            )
        dumped = brief.model_dump()
        assert "Post-operative" not in str(dumped)
        assert dumped["status"] == "SUBMITTED"
        assert dumped["requester_name"]
        assert dumped["alt_row"]["staff_name"] == "Kavya N"
    finally:
        _drop(leave_id)


# ------------------------------------------------------ B10.8 the attestation --


def test_every_signing_function_has_a_printed_label() -> None:
    """A row stamped with a function the paper has no word for prints a raw
    database token at somebody's signature on the college's own form."""
    from app.leave_paper import SIGNED_AS_LABELS

    assert set(SIGNED_AS_LABELS) == set(SIGNED_AS)


def test_the_paper_prints_the_function_beside_the_signature_and_nothing_when_there_is_none() -> None:
    """B10.8, and the two things it is NOT.

    The words "PROGRAM DIRECTOR" are printed on the college's own PDF and are
    still there: the function goes on the muted attestation line beneath, which
    is overlay text in blank margin. And a request decided before these columns
    existed — NULL on both — prints exactly what it printed before, never a
    function guessed from who the signer happens to be today.
    """
    import io
    from types import SimpleNamespace

    from pypdf import PdfReader

    from app import leave_paper

    def paper(**extra) -> str:
        leave = SimpleNamespace(
            requester_name="Asha Rao", requester_designation="Assistant Professor",
            requester_department="MBA", from_date=date(2026, 9, 15), to_date=date(2026, 9, 16),
            reason="Family function.", status="APPROVED", leave_kind="CASUAL", credit="2",
            alt_name="Kavya N", alt_rows=[],
            signed_at=datetime(2026, 9, 9, 10, 0, tzinfo=timezone.utc),
            director_name="Ravi Kumar",
            director_decided_at=datetime(2026, 9, 10, 9, 0, tzinfo=timezone.utc),
            director_note=None,
        )
        for key, value in extra.items():
            setattr(leave, key, value)
        pdf = leave_paper.render_leave_paper_pdf(leave)
        return PdfReader(io.BytesIO(pdf)).pages[0].extract_text()

    # A historical row: no columns at all on the object, no function printed.
    before = paper()
    assert "PROGRAM" in before, "the form's own label is not ours to rename"
    assert "Ravi Kumar" in before
    for word in ("Mentor", "Delegated approver", "Main Admin"):
        assert word not in before, f"a function was invented for an unstamped row: {word}"

    # The second signature carries the function, and it is the one printed —
    # second-then-first, as `director_name` itself is chosen.
    stamped = paper(first_signed_as="MENTOR", second_signed_as="MAIN_ADMIN")
    assert "Main Admin" in stamped
    assert "PROGRAM" in stamped

    # Rejected at the first step: only one signature exists and it is that one's
    # function that belongs against the name.
    first_only = paper(first_signed_as="DELEGATE", second_signed_as=None)
    assert "Delegated approver" in first_only
