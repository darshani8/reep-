"""The Main Admin's CRUD over students - one at a time and a batch at a time.

Pinned: the gate is the `admin.students` capability; creating a student
applies registration's three guards in admin wording and sets no password;
edits seat, unseat, assign faculty (creating their group), and refuse a
taken USN or address; delete takes the student and everything under them
and leaves the fact on the audit trail; a batch action is the single action
repeated; and a batch is deleted only once it is empty.

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


# ------------------------------------------------------------ the gate --


@requires_db
def test_the_roster_is_a_capability(client, make_user, chain):
    student = make_user("as-stu")
    mentor = make_user("as-men", Role.MENTOR)
    assert client.get(API, headers=chain["headers"]).status_code == 200
    assert client.get(API, headers=student.headers).status_code == 403
    r = client.get(API, headers=mentor.headers)
    assert r.status_code == 403 and "Students" in r.text, "the 403 names what to ask for"
    assert client.post(API, headers=mentor.headers, json={"name": "X", "email": _email("gate")}).status_code == 403
    assert client.delete(f"/api/admin/cohorts/{chain['cohort']['id']}", headers=student.headers).status_code == 403


# --------------------------------------------------------- create + edit --


@requires_db
def test_create_edit_and_the_three_guards(client, make_user, chain, swept):
    emails, faculty_ids = swept
    h = chain["headers"]
    cohort_id = chain["cohort"]["id"]

    # Off the college domain: refused, and nothing is minted.
    r = client.post(API, headers=h, json={"name": "Outsider", "email": "someone@gmail.com"})
    assert r.status_code == 422 and "college domain" in r.text
    with SessionLocal() as db:
        assert db.scalar(select(User).where(User.email == "someone@gmail.com")) is None

    # A staff address: refused.
    mentor = make_user("as-fac", Role.MENTOR)
    r = client.post(API, headers=h, json={"name": "Not A Student", "email": mentor.email})
    assert r.status_code == 409 and "MENTOR account" in r.text

    # Created: seated, no password, a profile row, on the trail.
    email = _email("one")
    emails.append(email)
    r = client.post(API, headers=h, json={
        "name": "  Asha   Rao ", "email": email.upper(), "usn": "1bg26adm01", "cohort_id": cohort_id,
        "current_stage": "excel", "current_semester": 2,
    })
    assert r.status_code == 201, r.text
    row = r.json()
    assert row["name"] == "Asha Rao" and row["email"] == email and row["usn"] == "1BG26ADM01"
    assert row["cohort_id"] == cohort_id and "Chain Batch" in row["batch"] and row["department"] == "Chain Department"
    assert row["current_stage"] == "EXCEL" and row["current_semester"] == 2
    assert row["mentor_user_id"] is None and row["last_login_at"] is None
    sid = row["student_id"]
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == email))
        assert user.role is Role.STUDENT and user.password_hash == "google-only", "no password: Google, like an approved applicant"
        assert db.scalar(select(StudentProfile).where(StudentProfile.student_id == sid)) is not None
        ev = db.scalar(select(AuditEvent).where(AuditEvent.entity_type == "student", AuditEvent.entity_id == sid))
        assert ev.action == "CREATE" and ev.after_json["usn"] == "1BG26ADM01"

    # The same address or USN again: refused.
    assert client.post(API, headers=h, json={"name": "Again", "email": email}).status_code == 409
    other = _email("two")
    emails.append(other)
    r = client.post(API, headers=h, json={"name": "Other", "email": other, "usn": "1BG26ADM01"})
    assert r.status_code == 409 and "USN" in r.text
    assert client.post(API, headers=h, json={"name": "Other", "email": other, "current_stage": "graduated"}).status_code == 422

    # Listed and searchable.
    assert any(x["student_id"] == sid for x in client.get(f"{API}?cohort_id={cohort_id}", headers=h).json())
    assert [x["student_id"] for x in client.get(f"{API}?q=1bg26adm", headers=h).json()] == [sid]
    assert not any(x["student_id"] == sid for x in client.get(f"{API}?unseated=true", headers=h).json())

    # Edit: rename, semester, unseat, faculty assignment creates the group.
    faculty_ids.append(mentor.user_id)
    r = client.patch(f"{API}/{sid}", headers=h, json={
        "name": "Asha R", "current_semester": 3, "cohort_id": None, "mentor_user_id": mentor.user_id,
    })
    assert r.status_code == 200, r.text
    row = r.json()
    assert row["name"] == "Asha R" and row["current_semester"] == 3 and row["cohort_id"] is None
    assert row["mentor_user_id"] == mentor.user_id and row["mentor_name"] == mentor_name(mentor.user_id)
    assert any(x["student_id"] == sid for x in client.get(f"{API}?unseated=true", headers=h).json())
    # The faculty member now sees exactly this student (rule 2 opened by the assignment).
    assert [m["student_id"] for m in client.get("/api/mentor/mentees", headers=mentor.headers).json()] == [sid]

    # Seat again, release the faculty member, change the address (profile follows).
    new_email = _email("renamed")
    emails.append(new_email)
    r = client.patch(f"{API}/{sid}", headers=h, json={"cohort_id": cohort_id, "mentor_user_id": None, "email": new_email})
    assert r.status_code == 200, r.text
    assert r.json()["cohort_id"] == cohort_id and r.json()["mentor_user_id"] is None and r.json()["email"] == new_email
    with SessionLocal() as db:
        assert db.scalar(select(StudentProfile.email).where(StudentProfile.student_id == sid)) == new_email
    assert client.get("/api/mentor/mentees", headers=mentor.headers).json() == []

    # Guards on edit: a taken address, a taken USN, an off-domain address, a bad stage.
    assert client.patch(f"{API}/{sid}", headers=h, json={"email": mentor.email}).status_code == 409
    assert client.patch(f"{API}/{sid}", headers=h, json={"email": "x@gmail.com"}).status_code == 422
    assert client.patch(f"{API}/{sid}", headers=h, json={"current_stage": "nope"}).status_code == 422
    assert client.patch(f"{API}/no-such-student", headers=h, json={"name": "X"}).status_code == 404
    assert client.patch(f"{API}/{sid}", headers=h, json={"mentor_user_id": "no-such-user"}).status_code == 404


def mentor_name(user_id: str) -> str:
    with SessionLocal() as db:
        return db.scalar(select(User.name).where(User.id == user_id))


# --------------------------------------------------------------- delete --


@requires_db
def test_delete_takes_the_student_and_everything_under_them(client, chain, swept):
    emails, _ = swept
    h = chain["headers"]
    email = _email("gone")
    emails.append(email)
    sid = client.post(API, headers=h, json={"name": "Going Away", "email": email}).json()["student_id"]
    with SessionLocal() as db:
        uid = db.scalar(select(User.id).where(User.email == email))
        db.add(LoginDay(user_id=uid, day=__import__("datetime").date(2026, 9, 1)))
        db.commit()

    assert client.delete(f"{API}/{sid}", headers=h).status_code == 204
    assert client.delete(f"{API}/{sid}", headers=h).status_code == 404
    with SessionLocal() as db:
        assert db.get(Student, sid) is None
        assert db.scalar(select(User).where(User.email == email)) is None
        assert db.scalar(select(StudentProfile).where(StudentProfile.student_id == sid)) is None
        assert db.scalar(select(LoginDay).where(LoginDay.user_id == uid)) is None
        ev = db.scalars(select(AuditEvent).where(AuditEvent.entity_type == "student", AuditEvent.entity_id == sid)).all()
        assert {e.action for e in ev} == {"CREATE", "DELETE"}
        gone = next(e for e in ev if e.action == "DELETE")
        assert gone.before_json["email"] == email and gone.after_json is None, "the trail still reads the row that is gone"


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

    sids = []
    for i in range(2):
        email = _email(f"bulk{i}")
        emails.append(email)
        sids.append(client.post(API, headers=h, json={"name": f"Bulk {i}", "email": email, "cohort_id": a}).json()["student_id"])
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

    # Delete every student in the new batch, then the batch itself.
    r = client.post(f"/api/admin/cohorts/{b}/students/bulk", headers=h, json={"action": "delete"})
    assert r.json() == {"action": "delete", "affected": 2}
    with SessionLocal() as db:
        assert all(db.get(Student, s) is None for s in sids)
        assert db.scalar(select(AuditEvent).where(AuditEvent.entity_type == "cohort", AuditEvent.entity_id == b, AuditEvent.action == "STUDENTS_DELETE")) is not None
    assert client.get("/api/mentor/mentees", headers=faculty.headers).json() == []
    assert client.delete(f"/api/admin/cohorts/{b}", headers=h).status_code == 204
    tracker["cohorts"].remove(b)
    assert client.delete(f"/api/admin/cohorts/{b}", headers=h).status_code == 404
