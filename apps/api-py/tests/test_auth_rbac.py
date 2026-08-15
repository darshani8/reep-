"""Auth + role-scope enforcement, end-to-end via TestClient against the seeded
dev DB. The mentorScope() rule (staff-only, director-only) is the security spine
of the whole app, so it gets first-class coverage.

Paths are under /api — the whole domain surface is mounted there so the Angular
client and its dev proxy reach it uniformly.
"""

from conftest import requires_db


@requires_db
def test_login_success_sets_session_cookie(client):
    r = client.post("/api/auth/login", json={"email": "student@bgscet.ac.in", "password": "student123"})
    assert r.status_code == 200
    assert "reep_session" in r.headers.get("set-cookie", "")
    assert r.json()["role"] == "STUDENT"


@requires_db
def test_login_wrong_password_401(client):
    r = client.post("/api/auth/login", json={"email": "student@bgscet.ac.in", "password": "nope"})
    assert r.status_code == 401


@requires_db
def test_me_reflects_session(client, login):
    h = login("director@bgscet.ac.in", "director123")
    r = client.get("/api/auth/me", headers=h)
    assert r.status_code == 200
    assert r.json()["role"] == "DIRECTOR"


@requires_db
def test_student_can_read_own_dashboard(client, login):
    h = login("student@bgscet.ac.in", "student123")
    assert client.get("/api/student/dashboard", headers=h).status_code == 200


@requires_db
def test_student_forbidden_from_mentor_area(client, login):
    h = login("student@bgscet.ac.in", "student123")
    assert client.get("/api/mentor/mentees", headers=h).status_code == 403


@requires_db
def test_student_forbidden_from_director_area(client, login):
    h = login("student@bgscet.ac.in", "student123")
    assert client.get("/api/director/overview", headers=h).status_code == 403


@requires_db
def test_mentor_forbidden_from_director_only(client, login):
    # A MENTOR is staff but not a director: reads mentees, blocked from director config.
    h = login("mentor@bgscet.ac.in", "mentor123")
    assert client.get("/api/mentor/mentees", headers=h).status_code == 200
    assert client.get("/api/director/alert-rules", headers=h).status_code == 403


@requires_db
def test_director_can_read_overview(client, login):
    h = login("director@bgscet.ac.in", "director123")
    assert client.get("/api/director/overview", headers=h).status_code == 200


@requires_db
def test_unauthenticated_is_rejected(client):
    # No cookie → the session dependency refuses (this app's convention is 403).
    assert client.get("/api/student/dashboard").status_code in (401, 403)


@requires_db
def test_resume_generate_respects_egress_gate(client, login):
    # With no remote key allowed for PII, resume composition must not use AI.
    h = login("student@bgscet.ac.in", "student123")
    r = client.post("/api/student/resume/generate", headers=h, json={"title": "T"})
    assert r.status_code == 200
    assert r.json()["used_ai"] is False
