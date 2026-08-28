"""Staff upskilling — a faculty member's own certificate uploads.

Any staff role (MENTOR / DIRECTOR / ADMIN, via mentor.require_mentor — imported,
never reimplemented) may upload certificates for courses THEY have completed,
list them, download them and delete them. Everything here is scoped to
session["userId"]; there is no cross-staff read, and rule 2 is untouched because
no student is ever named.

Files go through the same hardened document_store as student uploads (magic-byte
sniffing, 10 MB cap, random stored name). document_store's contract says any second
writer of save_bytes must apply its own volume quota or the quota is decoration,
so this router enforces a per-user count/bytes ceiling before reading the body —
smaller than the student one, because a staff member's certificate shelf is a
handful of PDFs, not four years of marksheets.
"""

from datetime import date, datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.platform.identity import get_current_session
from app.platform.document_store import MAX_BYTES, UploadRejected, content_disposition
from app.platform.document_store import delete as document_store_delete
from app.platform.document_store import read_bytes, save_bytes
from app.models.staff_upskilling import StaffUpskillingCertificate
from app.api.mentor.mentees import require_mentor

router = APIRouter(prefix="/staff/upskilling", tags=["staff-upskilling"])

# Per-STAFF-user quota (same reasoning as document_store's per-student one): far above
# real use, far below "one account fills the disk".
MAX_CERTIFICATES_PER_USER = 20
MAX_CERTIFICATE_BYTES_PER_USER = 100 * 1024 * 1024  # 100 MB


class CertificateOut(BaseModel):
    id: str
    title: str
    provider: str | None
    completed_on: date | None
    original_name: str
    mime_type: str
    size_bytes: int
    uploaded_at: datetime


def _certificate_row(c: StaffUpskillingCertificate) -> CertificateOut:
    return CertificateOut(
        id=c.id,
        title=c.title,
        provider=c.provider,
        completed_on=c.completed_on,
        original_name=c.original_name,
        mime_type=c.mime_type,
        size_bytes=c.size_bytes,
        uploaded_at=c.uploaded_at,
    )


@router.get("", response_model=list[CertificateOut])
def my_certificates(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[CertificateOut]:
    require_mentor(session)
    rows = db.scalars(
        select(StaffUpskillingCertificate)
        .where(StaffUpskillingCertificate.user_id == session["userId"])
        .order_by(StaffUpskillingCertificate.uploaded_at.desc())
    ).all()
    return [_certificate_row(c) for c in rows]


@router.post("", response_model=CertificateOut, status_code=status.HTTP_201_CREATED)
def upload_certificate(
    file: UploadFile = File(...),
    title: str = Form(""),
    provider: str = Form(""),
    completed_on: date | None = Form(None),
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> CertificateOut:
    """Sync `def` on purpose, like student create_upload: a 10 MB write belongs
    in the threadpool, not on the event loop the live interviews share."""
    require_mentor(session)
    user_id = session["userId"]

    # Quota before the body is buffered (see module docstring).
    used_count, used_bytes = db.execute(
        select(
            func.count(StaffUpskillingCertificate.id),
            func.coalesce(func.sum(StaffUpskillingCertificate.size_bytes), 0),
        ).where(StaffUpskillingCertificate.user_id == user_id)
    ).one()
    if used_count >= MAX_CERTIFICATES_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"You already have {used_count} certificates uploaded, which is the "
                f"limit of {MAX_CERTIFICATES_PER_USER}. Delete one you no longer need, then "
                "try again."
            ),
        )

    # read(MAX+1), never read(): save_bytes refuses anything past the per-file
    # cap, so one extra byte trips it without buffering an unbounded body in
    # RAM (api/student/self_service.py create_upload, same reasoning).
    content = file.file.read(MAX_BYTES + 1)
    if used_bytes + len(content) > MAX_CERTIFICATE_BYTES_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=(
                f"This file would take you past your "
                f"{MAX_CERTIFICATE_BYTES_PER_USER // (1024 * 1024)} MB upload allowance. "
                "Delete a certificate you no longer need, then try again."
            ),
        )
    try:
        stored_name, mime, size = save_bytes(content)
    except UploadRejected as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))

    cert = StaffUpskillingCertificate(
        user_id=user_id,
        title=title.strip() or (file.filename or "Certificate"),
        provider=provider.strip() or None,
        completed_on=completed_on,
        original_name=file.filename or stored_name,
        stored_name=stored_name,
        mime_type=mime,
        size_bytes=size,
    )
    db.add(cert)
    db.commit()
    db.refresh(cert)
    return _certificate_row(cert)


@router.get("/{cert_id}/file")
def download_certificate(
    cert_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> Response:
    require_mentor(session)
    cert = db.get(StaffUpskillingCertificate, cert_id)
    if cert is None or cert.user_id != session["userId"]:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Certificate not found.")
    try:
        content = read_bytes(cert.stored_name)
    except FileNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Stored file is missing.")
    return Response(
        content=content,
        media_type=cert.mime_type,
        headers={"Content-Disposition": content_disposition(cert.original_name)},
    )


@router.delete("/{cert_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_certificate(
    cert_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> Response:
    require_mentor(session)
    cert = db.get(StaffUpskillingCertificate, cert_id)
    if cert is None or cert.user_id != session["userId"]:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Certificate not found.")
    document_store_delete(cert.stored_name)
    db.delete(cert)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
