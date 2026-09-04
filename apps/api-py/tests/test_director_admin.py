"""The director/admin surface the dashboard's Programme and Catalogue groups sit
on, and the mentor-scoped document stream the verification queue needs.

Everything here is @requires_db (real users, real rows). The rules pinned:

  * Every new /director/* read is DIRECTOR/ADMIN. A MENTOR gets 403 — not a
    narrowed view. Mentor assignment in particular CANNOT be mentor-scoped:
    rule 2 narrows a MENTOR to the students already in their group, and the
    whole job of that screen is to move a student out of one.
  * `PUT /director/students/{id}/mentor` moves a student, and `mentor_id: null`
    unassigns. "No mentor" is a real state a director sets deliberately, and
    rule 2 must keep reading it as "in nobody's group".
  * `GET /mentor/uploads/{id}/file` streams a pending document to its REVIEWER,
    scoped by rule 2 and flattened to 404 outside that scope — so the response
    cannot be used to probe which upload ids exist.
  * `GET /director/badge-catalogue` is read off the in-code BADGES tuple, so a
    code it offers is never one the certification write path rejects.
"""

import uuid

import pytest
from conftest import requires_db

from app.db import SessionLocal
from app.models.badge import BADGES
from app.models.user import Mentor, Role, Student, User

# Smallest thing document_store's magic-byte sniff accepts as a PDF.
_PDF = b"%PDF-1.4\n%%EOF\n"

_DIRECTOR_READS = [
    "/api/director/mentors",
    "/api/director/students",
    "/api/director/courses",
    "/api/director/badge-catalogue",
]


@pytest.fixture
def mentor_group(make_user):
    """A MENTOR account that actually has a Mentor row, plus its id.

    `make_user` creates the User only; a MENTOR with no Mentor row sees nobody
    by rule 2, which is a different test from these. The session claims are a
    signed snapshot, so the caller re-logs in where it needs `mentorId`.
    """
    staff = make_user("dir-mentor", Role.MENTOR)
    with SessionLocal() as db:
        mentor = Mentor(user_id=staff.user_id)
        db.add(mentor)
        db.commit()
        mentor_id = mentor.id
    yield staff, mentor_id
    with SessionLocal() as db:
        db.query(Mentor).filter(Mentor.id == mentor_id).delete()
        db.commit()


@requires_db
@pytest.mark.parametrize("path", _DIRECTOR_READS)
def test_mentor_is_refused_every_director_read(client, make_user, path):
    mentor = make_user("dir-gate", Role.MENTOR)
    assert client.get(path, headers=mentor.headers).status_code == 403


@requires_db
@pytest.mark.parametrize("path", _DIRECTOR_READS)
def test_student_is_refused_every_director_read(client, make_user, path):
    student = make_user("dir-gate-stud", Role.STUDENT)
    assert client.get(path, headers=student.headers).status_code == 403


@requires_db
def test_director_reads_the_roster_and_the_mentor_groups(client, make_user, mentor_group):
    director = make_user("dir-read", Role.DIRECTOR)
    _staff, mentor_id = mentor_group

    mentors = client.get("/api/director/mentors", headers=director.headers)
    assert mentors.status_code == 200, mentors.text
    assert mentor_id in {m["id"] for m in mentors.json()}
    assert all("student_count" in m for m in mentors.json())

    roster = client.get("/api/director/students", headers=director.headers)
    assert roster.status_code == 200, roster.text
    # Every roster row carries the mentor NAME as well as the id, and NULL is a
    # legitimate value for both — the screen renders it as "Unassigned", never
    # as a blank cell.
    assert all({"mentor_id", "mentor_name"} <= set(row) for row in roster.json())


