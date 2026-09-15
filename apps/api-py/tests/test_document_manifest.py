"""The manifest's contract, on an in-memory database and no S3.

`archived_documents` is the index into the permanent document archive. The
bytes are already safe -- versioned, Object-Locked, no lifecycle rule -- so
what this table protects is the ability to say whose file a given uuid was, and
the properties worth asserting are the ones that make that answer survive:
that a row is written with the file rather than after it, that a superseded
file keeps its name, and that nothing here ever deletes a row.
"""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app import document_archive, document_manifest, document_store
from app.document_store import VolumeQuota
from app.models.archived_document import ArchivedDocument, DocumentOwnerKind

PDF = b"%PDF-1.7 a marksheet"


@pytest.fixture
def db(tmp_path, monkeypatch):
    """An in-memory session holding only this table, and a store on tmp_path.

    The archive is switched OFF for these tests -- `archive_bytes` returns
    False with no bucket configured and no boto3 client is constructed -- so
    what is exercised here is the manifest alone, which is the half a database
    can speak to.
    """
    monkeypatch.setattr(document_store.settings, "upload_dir", str(tmp_path), raising=False)
    monkeypatch.setattr(document_archive.settings, "document_archive_bucket", "", raising=False)
    engine = create_engine("sqlite://")
    ArchivedDocument.__table__.create(engine)
    with Session(engine) as session:
        yield session


def _save(db, *, owner="stu-1", name="marks.pdf", title=None):
    return document_manifest.save_and_record(
        db,
        PDF,
        quota=VolumeQuota.single_slot(),
        kind=DocumentOwnerKind.STUDENT_UPLOAD,
        owner_id=owner,
        original_name=name,
        title=title,
    )


def _rows(db) -> list[ArchivedDocument]:
    return list(db.scalars(select(ArchivedDocument)))


def test_storing_a_file_records_what_it_was(db) -> None:
    stored_name, mime, size = _save(db, title="Semester 3 marksheet")

    row = _rows(db)[0]
    assert row.stored_name == stored_name
    assert row.original_name == "marks.pdf"
    assert row.title == "Semester 3 marksheet"
    assert row.mime_type == mime == "application/pdf"
    assert row.size_bytes == size == len(PDF)
    assert row.owner_id == "stu-1"
    assert row.released_at is None


def test_the_row_lands_in_the_callers_transaction(db) -> None:
    """`db.add` and `db.flush`, never a commit here.

    A separate commit would make both "file recorded, upload rolled back" and
    "upload committed, file unrecorded" reachable. The first is harmless noise;
    the second is a file in a permanent archive that nothing can name, which is
    the failure this module exists to prevent.
    """
    _save(db)
    assert db.in_transaction()
    db.rollback()
    assert _rows(db) == []


def test_a_deleted_file_keeps_its_name(db) -> None:
    """The website's delete and the archive's permanence are promises about
    different copies. The row stays; only `released_at` moves."""
    stored_name, _, _ = _save(db)
    document_manifest.release(db, stored_name, reason="student deleted upload")

    row = _rows(db)[0]
    assert row.released_at is not None
    assert row.released_reason == "student deleted upload"
    assert row.original_name == "marks.pdf"


def test_a_superseded_file_keeps_its_name(db) -> None:
    """THE CASE A `deleted_at` COLUMN CANNOT EXPRESS, and the reason this table
    exists at all.

    `staff_signatures.user_id` is UNIQUE and its PUT overwrites `stored_name`
    in place; `alumni_profiles` holds exactly one resume and does the same. In
    both there is no second row to flag and nowhere on the live row to keep the
    old name -- after the overwrite, nothing in the database names the old
    bytes. Here both generations are still answerable.
    """
    first, _, _ = _save(db, name="signature-2024.png")
    document_manifest.release(db, first, reason="signature replaced")
    second, _, _ = _save(db, name="signature-2026.png")

    by_name = {r.stored_name: r for r in _rows(db)}
    assert by_name[first].released_reason == "signature replaced"
    assert by_name[first].original_name == "signature-2024.png"
    assert by_name[second].released_at is None


def test_releasing_twice_keeps_the_first_answer(db) -> None:
    """Idempotent, because a re-run of any delete path releases a name already
    released -- and because the FIRST release is the true one. Overwriting it
    would move the date every time a destructor passed over the same row."""
    stored_name, _, _ = _save(db)
    document_manifest.release(db, stored_name, reason="student deleted upload")
    first_at = _rows(db)[0].released_at

    document_manifest.release(db, stored_name, reason="purge_students")

    row = _rows(db)[0]
    assert row.released_at == first_at
    assert row.released_reason == "student deleted upload"


def test_releasing_an_unknown_name_is_not_an_error(db, caplog) -> None:
    """A file stored before this table existed. `purge_people` walks every
    `stored_name` in the deployment, most of which predate the manifest on a
    running college; raising on those would put a destructor into a state only
    a database edit can leave."""
    with caplog.at_level("INFO"):
        document_manifest.release(db, "never-seen.pdf", reason="purge_people")
    assert _rows(db) == []
    assert "never-seen.pdf" in caplog.text


def test_releasing_nothing_is_not_an_error(db) -> None:
    """`alumni_profiles.resume_stored_name` is nullable and the replace path
    releases the old value unconditionally."""
    document_manifest.release(db, None, reason="resume replaced")
    assert _rows(db) == []


def test_a_rejected_upload_is_recorded_and_released(db) -> None:
    """Two call sites check the mime AFTER storing -- a registration document
    that is a PDF where a photograph was wanted, a signature that is a valid
    PDF. The bytes reached the store and therefore the archive, so the manifest
    must say what they were and that nothing points at them."""
    stored_name, _, _ = _save(db, name="wrong.pdf")
    document_manifest.release(db, stored_name, reason="rejected: wrong document type")

    row = _rows(db)[0]
    assert row.released_reason.startswith("rejected")
    assert row.original_name == "wrong.pdf"


def test_an_applicant_with_no_account_is_recorded_as_such(db) -> None:
    """A registration document is uploaded before there is a user. `None` is
    stated rather than omitted at that call site, because inventing an owner id
    would be inventing a user."""
    document_manifest.save_and_record(
        db,
        PDF,
        quota=VolumeQuota.single_slot(),
        kind=DocumentOwnerKind.REGISTRATION_DOCUMENT,
        owner_id=None,
        original_name="cv.pdf",
    )
    assert _rows(db)[0].owner_id is None


def test_nothing_in_the_module_deletes_a_row() -> None:
    """The point of the manifest is that it outlives the thing it describes."""
    source = (document_manifest.__file__ and open(document_manifest.__file__).read()) or ""
    assert "db.delete(" not in source
    assert "delete(ArchivedDocument" not in source
