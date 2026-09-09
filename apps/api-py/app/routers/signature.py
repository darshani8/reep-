"""A staff member's own signature image: /api/staff/signature.

    GET    /            is one on file, and since when
    PUT    /            upload (PNG or JPEG, under 2 MB) - replaces in place
    GET    /image       the image itself, inline, for the preview
    DELETE /            remove it

Staff only (`require_mentor`: MENTOR / DIRECTOR / ADMIN), and always the
caller's OWN: there is no path that reads another account's image here.
Where another person's signature is shown is the leave paper, which reads
the row by user id at render time (routers/leave_paper.py) - so a replaced
image shows on every paper from then on, and a removed one shows on none.

ONE SLOT, REPLACED IN PLACE, the alumni-resume shape: `VolumeQuota.single_slot`
says so to the store, and the old bytes are deleted before the row points at
the new ones. The store sniffs the bytes; a PDF is a legal upload elsewhere
and is refused HERE, after the sniff, because a signature is an image.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..document_store import (
    QuotaRejected,
    UploadRejected,
    VolumeQuota,
    content_disposition,
    delete as delete_stored,
    read_bytes,
    save_bytes,
)
from ..identity import get_current_session
from ..models.staff_signature import StaffSignature
from .mentor import require_mentor

router = APIRouter(prefix="/staff/signature", tags=["staff-signature"])

#: A signature is a small image. Two megabytes is generous for a scan and far
#: below the store's 10 MB per-file cap, so this is the bound that matters.
MAX_SIGNATURE_BYTES = 2 * 1024 * 1024
IMAGE_TYPES = ("image/png", "image/jpeg")


class SignatureOut(BaseModel):
    present: bool
    mime_type: str | None
    size_bytes: int | None
    uploaded_at: datetime | None


def _out(row: StaffSignature | None) -> SignatureOut:
    if row is None:
        return SignatureOut(present=False, mime_type=None, size_bytes=None, uploaded_at=None)
    return SignatureOut(present=True, mime_type=row.mime_type, size_bytes=row.size_bytes, uploaded_at=row.uploaded_at)


def _mine(db: Session, session: dict) -> StaffSignature | None:
    return db.scalar(select(StaffSignature).where(StaffSignature.user_id == session["userId"]))


@router.get("", response_model=SignatureOut)
def my_signature(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> SignatureOut:
    require_mentor(session)
    return _out(_mine(db, session))


@router.put("", response_model=SignatureOut)
def upload_signature(
    file: UploadFile = File(...),
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> SignatureOut:
    """Sync `def` on purpose, like the other upload endpoints: the write belongs
    in the threadpool, not on the event loop the live interviews share."""
    require_mentor(session)
    # read(MAX+1), never read(): one byte over trips the check without
    # buffering an unbounded body (routers/student.py create_upload).
    content = file.file.read(MAX_SIGNATURE_BYTES + 1)
    if len(content) > MAX_SIGNATURE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Keep the signature image under 2 MB.",
        )
    try:
        stored_name, mime, size = save_bytes(content, quota=VolumeQuota.single_slot("signature"))
    except QuotaRejected as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    except UploadRejected as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc))
    if mime not in IMAGE_TYPES:
        delete_stored(stored_name)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="A signature is an image: upload a PNG or a JPEG.",
        )

    row = _mine(db, session)
    if row is None:
        row = StaffSignature(user_id=session["userId"], stored_name=stored_name, mime_type=mime, size_bytes=size)
        db.add(row)
    else:
        old = row.stored_name
        row.stored_name = stored_name
        row.mime_type = mime
        row.size_bytes = size
        row.uploaded_at = datetime.now(timezone.utc)
        db.flush()
        try:
            delete_stored(old)
        except FileNotFoundError:
            pass
    db.commit()
    db.refresh(row)
    return _out(row)


@router.get("/image")
def my_signature_image(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> Response:
    require_mentor(session)
    row = _mine(db, session)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No signature on file.")
    try:
        content = read_bytes(row.stored_name)
    except FileNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Stored file is missing.")
    ext = "png" if row.mime_type == "image/png" else "jpg"
    return Response(
        content=content,
        media_type=row.mime_type,
        headers={
            "Content-Disposition": content_disposition(f"signature.{ext}", inline=True),
            "Cache-Control": "private, no-store",
        },
    )


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def remove_signature(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> Response:
    require_mentor(session)
    row = _mine(db, session)
    if row is not None:
        try:
            delete_stored(row.stored_name)
        except FileNotFoundError:
            pass
        db.delete(row)
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
