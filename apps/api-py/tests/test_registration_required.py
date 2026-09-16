"""The public form is compulsory end to end (2026-09-16).

The owner's rule: every box on `/register` is required except Specialization,
and the CV and the photo with them. The half of that rule the API can hold is
pinned here — USN, phone, the personal address and the LinkedIn profile are
refused blank or absent at the schema, the two new columns are written and
travel to the reviewer (and never to the applicant), approval copies phone
and LinkedIn onto the profile, and the reviewer's checklist names a missing
CV or photo, because those two are posted AFTER the 201 and the schema cannot
require what it never sees.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete, select

from app import document_store
from app.db import SessionLocal
from app.models.auth_token import AuthToken
from app.models.registration import Registration
from app.models.student_profile import StudentProfile
from app.models.user import LoginDay, Role, Student, User
from app.routers import registration as registration_router
from app.routers.registration import CHECK_DOCUMENTS, CHECK_OK, CHECK_WARN
from conftest import requires_db

PDF = b"%PDF-1.4\n% a cv\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"
PNG = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + b"\x00" * 64


@pytest.fixture(autouse=True)
def _tmp_store(tmp_path, monkeypatch):
    monkeypatch.setattr(document_store, "_store_dir", lambda: tmp_path)
    monkeypatch.setattr(registration_router, "_rate_windows", {})
    return tmp_path


@pytest.fixture
def cleanup():
    emails: list[str] = []
    yield emails
    with SessionLocal() as db:
        for email in emails:
            user = db.scalar(select(User).where(User.email == email))
            if user is not None:
                for stu in db.scalars(select(Student).where(Student.user_id == user.id)).all():
                    db.execute(delete(StudentProfile).where(StudentProfile.student_id == stu.id))
                    db.execute(delete(Student).where(Student.id == stu.id))
                db.execute(delete(LoginDay).where(LoginDay.user_id == user.id))
                db.execute(delete(AuthToken).where(AuthToken.user_id == user.id))
                db.execute(delete(User).where(User.id == user.id))
            db.execute(delete(Registration).where(Registration.email == email))
        db.commit()


def _payload(email: str, **override) -> dict:
    body = {
        "name": "Required Applicant",
        "email": email,
        "usn": f"1BG26REQ{uuid.uuid4().hex[:3].upper()}",
        "phone": "+91 98765 43210",
        "personal_email": f"req.{uuid.uuid4().hex[:8]}@gmail.com",
        "linkedin_url": "linkedin.com/in/required-applicant",
        "degree_level": "PG",
    }
    body.update(override)
    return {k: v for k, v in body.items() if v is not ...}


def _address(cleanup) -> str:
    email = f"req.{uuid.uuid4().hex[:8]}@bgscet.ac.in"
    cleanup.append(email)
    return email


@requires_db
@pytest.mark.parametrize("field", ["usn", "phone", "personal_email", "linkedin_url"])
def test_each_required_field_is_refused_absent_and_blank(client, cleanup, field):
    """Absent and blank are the same refusal: a form that pads a box with a
    space must not be the one application in the queue with no phone."""
    email = _address(cleanup)
    absent = client.post("/api/register", json=_payload(email, **{field: ...}))
    assert absent.status_code == 422, absent.text
    blank = client.post("/api/register", json=_payload(email, **{field: "   "}))
    assert blank.status_code == 422, blank.text


@requires_db
def test_the_personal_email_and_linkedin_have_a_shape(client, cleanup):
    email = _address(cleanup)
    r = client.post("/api/register", json=_payload(email, personal_email="not-an-address"))
    assert r.status_code == 422, r.text
    r = client.post("/api/register", json=_payload(email, linkedin_url="instagram.com/someone"))
    assert r.status_code == 422, r.text
    r = client.post("/api/register", json=_payload(email, linkedin_url="https://www.linkedin.com/"))
    assert r.status_code == 422, "a bare linkedin.com with no profile path names nobody"


@requires_db
def test_the_contact_fields_are_stored_normalised_and_shown_to_staff_only(client, make_user, cleanup):
    admin = make_user("req-staff", Role.ADMIN)
    email = _address(cleanup)
    r = client.post(
        "/api/register",
        json=_payload(
            email,
            usn=" 1BG26REQX01 ",
            phone=" +91 98765 43210 ",
            personal_email="Req.Person@Gmail.com",
            linkedin_url="http://linkedin.com/in/Req-Person/",
        ),
    )
    assert r.status_code == 201, r.text
    public = r.json()
    for private in ("phone", "personal_email", "linkedin_url"):
        assert private not in public, f"{private} must not travel on the applicant's own card"

    with SessionLocal() as db:
        reg = db.scalar(select(Registration).where(Registration.email == email))
        assert reg is not None
        assert reg.usn == "1BG26REQX01"
        assert reg.phone == "+91 98765 43210"
        assert reg.personal_email == "req.person@gmail.com"
        assert reg.linkedin_url == "https://www.linkedin.com/in/Req-Person"

    queue = client.get("/api/register/pending", headers=admin.headers)
    assert queue.status_code == 200, queue.text
    row = next(x for x in queue.json() if x["id"] == public["id"])
    assert row["phone"] == "+91 98765 43210"
    assert row["personal_email"] == "req.person@gmail.com"
    assert row["linkedin_url"] == "https://www.linkedin.com/in/Req-Person"


@requires_db
def test_the_reviewer_is_told_which_document_is_missing(client, make_user, cleanup):
    """Both files are required by the form and posted after the 201, so the
    API cannot refuse their absence; the checklist names it instead, and goes
    green once both are there."""
    admin = make_user("req-docs", Role.ADMIN)
    email = _address(cleanup)
    created = client.post("/api/register", json=_payload(email))
    assert created.status_code == 201, created.text
    reg_id = created.json()["id"]

    def documents_check() -> dict:
        queue = client.get("/api/register/pending", headers=admin.headers)
        assert queue.status_code == 200, queue.text
        row = next(x for x in queue.json() if x["id"] == reg_id)
        return {c["key"]: c for c in row["checks"]}[CHECK_DOCUMENTS]

    both_missing = documents_check()
    assert both_missing["status"] == CHECK_WARN
    assert "CV" in both_missing["label"] and "photo" in both_missing["label"].lower()

    cv = client.post(
        f"/api/register/{reg_id}/documents/cv",
        files={"file": ("cv.pdf", PDF, "application/octet-stream")},
    )
    assert cv.status_code == 200, cv.text
    photo_missing = documents_check()
    assert photo_missing["status"] == CHECK_WARN
    assert "photo" in photo_missing["label"].lower() and "CV" not in photo_missing["label"]

    photo = client.post(
        f"/api/register/{reg_id}/documents/photo",
        files={"file": ("me.png", PNG, "application/octet-stream")},
    )
    assert photo.status_code == 200, photo.text
    assert documents_check()["status"] == CHECK_OK


@requires_db
def test_approval_copies_phone_and_linkedin_onto_the_profile(client, make_user, cleanup):
    admin = make_user("req-approve", Role.ADMIN)
    email = _address(cleanup)
    created = client.post("/api/register", json=_payload(email, linkedin_url="linkedin.com/in/copied-over"))
    assert created.status_code == 201, created.text
    decided = client.post(
        f"/api/register/{created.json()['id']}/decision",
        headers=admin.headers,
        json={"decision": "APPROVE"},
    )
    assert decided.status_code == 200, decided.text

    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == email))
        assert user is not None
        student = db.scalar(select(Student).where(Student.user_id == user.id))
        assert student is not None
        profile = db.scalar(select(StudentProfile).where(StudentProfile.student_id == student.id))
        assert profile is not None
        assert profile.phone == "+91 98765 43210"
        assert profile.linkedin_url == "https://www.linkedin.com/in/copied-over"
