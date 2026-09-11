"""The Main Admin's EDITS to students - one at a time and a batch at a time.

Pinned: the gate is the `admin.students` capability; CREATE AND DELETE ARE
GONE and stay gone (2026-09-10 - a student account is minted only by approving
a registration, and removing people is `app.purge_people`); edits seat, unseat,
assign faculty (creating their group), and refuse a taken USN or address; a
batch action is the single action repeated; and a batch is deleted only once
it is empty.

Fixtures borrowed by name from test_admin_institution: `chain` (a College ->
Department -> Batch built through the API), `tracker`, `director`, `_code`.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete, select

from conftest import requires_db
from test_admin_institution import (  # noqa: F401 - fixtures by name
    _code,
    chain,
    director,
    tracker,
)

from app.db import SessionLocal
from app.models.redesign import AuditEvent
from app.models.student_profile import StudentProfile
from app.models.user import LoginDay, Mentor, Role, Student, User

API = "/api/admin/students"
TAG = uuid.uuid4().hex[:6]


@pytest.fixture
def swept():
    """Students created THROUGH the API are new users make_user knows nothing
    about; every email created here is removed afterwards whatever happened,
    and a faculty group made by an assignment goes with it."""
    emails: list[str] = []
    faculty_user_ids: list[str] = []
    yield emails, faculty_user_ids
    with SessionLocal() as db:
        for fid in faculty_user_ids:
            group = db.scalar(select(Mentor).where(Mentor.user_id == fid))
            if group is not None:
                for st in db.scalars(select(Student).where(Student.mentor_id == group.id)).all():
                    st.mentor_id = None
                db.flush()
                db.delete(group)
        for email in emails:
            user = db.scalar(select(User).where(User.email == email))
            if user is not None:
                sid = db.scalar(select(Student.id).where(Student.user_id == user.id))
                if sid:
                    db.execute(delete(AuditEvent).where(AuditEvent.entity_type == "student", AuditEvent.entity_id == sid))
                db.execute(delete(LoginDay).where(LoginDay.user_id == user.id))
                db.execute(delete(Student).where(Student.user_id == user.id))
                db.execute(delete(User).where(User.id == user.id))
        db.commit()


def _email(label: str) -> str:
    return f"adm-stu-{label}-{TAG}@bgscet.ac.in"


def _seed_student(emails: list[str], email: str, *, cohort_id: str | None = None,
                  usn: str | None = None, name: str = "Seeded Student") -> str:
    """A student row to EDIT, written directly.

    There is no POST /admin/students any more, so these tests cannot mint their
    subject through the API. Writing the three rows here mirrors exactly what
    registration's `_provision_student` writes - User with the unusable
    password sentinel, Student, StudentProfile - which is the only path that
    creates a student in the product.
    """
    emails.append(email)
    with SessionLocal() as db:
        user = User(email=email, name=name, role=Role.STUDENT, password_hash="google-only")
        db.add(user)
        db.flush()
        student = Student(user_id=user.id, usn=usn, cohort_id=cohort_id)
        db.add(student)
        db.flush()
        db.add(StudentProfile(student_id=student.id, email=email))
        db.commit()
        return student.id


# ------------------------------------------------------------ the gate --


@requires_db
def test_the_roster_is_a_capability(client, make_user, chain):
    student = make_user("as-stu")
    mentor = make_user("as-men", Role.MENTOR)
    assert client.get(API, headers=chain["headers"]).status_code == 200
    assert client.get(API, headers=student.headers).status_code == 403
    r = client.get(API, headers=mentor.headers)
    assert r.status_code == 403 and "Students" in r.text, "the 403 names what to ask for"
    # POST is gone entirely, so the capability cannot be what refuses it: 405
    # is the honest answer and `test_there_is_no_way_to_mint_or_erase_a_student`
    # below is what pins the absence.
    assert client.post(API, headers=mentor.headers, json={"name": "X", "email": _email("gate")}).status_code == 405
    assert client.delete(f"/api/admin/cohorts/{chain['cohort']['id']}", headers=student.headers).status_code == 403


# ---------------------------------------------------------------- edit --


@requires_db
def test_edit_seats_reseats_and_applies_the_guards(client, make_user, chain, swept):
    emails, faculty_ids = swept
    h = chain["headers"]
    cohort_id = chain["cohort"]["id"]
    sid = _seed_student(emails, _email("edit"), usn="1BG26EDT01")

    # Seat them in the batch.
    r = client.patch(f"{API}/{sid}", headers=h, json={"cohort_id": cohort_id})
    assert r.status_code == 200, r.text
    assert r.json()["cohort_id"] == cohort_id

    # Off the college domain: refused on an EDIT too, and the row is untouched.
    bad = client.patch(f"{API}/{sid}", headers=h, json={"email": "someone@gmail.com"})
    assert bad.status_code == 422 and "college domain" in bad.text
    with SessionLocal() as db:
        assert db.scalar(select(User).where(User.email == "someone@gmail.com")) is None

    # An address belonging to a STAFF account: refused. Rule 2 edited by a form.
    staff = make_user("as-staff-edit", Role.MENTOR)
    clash = client.patch(f"{API}/{sid}", headers=h, json={"email": staff.email})
    assert clash.status_code == 409, clash.text

    # A USN already held by somebody else: refused.
    other = _seed_student(emails, _email("edit2"), usn="1BG26EDT02")
    dup = client.patch(f"{API}/{sid}", headers=h, json={"usn": "1BG26EDT02"})
    assert dup.status_code == 409, dup.text
    assert other  # the other student is why

    # Assigning faculty creates their group on first assignment.
    faculty = make_user("as-fac-edit", Role.MENTOR)
    faculty_ids.append(faculty.user_id)
    r = client.patch(f"{API}/{sid}", headers=h, json={"mentor_user_id": faculty.user_id})
    assert r.status_code == 200, r.text
    with SessionLocal() as db:
        group = db.scalar(select(Mentor).where(Mentor.user_id == faculty.user_id))
        assert group is not None, "the group is created on the first assignment"
        assert db.get(Student, sid).mentor_id == group.id

    # Unseating is a real edit, not a delete.
    r = client.patch(f"{API}/{sid}", headers=h, json={"cohort_id": None})
    assert r.status_code == 200 and r.json()["cohort_id"] is None


# ------------------------------------------------- the two absent doors --


@requires_db
def test_there_is_no_way_to_mint_or_erase_a_student(client, chain, swept):
    """CREATE AND DELETE ARE GONE, and this is the guard that keeps them gone.

    A student account is minted by exactly one path - approving a registration,
    which provisions the row and emails the applicant a setup link they must
    walk before the account is usable. An admin-side create was a second way
    onto a roster that IS the access control, with no application to read, no
    reason recorded and no mailbox proof. An admin-side delete erased marks,
    attendance, uploads, interviews and mentor notes behind a browser confirm,
    from a screen whose other buttons only move somebody between batches.

    Asserted as 405 (the route does not exist), never as 403 - a capability
    refusal would mean the endpoint is still there waiting for a grant.
    """
    emails, _ = swept
    h = chain["headers"]
    sid = _seed_student(emails, _email("absent"))

    minted = client.post(API, headers=h, json={"name": "New", "email": _email("new")})
    assert minted.status_code == 405, "POST /admin/students must not exist"

    erased = client.delete(f"{API}/{sid}", headers=h)
    assert erased.status_code == 405, "DELETE /admin/students/{id} must not exist"

    with SessionLocal() as db:
        assert db.get(Student, sid) is not None, "and the student is still there"


# ---------------------------------------------------------- batch level --


@requires_db
def test_a_batch_action_is_the_single_action_repeated_and_a_batch_deletes_only_empty(client, make_user, chain, tracker, swept):
    emails, faculty_ids = swept
    h = chain["headers"]
    a = chain["cohort"]["id"]
    b = client.post(
        f"/api/admin/departments/{chain['department']['id']}/cohorts", headers=h,
        json={"code": _code("BLK"), "name": "Bulk Batch", "batch_label": "2026-28", "degree_level": "PG",
              "entry_date": "2026-08-01", "expected_completion": "2028-07-31"},
    ).json()["id"]
    tracker["cohorts"].append(b)
    faculty = make_user("as-bulk-fac", Role.MENTOR)
    faculty_ids.append(faculty.user_id)

    sids = [
        _seed_student(emails, _email(f"bulk{i}"), cohort_id=a, name=f"Bulk {i}")
        for i in range(2)
    ]
    bulk_a = f"/api/admin/cohorts/{a}/students/bulk"

    # Semester, stage and faculty for the whole batch.
    assert client.post(bulk_a, headers=h, json={"action": "semester", "current_semester": 4}).json() == {"action": "semester", "affected": 2}
    assert client.post(bulk_a, headers=h, json={"action": "stage", "current_stage": "elevate"}).json()["affected"] == 2
    assert client.post(bulk_a, headers=h, json={"action": "mentor", "mentor_user_id": faculty.user_id}).json()["affected"] == 2
    rows = {x["student_id"]: x for x in client.get(f"{API}?cohort_id={a}", headers=h).json()}
    assert all(rows[s]["current_semester"] == 4 and rows[s]["current_stage"] == "ELEVATE" and rows[s]["mentor_user_id"] == faculty.user_id for s in sids)
    assert sorted(m["student_id"] for m in client.get("/api/mentor/mentees", headers=faculty.headers).json()) == sorted(sids)

    # Bad batch actions are refused before anything moves.
    assert client.post(bulk_a, headers=h, json={"action": "move"}).status_code == 422
    assert client.post(bulk_a, headers=h, json={"action": "move", "cohort_id": a}).status_code == 422
    assert client.post(bulk_a, headers=h, json={"action": "move", "cohort_id": "no-such-batch"}).status_code == 404
    assert client.post(bulk_a, headers=h, json={"action": "promote"}).status_code == 422

    # A batch with people in it does not delete; moving them empties it.
    r = client.delete(f"/api/admin/cohorts/{a}", headers=h)
    assert r.status_code == 409 and "2 students are seated" in r.text
    assert client.post(bulk_a, headers=h, json={"action": "move", "cohort_id": b}).json()["affected"] == 2
    assert client.get(f"{API}?cohort_id={a}", headers=h).json() == []
    assert sorted(x["student_id"] for x in client.get(f"{API}?cohort_id={b}", headers=h).json()) == sorted(sids)

    # THE BULK "delete" ACTION IS GONE TOO (2026-09-10). It erased N students -
    # marks, attendance, uploads, interviews, mentor notes - from a dropdown
    # sitting between "set semester" and "move". Refused as 422 by the action
    # Literal, never quietly ignored, so a client still sending it is told.
    dead = client.post(f"/api/admin/cohorts/{b}/students/bulk", headers=h, json={"action": "delete"})
    assert dead.status_code == 422, "bulk delete must not exist"
    with SessionLocal() as db:
        assert all(db.get(Student, sid) is not None for sid in sids), "and nobody was erased"

    # A batch is emptied by MOVING its students out, and only then deleted.
    assert client.post(f"/api/admin/cohorts/{b}/students/bulk", headers=h,
                       json={"action": "move", "cohort_id": a}).json()["affected"] == 2
    assert client.delete(f"/api/admin/cohorts/{b}", headers=h).status_code == 204
    tracker["cohorts"].remove(b)
    assert client.delete(f"/api/admin/cohorts/{b}", headers=h).status_code == 404
