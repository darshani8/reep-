"""B1.2 — a grant says what you may do AND where.

Before this, `admin.students` granted to a faculty member in one college read
every student in the other, and the Governance screen showed one word — the
capability's label — with nothing to say how far it went.

The four things these tests hold down, in order of how quietly each would break:

1. THE EIGHTY EXISTING CALL SITES DO NOT CHANGE MEANING. `target` is opt-in; a
   three-argument call still asks "may you do this at all".
2. A ROLE BASELINE IS UNSCOPED. Scope is a property of a grant, because a grant
   is the thing somebody decided to hand over.
3. BOTH DEPARTMENT POINTERS ARE READ. A student reaches a department through
   their batch OR through `students.department_id`; reading one was a live bug
   in feature overrides before it was a hole here.
4. AN EMPTY REACH IS NOT AN UNRESTRICTED ONE. A grant scoped to a department
   that has since been deleted must see nothing, not everything.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import delete, select

from conftest import requires_db

from app.db import SessionLocal
from app.governance import (
    ancestry_of_student,
    ancestry_of_user,
    granted_reaches,
    reaches_target,
    require_capability,
)
from app.models.cohort import Cohort
from app.models.governance import CapabilityGrant, ScopeLevel, SubjectKind
from app.models.institution import STATUS_ACTIVE, College, Department
from app.models.job import DegreeLevel
from app.models.user import Role, Student, User
from app.seed_roster import SSO_ONLY_PASSWORD_HASH
from app.policies import Reach, scope_filter


# --------------------------------------------------------------- pure logic --


def test_a_programme_wide_grant_covers_every_target():
    """`(None, None)` is the row shape for a grant that hangs on no rung."""
    assert reaches_target([(None, None)], [(ScopeLevel.COLLEGE, "anything")])
    assert reaches_target([(None, None)], [])


def test_a_scoped_grant_covers_a_target_that_hangs_under_it():
    ancestry = [
        (ScopeLevel.STUDENT, "stu"),
        (ScopeLevel.COHORT, "batch"),
        (ScopeLevel.DEPARTMENT, "dept"),
        (ScopeLevel.COLLEGE, "coll"),
    ]
    assert reaches_target([(ScopeLevel.COLLEGE, "coll")], ancestry)
    assert reaches_target([(ScopeLevel.DEPARTMENT, "dept")], ancestry)
    assert reaches_target([(ScopeLevel.STUDENT, "stu")], ancestry)
    assert not reaches_target([(ScopeLevel.DEPARTMENT, "other")], ancestry)
    assert not reaches_target([(ScopeLevel.COLLEGE, "other")], ancestry)


def test_a_scoped_grant_does_not_cover_something_that_hangs_under_nothing():
    """THE UNFILED STATE IS NOT A WAY ROUND EVERY SCOPE.

    A student seated in no batch and filed under no department, or an unfiled
    faculty account, has an empty ancestry. Answering "covered" there would make
    the one state the console shows a list of into a hole in the whole system.
    """
    assert not reaches_target([(ScopeLevel.COLLEGE, "coll")], [])
    assert not reaches_target([(ScopeLevel.DEPARTMENT, "dept")], [])


def test_an_empty_reach_sees_nothing_rather_than_everything():
    """A grant scoped to a department that has since been deleted."""
    assert Reach(everything=False).nothing
    assert not Reach(everything=True).nothing
    assert not Reach(everything=False, departments=frozenset({"d"})).nothing


# ------------------------------------------------------------------ fixtures --


@pytest.fixture
def spine():
    """A college, two departments, a batch in the first, a student in each.

    The second student is seated in NO batch and carries `students.department_id`
    instead — the shape that the cohort-only ancestry could not see.
    """
    made: dict[str, str] = {}
    with SessionLocal() as db:
        tag = uuid.uuid4().hex[:6]
        college = College(code=f"S{tag.upper()}", name="Scope College", status=STATUS_ACTIVE)
        db.add(college)
        db.flush()
        one = Department(college_id=college.id, name="Dept One", code=f"D1{tag}")
        two = Department(college_id=college.id, name="Dept Two", code=f"D2{tag}")
        db.add_all([one, two])
        db.flush()
        batch = Cohort(
            code=f"SC-{tag}", name="Scope Batch", batch_label="2026-28",
            degree_level=DegreeLevel.PG, department_id=one.id,
            start_date=datetime(2026, 8, 1, tzinfo=timezone.utc),
            end_date=datetime(2028, 7, 31, tzinfo=timezone.utc),
        )
        db.add(batch)
        db.flush()

        seated_user = User(
            email=f"seated-{tag}@scope.test", name="Seated", role=Role.STUDENT,
            password_hash=SSO_ONLY_PASSWORD_HASH,
        )
        unseated_user = User(
            email=f"unseated-{tag}@scope.test", name="Unseated", role=Role.STUDENT,
            password_hash=SSO_ONLY_PASSWORD_HASH,
        )
        holder = User(
            email=f"holder-{tag}@scope.test", name="Holder", role=Role.MENTOR,
            department_id=two.id, password_hash=SSO_ONLY_PASSWORD_HASH,
        )
        db.add_all([seated_user, unseated_user, holder])
        db.flush()
        seated = Student(user_id=seated_user.id, usn=f"SEAT{tag}", cohort_id=batch.id)
        # No cohort. Its department pointer is the ONLY path to a department.
        unseated = Student(user_id=unseated_user.id, usn=f"UNSE{tag}", department_id=one.id)
        db.add_all([seated, unseated])
        db.commit()
        made = {
            "college": college.id, "dept_one": one.id, "dept_two": two.id,
            "batch": batch.id, "seated": seated.id, "unseated": unseated.id,
            "holder": holder.id, "seated_user": seated_user.id,
            "unseated_user": unseated_user.id,
        }

    yield made

    with SessionLocal() as db:
        db.execute(delete(CapabilityGrant).where(CapabilityGrant.subject_user_id == made["holder"]))
        db.execute(delete(Student).where(Student.id.in_([made["seated"], made["unseated"]])))
        db.execute(delete(User).where(User.id.in_(
            [made["seated_user"], made["unseated_user"], made["holder"]]
        )))
        db.execute(delete(Cohort).where(Cohort.id == made["batch"]))
        db.execute(delete(Department).where(Department.id.in_([made["dept_one"], made["dept_two"]])))
        db.execute(delete(College).where(College.id == made["college"]))
        db.commit()


def _grant(db, user_id: str, key: str, level: ScopeLevel | None, target_id: str | None) -> str:
    row = CapabilityGrant(
        capability=key, subject_kind=SubjectKind.USER, subject_user_id=user_id,
        scope_level=level, scope_id=target_id, reason="a test grant, twenty characters plus",
    )
    db.add(row)
    db.commit()
    return row.id


# ------------------------------------------------------------------- the DB --


@requires_db
def test_an_unseated_student_still_hangs_under_their_department(spine):
    """THE BUG THIS TASK FOUND, pinned.

    `students.department_id` (migration 31f7a4c60b12) is the only path to a
    department for a student who named one on the registration form and has not
    been seated in a batch — which is every student at a college that has not
    built its batches yet. The ancestry read the cohort route alone, so anything
    hung on a department reached the seated students in it and silently missed
    the unseated ones. Feature overrides had that hole before scope existed.
    """
    with SessionLocal() as db:
        seated = dict(ancestry_of_student(db, spine["seated"]))
        unseated = dict(ancestry_of_student(db, spine["unseated"]))

    assert seated[ScopeLevel.DEPARTMENT] == spine["dept_one"]
    assert seated[ScopeLevel.COHORT] == spine["batch"]
    assert seated[ScopeLevel.COLLEGE] == spine["college"]

    assert unseated[ScopeLevel.DEPARTMENT] == spine["dept_one"], (
        "the unseated student lost their department — the cohort-only ancestry"
    )
    assert unseated[ScopeLevel.COLLEGE] == spine["college"]
    assert ScopeLevel.COHORT not in unseated, "an unseated student has no batch"


@requires_db
def test_a_faculty_account_hangs_under_its_department_and_college(spine):
    with SessionLocal() as db:
        assert dict(ancestry_of_user(db, spine["holder"])) == {
            ScopeLevel.DEPARTMENT: spine["dept_two"],
            ScopeLevel.COLLEGE: spine["college"],
        }


@requires_db
def test_an_unfiled_faculty_account_hangs_under_nothing(spine):
    """`users.department_id IS NULL` is a first-class state on the Faculty
    screen, not a broken row. It hangs under nothing, so no scoped grant
    reaches it — which is why filing them is the Main Admin's work."""
    with SessionLocal() as db:
        unfiled = User(
            email=f"unfiled-{uuid.uuid4().hex[:6]}@scope.test", name="U", role=Role.MENTOR,
            password_hash=SSO_ONLY_PASSWORD_HASH,
        )
        db.add(unfiled)
        db.commit()
        unfiled_id = unfiled.id
    try:
        with SessionLocal() as db:
            assert ancestry_of_user(db, unfiled_id) == []
    finally:
        with SessionLocal() as db:
            db.execute(delete(User).where(User.id == unfiled_id))
            db.commit()


