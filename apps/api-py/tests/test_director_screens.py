"""The admin screens' read models and the two Jobs-sheet writes.

Everything here is @requires_db. What is pinned:

  * every new director endpoint is DIRECTOR/ADMIN only — a student is refused
    (rule 2: the scope is decided by role);
  * /director/mentor-load carries the mentor's institutional identity and the
    programme's mentee capacity, so the assignment screen never invents a "20";
  * a student's weekly series is six weeks long, attendance is None (not 0) in
    a week with no sessions, and "Download CV" 404s until a resume exists;
  * POST /director/jobs publishes to the same table both boards read, and
    DELETE refuses once a student has applied — an application is part of the
    student's record;
  * /leaves/history obeys the same scope rule as /leaves/pending: a MENTOR with
    no group sees nobody.
"""

import uuid
from datetime import datetime, timezone

from conftest import requires_db
from sqlalchemy import delete, select

from app.db import SessionLocal
from app.models.badge import ApprovedCertification
from app.models.job import Job, JobApplication
from app.models.resume import Resume
from app.models.user import Role, Student


def _student_id(user_id: str) -> str:
    with SessionLocal() as db:
        return db.scalar(select(Student.id).where(Student.user_id == user_id))


@requires_db
def test_analytics_summary_is_director_only_and_shaped(client, make_user):
    student = make_user("an-stud", Role.STUDENT)
    director = make_user("an-dir", Role.DIRECTOR)

    assert client.get("/api/director/analytics-summary", headers=student.headers).status_code == 403

    r = client.get("/api/director/analytics-summary", headers=director.headers)
    assert r.status_code == 200, r.text
    body = r.json()
    for key in (
        "students_total",
        "pending_registrations",
        "mentors_total",
        "badges_awarded",
        "evidence_awaiting_verification",
        "placed_students",
        "approved_offers",
    ):
        assert isinstance(body[key], int) and body[key] >= 0
    # The fixture just created a student, so the cohort is not empty.
    assert body["students_total"] >= 1
    assert 0 <= body["placement_percent"] <= 100
    # An average over nobody is None, never 0.
    if body["mentors_total"] == 0:
        assert body["mentees_per_mentor"] is None
    assert body["generated_at"]


@requires_db
def test_mentor_load_carries_identity_and_capacity(client, make_user):
    director = make_user("ml-dir", Role.DIRECTOR)
    r = client.get("/api/director/mentor-load", headers=director.headers)
    assert r.status_code == 200, r.text
    for row in r.json():
        assert "department" in row and "designation" in row
        assert isinstance(row["capacity"], int) and row["capacity"] > 0