@requires_db
def test_director_assigns_and_unassigns_a_mentor(client, make_user, mentor_group):
    director = make_user("dir-assign", Role.DIRECTOR)
    student = make_user("dir-assign-stud", Role.STUDENT)
    _staff, mentor_id = mentor_group

    with SessionLocal() as db:
        student_id = db.query(Student).filter(Student.user_id == student.user_id).one().id

    assigned = client.put(
        f"/api/director/students/{student_id}/mentor",
        headers=director.headers,
        json={"mentor_id": mentor_id},
    )
    assert assigned.status_code == 200, assigned.text
    assert assigned.json()["mentor_id"] == mentor_id
    assert assigned.json()["mentor_name"]

    # Unassigning is an explicit null, not a DELETE: "in nobody's group" is a
    # state a director chooses, and it must round-trip as one.
    cleared = client.put(
        f"/api/director/students/{student_id}/mentor",
        headers=director.headers,
        json={"mentor_id": None},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["mentor_id"] is None
    assert cleared.json()["mentor_name"] is None

    unassigned = client.get(
        "/api/director/students?unassigned_only=true", headers=director.headers
    )
    assert student_id in {row["id"] for row in unassigned.json()}


@requires_db
def test_assigning_an_unknown_mentor_or_student_is_404(client, make_user, mentor_group):
    director = make_user("dir-assign-404", Role.DIRECTOR)
    student = make_user("dir-assign-404-stud", Role.STUDENT)
    _staff, mentor_id = mentor_group
    with SessionLocal() as db:
        student_id = db.query(Student).filter(Student.user_id == student.user_id).one().id

    assert (
        client.put(
            f"/api/director/students/{uuid.uuid4().hex}/mentor",
            headers=director.headers,
            json={"mentor_id": mentor_id},
        ).status_code
        == 404
    )
    assert (
        client.put(
            f"/api/director/students/{student_id}/mentor",
            headers=director.headers,
            json={"mentor_id": uuid.uuid4().hex},
        ).status_code
        == 404
    )


@requires_db
def test_a_mentor_cannot_reassign_a_student(client, make_user, mentor_group):
    """The one that matters. A MENTOR reaching this endpoint could move a
    student out of another mentor's group — or into their own — which is
    exactly the decision rule 2 reserves for a director."""
    mentor = make_user("dir-assign-gate", Role.MENTOR)
    student = make_user("dir-assign-gate-stud", Role.STUDENT)
    _staff, mentor_id = mentor_group
    with SessionLocal() as db:
        student_id = db.query(Student).filter(Student.user_id == student.user_id).one().id

    assert (
        client.put(
            f"/api/director/students/{student_id}/mentor",
            headers=mentor.headers,
            json={"mentor_id": mentor_id},
        ).status_code
        == 403
    )


@requires_db
def test_badge_catalogue_matches_the_in_code_tuple(client, make_user):
    director = make_user("dir-badges", Role.DIRECTOR)
    r = client.get("/api/director/badge-catalogue", headers=director.headers)
    assert r.status_code == 200, r.text
    # The catalogue is CODE, so the endpoint is the tuple and cannot drift from
    # the dict the certification write path validates against.
    assert [b["code"] for b in r.json()] == [b.code for b in BADGES]
    assert {b["staff_awarded"] for b in r.json()} == {True, False}


@requires_db
def test_reviewer_can_stream_a_pending_document_and_outsiders_get_404(client, make_user):
    """Without this route the review queue asked a mentor to verify or reject a
    file they could not open — the student's own download is scoped to the
    student's rows."""
    student = make_user("upl-owner", Role.STUDENT)
    director = make_user("upl-director", Role.DIRECTOR)
    stranger = make_user("upl-stranger", Role.MENTOR)

    up = client.post(
        "/api/student/uploads",
        headers=student.headers,
        files={"file": ("proof.pdf", _PDF, "application/pdf")},
        data={"kind": "CERTIFICATE_PROOF", "title": "Proof"},
    )
    assert up.status_code in (200, 201), up.text
    upload_id = up.json()["id"]

    # DIRECTOR/ADMIN see the whole programme, so the stream opens.
    got = client.get(f"/api/mentor/uploads/{upload_id}/file", headers=director.headers)
    assert got.status_code == 200, got.text
    assert got.content == _PDF

    # A MENTOR with no group sees NOBODY — and the refusal is a flat 404, so it
    # says nothing about whether that upload id exists.
    assert (
        client.get(f"/api/mentor/uploads/{upload_id}/file", headers=stranger.headers).status_code
        == 404
    )
    # A student is not staff at all.
    assert (
        client.get(f"/api/mentor/uploads/{upload_id}/file", headers=student.headers).status_code
        == 403
    )

    client.delete(f"/api/student/uploads/{upload_id}", headers=student.headers)