@requires_db
def test_a_three_argument_call_still_asks_only_whether_you_hold_it(spine):
    """The compatibility guarantee this whole change rests on: eighty existing
    call sites pass three positional arguments and must keep their meaning."""
    session = {"role": "MENTOR", "userId": spine["holder"]}
    with SessionLocal() as db:
        with pytest.raises(HTTPException) as refused:
            require_capability(db, session, "admin.students")
        assert refused.value.status_code == 403

        _grant(db, spine["holder"], "admin.students", ScopeLevel.DEPARTMENT, spine["dept_two"])
        # Holds it somewhere -> the unscoped question answers yes, exactly as before.
        require_capability(db, session, "admin.students")


@requires_db
def test_a_scoped_grant_refuses_a_student_outside_it(spine):
    session = {"role": "MENTOR", "userId": spine["holder"]}
    with SessionLocal() as db:
        _grant(db, spine["holder"], "admin.students", ScopeLevel.DEPARTMENT, spine["dept_two"])
        inside = ancestry_of_user(db, spine["holder"])
        outside = ancestry_of_student(db, spine["seated"])

        require_capability(db, session, "admin.students", target=inside)
        with pytest.raises(HTTPException) as refused:
            require_capability(db, session, "admin.students", target=outside)
        assert refused.value.status_code == 403
        assert "does not reach" in refused.value.detail