@requires_db
def test_student_weekly_series_and_cv_download(client, make_user):
    stu = make_user("wk-stud", Role.STUDENT)
    sid = _student_id(stu.user_id)
    director = make_user("wk-dir", Role.DIRECTOR)

    # Rule 2: the student cannot read the director's view of themselves.
    assert client.get(f"/api/director/students/{sid}/weekly", headers=stu.headers).status_code == 403
    assert (
        client.get(f"/api/director/students/{uuid.uuid4().hex}/weekly", headers=director.headers).status_code
        == 404
    )

    r = client.get(f"/api/director/students/{sid}/weekly", headers=director.headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["student_id"] == sid
    assert len(body["weeks"]) == 6
    assert len(body["attendance_percent"]) == 6
    assert len(body["logged_hours"]) == 6
    # A brand-new student sat no sessions: every week is None, not 0 %.
    assert body["attendance_percent"] == [None] * 6
    assert body["logged_hours"] == [0] * 6
    assert body["skills_by_category"] == []
    assert body["has_resume"] is False

    # No resume yet -> the download is a 404, and the button is never drawn.
    assert (
        client.get(f"/api/director/students/{sid}/resume.pdf", headers=director.headers).status_code
        == 404
    )

    with SessionLocal() as db:
        db.add(Resume(student_id=sid, markdown="# Test Resume\n\n- a bullet", title="Test Resume"))
        db.commit()
    try:
        body = client.get(f"/api/director/students/{sid}/weekly", headers=director.headers).json()
        assert body["has_resume"] is True
        pdf = client.get(f"/api/director/students/{sid}/resume.pdf", headers=director.headers)
        assert pdf.status_code == 200
        assert pdf.headers["content-type"].startswith("application/pdf")
        assert pdf.content[:4] == b"%PDF"
        # Local render, director only: a student is refused even for their own.
        assert (
            client.get(f"/api/director/students/{sid}/resume.pdf", headers=stu.headers).status_code
            == 403
        )
    finally:
        with SessionLocal() as db:
            db.execute(delete(Resume).where(Resume.student_id == sid))
            db.commit()


@requires_db
def test_placement_summary_shape(client, make_user):
    student = make_user("pl-stud", Role.STUDENT)
    director = make_user("pl-dir", Role.DIRECTOR)
    assert client.get("/api/director/placement", headers=student.headers).status_code == 403

    body = client.get("/api/director/placement", headers=director.headers).json()
    assert body["eligible"] >= 1
    assert body["approved"] <= body["offers"]
    assert body["approved_students"] <= body["approved"]
    assert isinstance(body["recent"], list)
    assert isinstance(body["top_recruiters"], list)
    for row in body["recent"]:
        assert row["status"] in {"PENDING_APPROVAL", "APPROVED", "REJECTED"}


@requires_db
def test_jobs_publish_then_remove_and_refuse_while_applied(client, make_user):
    director = make_user("job-dir", Role.DIRECTOR)
    student = make_user("job-stud", Role.STUDENT)
    sid = _student_id(student.user_id)

    # A student cannot publish.
    assert (
        client.post(
            "/api/director/jobs",
            headers=student.headers,
            json={"title": "x", "company": "y"},
        ).status_code
        == 403
    )
    # Level is one of the two the board knows.
    assert (
        client.post(
            "/api/director/jobs",
            headers=director.headers,
            json={"title": "Analyst", "company": "Acme", "degree_level": "PHD"},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/director/jobs",
            headers=director.headers,
            json={"title": "Analyst", "company": "Acme", "apply_url": "javascript:alert(1)"},
        ).status_code
        == 422
    )

    r = client.post(
        "/api/director/jobs",
        headers=director.headers,
        json={
            "title": "Business Analyst",
            "company": "Test Recruiter",
            "degree_level": "PG",
            "location": "Bengaluru",
            "closes_on": "2030-01-31",
            "required_skills": ["excel", " sql ", ""],
        },
    )
    assert r.status_code == 201, r.text
    job = r.json()
    job_id = job["id"]
    try:
        assert job["applicants"] == 0
        assert job["degree_level"] == "PG"
        assert job["required_skills"] == ["excel", "sql"]
        assert job["closes_on"].startswith("2030-01-31")

        sheet = client.get("/api/director/jobs", headers=director.headers).json()
        assert any(row["id"] == job_id for row in sheet)
        # Published to the alumni board too — one table, one sheet.
        alum = make_user("job-alum", Role.ALUMNI)
        assert any(
            row["id"] == job_id for row in client.get("/api/alumni/jobs", headers=alum.headers).json()
        )

        with SessionLocal() as db:
            db.add(JobApplication(student_id=sid, job_id=job_id))
            db.commit()
        refused = client.delete(f"/api/director/jobs/{job_id}", headers=director.headers)
        assert refused.status_code == 409
        assert "applied" in refused.json()["detail"]

        with SessionLocal() as db:
            db.execute(delete(JobApplication).where(JobApplication.job_id == job_id))
            db.commit()
        assert client.delete(f"/api/director/jobs/{job_id}", headers=director.headers).status_code == 204
        assert client.delete(f"/api/director/jobs/{job_id}", headers=director.headers).status_code == 404
    finally:
        with SessionLocal() as db:
            db.execute(delete(JobApplication).where(JobApplication.job_id == job_id))
            db.execute(delete(Job).where(Job.id == job_id))
            db.commit()


@requires_db
def test_catalogue_rows_carry_enrolled_and_the_badge_catalogue_is_complete(client, make_user):
    director = make_user("cat-dir", Role.DIRECTOR)
    for row in client.get("/api/director/catalogue", headers=director.headers).json():
        assert isinstance(row["enrolled"], int) and row["enrolled"] >= 0

    badges = client.get("/api/director/badge-catalogue", headers=director.headers).json()
    assert len(badges) == 48
    assert all(b["points"] > 0 and b["category_label"] for b in badges)

    student = make_user("cat-stud", Role.STUDENT)
    assert client.get("/api/director/badge-catalogue", headers=student.headers).status_code == 403


@requires_db
def test_approved_certifications_carry_claims_and_badge_points(client, make_user):
    director = make_user("cert-dir", Role.DIRECTOR)
    r = client.post(
        "/api/director/approved-certifications",
        headers=director.headers,
        json={
            "name": f"Test Cert {uuid.uuid4().hex[:6]}",
            "provider": "Test Provider",
            "badge_code": "TECH-POWER-BI",
        },
    )
    assert r.status_code == 201, r.text
    cert = r.json()
    try:
        assert cert["claims"] == 0
        assert cert["badge_points"] == 15
        assert cert["badge_category"] == "Platform / Technical Skills"
        listed = next(
            c for c in client.get("/api/director/approved-certifications", headers=director.headers).json()
            if c["id"] == cert["id"]
        )
        assert listed["claims"] == 0 and listed["badge_points"] == 15

        # "Remove" on the Catalogue screen deactivates rather than deletes, so
        # evidence already filed against the row keeps its reference.
        off = client.patch(
            f"/api/director/approved-certifications/{cert['id']}",
            headers=director.headers,
            json={**{k: cert[k] for k in ("name", "provider", "badge_code", "evidence_type", "stage", "duration_text", "is_free", "url")}, "active": False},
        )
        assert off.status_code == 200, off.text
        assert off.json()["active"] is False
    finally:
        with SessionLocal() as db:
            db.execute(delete(ApprovedCertification).where(ApprovedCertification.id == cert["id"]))
            db.commit()


@requires_db
def test_exports_are_csv_and_director_only(client, make_user):
    director = make_user("exp-dir", Role.DIRECTOR)
    student = make_user("exp-stud", Role.STUDENT)
    for path in ("students", "placement", "ledger"):
        assert client.get(f"/api/director/exports/{path}.csv", headers=student.headers).status_code == 403
        r = client.get(f"/api/director/exports/{path}.csv", headers=director.headers)
        assert r.status_code == 200, r.text
        assert r.headers["content-type"].startswith("text/csv")
        assert "attachment" in r.headers["content-disposition"]
        header = r.text.splitlines()[0]
        assert "USN" in header
    # The students export names the fixture's own student, unassigned.
    body = client.get("/api/director/exports/students.csv", headers=director.headers).text
    assert "Unassigned" in body


@requires_db
def test_leave_history_follows_the_pending_scope_rule(client, make_user):
    director = make_user("lh-dir", Role.DIRECTOR)
    student = make_user("lh-stud", Role.STUDENT)
    mentor_without_group = make_user("lh-mentor", Role.MENTOR)

    assert client.get("/api/leaves/history", headers=student.headers).status_code == 403
    # A MENTOR with no Mentor group sees NOBODY — never the whole programme.
    assert client.get("/api/leaves/history", headers=mentor_without_group.headers).json() == []

    r = client.get("/api/leaves/history", headers=director.headers)
    assert r.status_code == 200, r.text
    for row in r.json():
        assert row["status"] in {"APPROVED", "REJECTED"}
        # A final decision carries the time it was made.
        assert row["director_decided_at"]
