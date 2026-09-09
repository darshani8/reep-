"""Registration documents and the queue's Undo — the backend behind the design's
register form and approval screen.

An applicant attaches a CV (PDF) and a photo (PNG/JPG) BEFORE anyone decides;
the director's queue shows what is attached; APPROVE moves the files into the
student's own uploads; a rejection can be reopened (the design's Undo) and an
approval cannot; a never-verified application is swept with its files.

Every byte these tests write lands in tmp_path — the real store is never
touched. The `application` fixture and the mail helpers are test_passwords.py's,
imported by name so pytest sees them here; its autouse throttle reset rides in
the same way, because every TestClient request shares one client address and
the public endpoints are limited per address.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, update

from conftest import requires_db
from test_passwords import (  # noqa: F401 — fixtures/helpers by name
    _clean_outbox_and_throttles,
    _mail_to,
    _token_from,
    application,
)

from app import document_store
from app.routers import registration as registration_router
from app.db import SessionLocal
from app.models.registration import Registration, RegistrationDocument, RegistrationStatus
from app.models.upload import Upload, UploadKind
from app.models.user import Role, Student, User
from app.retention import sweep_unverified_registrations

# The store recognises files by magic bytes, nothing more — enough to be a PDF,
# a PNG, a JPEG, or nothing at all.
PDF = b"%PDF-1.4\n% a cv\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"
PDF_2 = b"%PDF-1.7\n% a newer cv\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"
PNG = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + b"\x00" * 64
JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
JUNK = b"this is not a document" * 4


@pytest.fixture(autouse=True)
def _tmp_store(tmp_path, monkeypatch):
    """Point the document store at tmp_path, and give the public register
    limiter a clean window: every TestClient request shares one address, and
    these tests post more than a real applicant would in fifteen minutes."""
    monkeypatch.setattr(document_store, "_store_dir", lambda: tmp_path)
    monkeypatch.setattr(registration_router, "_rate_windows", {})
    return tmp_path


def _submit(client, submit, email, usn, *, verify: bool):
    r = submit(client, email, usn=usn)
    assert r.status_code == 201, r.text
    reg_id = r.json()["id"]
    if verify:
        token = _token_from(_mail_to(email, "Confirm your email"))
        client.get(f"/api/register/verify?token={token}", follow_redirects=False)
    return reg_id


def _attach(client, reg_id: str, kind: str, name: str, content: bytes):
    return client.post(
        f"/api/register/{reg_id}/documents/{kind}",
        files={"file": (name, content, "application/octet-stream")},
    )


def _docs(reg_id: str) -> list[RegistrationDocument]:
    with SessionLocal() as db:
        return db.scalars(
            select(RegistrationDocument).where(RegistrationDocument.registration_id == reg_id)
        ).all()


# ------------------------------------------------------------ attaching --


@requires_db
def test_an_applicant_can_attach_a_cv_and_a_photo_and_replace_them(client, application, _tmp_store):
    submit, _ = application
    reg_id = _submit(client, submit, "rd.attach@bgscet.ac.in", "1BG26RD01", verify=False)

    r = _attach(client, reg_id, "cv", "my-cv.pdf", PDF)
    assert r.status_code == 200, r.text
    assert r.json()["documents"] == ["CV"]
    (cv,) = _docs(reg_id)
    assert cv.mime_type == "application/pdf" and cv.original_name == "my-cv.pdf"
    assert (_tmp_store / cv.stored_name).exists(), "the bytes must actually be on disk"

    r = _attach(client, reg_id, "photo", "me.png", PNG)
    assert r.status_code == 200, r.text
    assert r.json()["documents"] == ["CV", "PHOTO"]

    # A second CV REPLACES the first: still one row of that kind, old bytes gone.
    r = _attach(client, reg_id, "cv", "my-cv-v2.pdf", PDF_2)
    assert r.status_code == 200, r.text
    assert r.json()["documents"] == ["CV", "PHOTO"]
    docs = {d.kind: d for d in _docs(reg_id)}
    assert set(docs) == {"CV", "PHOTO"}, "replace, not a second CV"
    assert docs["CV"].original_name == "my-cv-v2.pdf"
    assert not (_tmp_store / cv.stored_name).exists(), "the replaced file is deleted"
    assert (_tmp_store / docs["CV"].stored_name).exists()


@requires_db
def test_a_cv_must_be_a_pdf_and_a_photo_an_image(client, application, _tmp_store):
    submit, _ = application
    reg_id = _submit(client, submit, "rd.types@bgscet.ac.in", "1BG26RD02", verify=False)

    r = _attach(client, reg_id, "cv", "not-a-cv.png", PNG)
    assert r.status_code == 415, r.text
    assert "PDF" in r.text
    r = _attach(client, reg_id, "photo", "not-a-photo.pdf", PDF)
    assert r.status_code == 415, r.text
    r = _attach(client, reg_id, "cv", "junk.bin", JUNK)
    assert r.status_code == 415, r.text
    r = _attach(client, reg_id, "transcript", "x.pdf", PDF)
    assert r.status_code == 404, "only the two known kinds exist"

    assert _docs(reg_id) == [], "a refused file leaves no row"
    assert list(_tmp_store.iterdir()) == [], "and no bytes on disk"


@requires_db
def test_no_document_can_be_added_after_a_decision(client, make_user, application):
    submit, _ = application
    director = make_user("rd-dir1", Role.DIRECTOR)
    reg_id = _submit(client, submit, "rd.decided@bgscet.ac.in", "1BG26RD03", verify=True)
    r = client.post(
        f"/api/register/{reg_id}/decision",
        headers=director.headers,
        json={"decision": "REJECT", "note": "incomplete"},
    )
    assert r.status_code == 200, r.text
    r = _attach(client, reg_id, "cv", "late.pdf", PDF)
    assert r.status_code == 409, r.text


# --------------------------------------------------------- the queue --


@requires_db
def test_the_queue_reports_what_is_attached(client, make_user, application):
    submit, _ = application
    director = make_user("rd-dir2", Role.DIRECTOR)
    reg_id = _submit(client, submit, "rd.queue@bgscet.ac.in", "1BG26RD04", verify=True)
    assert _attach(client, reg_id, "cv", "cv.pdf", PDF).status_code == 200

    r = client.get("/api/register/pending", headers=director.headers)
    assert r.status_code == 200, r.text
    row = next(x for x in r.json() if x["id"] == reg_id)
    assert row["documents"] == ["CV"]


# ----------------------------------------------------------- approve --


@requires_db
def test_documents_move_into_the_students_uploads_on_approve(client, make_user, application, _tmp_store):
    submit, _ = application
    director = make_user("rd-dir3", Role.DIRECTOR)
    email = "rd.approve@bgscet.ac.in"
    reg_id = _submit(client, submit, email, "1BG26RD05", verify=True)
    assert _attach(client, reg_id, "cv", "cv.pdf", PDF).status_code == 200
    assert _attach(client, reg_id, "photo", "me.jpg", JPG).status_code == 200
    before = {d.kind: d.stored_name for d in _docs(reg_id)}

    r = client.post(
        f"/api/register/{reg_id}/decision", headers=director.headers, json={"decision": "APPROVE"}
    )
    assert r.status_code == 200, r.text

    assert _docs(reg_id) == [], "moved off the application"
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == email))
        student = db.scalar(select(Student).where(Student.user_id == user.id))
        uploads = {u.kind: u for u in db.scalars(select(Upload).where(Upload.student_id == student.id)).all()}
    assert set(uploads) == {UploadKind.RESUME, UploadKind.PROFILE_PHOTO}
    assert uploads[UploadKind.RESUME].stored_name == before["CV"], "same bytes, not a copy"
    assert uploads[UploadKind.PROFILE_PHOTO].stored_name == before["PHOTO"]
    for name in before.values():
        assert (_tmp_store / name).exists(), "the file survives the move"


# -------------------------------------------------------------- undo --


@requires_db
def test_a_rejection_can_be_reopened_and_an_approval_cannot(client, make_user, application):
    submit, _ = application
    director = make_user("rd-dir4", Role.DIRECTOR)
    student = make_user("rd-stu4")  # STUDENT: must be refused
    a = _submit(client, submit, "rd.reopen.a@bgscet.ac.in", "1BG26RD06", verify=True)
    b = _submit(client, submit, "rd.reopen.b@bgscet.ac.in", "1BG26RD07", verify=True)
    assert _attach(client, a, "cv", "cv.pdf", PDF).status_code == 200

    r = client.post(
        f"/api/register/{a}/decision",
        headers=director.headers,
        json={"decision": "REJECT", "note": "photo missing"},
    )
    assert r.status_code == 200 and r.json()["status"] == "REJECTED"
    assert _docs(a) != [], "rejection keeps the documents, so undo is lossless"

    r = client.post(f"/api/register/{a}/reopen", headers=director.headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "PENDING_REVIEW"
    assert body["reviewed_by_id"] is None and body["review_note"] is None
    assert body["documents"] == ["CV"]
    queue = client.get("/api/register/pending", headers=director.headers).json()
    assert any(x["id"] == a for x in queue), "back in the queue"

    r = client.post(f"/api/register/{b}/decision", headers=director.headers, json={"decision": "APPROVE"})
    assert r.status_code == 200, r.text
    r = client.post(f"/api/register/{b}/reopen", headers=director.headers)
    assert r.status_code == 409, "an approval provisioned an account; not undone here"

    assert client.post(f"/api/register/{uuid.uuid4().hex}/reopen", headers=director.headers).status_code == 404
    assert client.post(f"/api/register/{a}/reopen", headers=student.headers).status_code == 403
    assert client.post(f"/api/register/{a}/reopen", headers=director.headers).status_code == 409, (
        "already open — reopening twice is a conflict, not a no-op that hides a race"
    )


# ------------------------------------------------------------- sweep --


@requires_db
def test_never_verified_applications_are_swept_with_their_files(client, application, _tmp_store):
    submit, _ = application
    stale = _submit(client, submit, "rd.stale@bgscet.ac.in", "1BG26RD08", verify=False)
    live = _submit(client, submit, "rd.live@bgscet.ac.in", "1BG26RD09", verify=True)
    assert _attach(client, stale, "cv", "old.pdf", PDF).status_code == 200
    assert _attach(client, live, "cv", "new.pdf", PDF).status_code == 200
    (stale_doc,) = _docs(stale)
    (live_doc,) = _docs(live)

    long_ago = datetime.now(timezone.utc) - timedelta(days=8)
    with SessionLocal() as db:
        db.execute(update(Registration).where(Registration.id.in_([stale, live])).values(created_at=long_ago))
        db.commit()
        swept = sweep_unverified_registrations(db, now=datetime.now(timezone.utc))
    assert swept == 1

    with SessionLocal() as db:
        assert db.get(Registration, stale) is None, "never confirmed, past the grace: gone"
        kept = db.get(Registration, live)
        assert kept is not None and kept.status is RegistrationStatus.PENDING_REVIEW, (
            "a confirmed application is a person in the queue, however old"
        )
    assert not (_tmp_store / stale_doc.stored_name).exists(), "its bytes went with it"
    assert (_tmp_store / live_doc.stored_name).exists()