@requires_db
def test_the_main_admin_is_not_narrowed_by_scope(spine):
    """A baseline capability is unscoped. The Main Admin's baseline is every
    programme key and the programme is the job."""
    session = {"role": "ADMIN", "userId": "whoever"}
    with SessionLocal() as db:
        require_capability(db, session, "admin.students", target=ancestry_of_student(db, spine["seated"]))
        assert scope_filter(db, session, "admin.students").everything


@requires_db
def test_the_reach_of_a_department_grant_covers_both_kinds_of_student(spine):
    """The list side of the same bug: a holder scoped to Dept One sees the
    seated student AND the unseated one, because both hang under it."""
    session = {"role": "MENTOR", "userId": spine["holder"]}
    with SessionLocal() as db:
        _grant(db, spine["holder"], "admin.students", ScopeLevel.DEPARTMENT, spine["dept_one"])
        reach = scope_filter(db, session, "admin.students")
        assert not reach.everything and not reach.nothing
        assert reach.departments == frozenset({spine["dept_one"]})

        visible = set(db.scalars(select(Student.id).where(Student.id.in_(reach.student_ids(db)))).all())
    assert spine["seated"] in visible, "the seated student is in the granted department"
    assert spine["unseated"] in visible, (
        "the unseated student hangs under the same department through their own pointer"
    )


@requires_db
def test_a_college_grant_reaches_every_department_under_it(spine):
    session = {"role": "MENTOR", "userId": spine["holder"]}
    with SessionLocal() as db:
        _grant(db, spine["holder"], "admin.students", ScopeLevel.COLLEGE, spine["college"])
        reach = scope_filter(db, session, "admin.students")
        visible = set(db.scalars(select(Student.id).where(Student.id.in_(reach.student_ids(db)))).all())
        staff = set(db.scalars(select(User.id).where(User.id.in_(reach.user_ids(db)))).all())
    assert {spine["seated"], spine["unseated"]} <= visible
    assert spine["holder"] in staff, "a college grant covers faculty filed under it"


@requires_db
def test_two_grants_are_more_reach_than_one(spine):
    """Scoped grants accumulate. A holder with a department grant and a college
    grant sees both, because two grants are more reach than one."""
    session = {"role": "MENTOR", "userId": spine["holder"]}
    with SessionLocal() as db:
        _grant(db, spine["holder"], "admin.students", ScopeLevel.DEPARTMENT, spine["dept_one"])
        _grant(db, spine["holder"], "admin.students", ScopeLevel.COHORT, spine["batch"])
        reach = scope_filter(db, session, "admin.students")
    assert reach.departments == frozenset({spine["dept_one"]})
    assert reach.cohorts == frozenset({spine["batch"]})


@requires_db
def test_an_expired_or_revoked_grant_reaches_nothing(spine):
    session = {"role": "MENTOR", "userId": spine["holder"]}
    with SessionLocal() as db:
        row = CapabilityGrant(
            capability="admin.students", subject_kind=SubjectKind.USER,
            subject_user_id=spine["holder"], scope_level=ScopeLevel.COLLEGE,
            scope_id=spine["college"], reason="expired before it was ever used",
            expires_at=datetime.now(timezone.utc) - timedelta(days=1),
        )
        db.add(row)
        db.commit()
        assert granted_reaches(db, spine["holder"], "admin.students") == []
        assert scope_filter(db, session, "admin.students").nothing
