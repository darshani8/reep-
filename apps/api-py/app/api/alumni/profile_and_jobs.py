"""Alumni area — the profile an alumnus creates on first sign-in, and the jobs
sheet.

ALUMNI only, and their OWN row only: an alumnus is neither staff (rule 2's gate
never admits them) nor a student (no Student row, so every /student endpoint
already refuses them). The two surfaces here are deliberately small:

  * GET/POST /alumni/profile — `created: false` from the GET is what sends the
    client to the first-login create form; the POST upserts (company required,
    resume through the same hardened document_store as student uploads).
  * GET /alumni/jobs — the postings sheet, WITHOUT the student feed's match %
    and eligibility verdict: those are computed from a Student's skills and
    marks, which an alumnus does not have. Public posting fields only, so
    rule 1 is untouched — nothing here goes near a model.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.platform.identity import get_current_session
from app.platform.document_store import MAX_BYTES, UploadRejected, content_disposition
from app.platform.document_store import delete as document_store_delete
from app.platform.document_store import read_bytes, save_bytes
from app.models.alumni import AlumniProfile
from app.models.job import Job

router = APIRouter(prefix="/alumni", tags=["alumni"])


def require_alumni(session: dict) -> dict:
    if session.get("role") != "ALUMNI":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Alumni access required.")
    return session


class ResumeOut(BaseModel):
    original_name: str
    mime_type: str
    size_bytes: int


class ProfileOut(BaseModel):
    # False => the client shows the first-login create form. Branch on this,
    # never on a falsy company string.
    created: bool
    name: str
    email: str
    company: str | None = None
    designation: str | None = None
    graduation_year: int | None = None
    resume: ResumeOut | None = None
    updated_at: datetime | None = None


def _profile_out(session: dict, prof: AlumniProfile | None) -> ProfileOut:
    if prof is None:
        return ProfileOut(created=False, name=session["name"], email=session["email"])
    resume = None
    if prof.resume_stored_name:
        resume = ResumeOut(
            original_name=prof.resume_original_name or "resume",
            mime_type=prof.resume_mime_type or "application/octet-stream",
            size_bytes=prof.resume_size_bytes or 0,
        )
    return ProfileOut(
        created=True,
        name=session["name"],
        email=session["email"],
        company=prof.company,
        designation=prof.designation,
        graduation_year=prof.graduation_year,
        resume=resume,
        updated_at=prof.updated_at,
    )


def _own_profile(session: dict, db: Session) -> AlumniProfile | None:
    return db.scalar(select(AlumniProfile).where(AlumniProfile.user_id == session["userId"]))


@router.get("/profile", response_model=ProfileOut)
def my_profile(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> ProfileOut:
    require_alumni(session)
    return _profile_out(session, _own_profile(session, db))


@router.post("/profile", response_model=ProfileOut)
def save_profile(
    company: str = Form(...),
    designation: str = Form(""),
    graduation_year: int | None = Form(None),
    resume: UploadFile | None = File(None),
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> ProfileOut:
    """Create on first call, update after. Sync `def` for the same event-loop
    reason as every other upload endpoint (see student.create_upload).

    The resume is required on CREATE — the first-login flow's whole point is
    "company + current resume" — and optional on update, where omitting it means
    "keep the one on file".
    """
    require_alumni(session)
    company = company.strip()
    if not company:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Company is required."
        )
    if graduation_year is not None and not (1990 <= graduation_year <= datetime.now().year + 1):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Graduation year looks wrong.",
        )

    prof = _own_profile(session, db)
    if prof is None and (resume is None or not resume.filename):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Upload your current resume to create your profile.",
        )

    stored = None
    if resume is not None and resume.filename:
        # read(MAX+1), never read(): save_bytes refuses anything past the
        # per-file cap, so one extra byte trips it without buffering an
        # unbounded body in RAM (api/student/self_service.py create_upload, same
        # reasoning).
        content = resume.file.read(MAX_BYTES + 1)
        try:
            stored = save_bytes(content)  # (stored_name, mime, size)
        except UploadRejected as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
            )

    if prof is None:
        prof = AlumniProfile(user_id=session["userId"], company=company)
        db.add(prof)

    prof.company = company
    prof.designation = designation.strip() or None
    prof.graduation_year = graduation_year
    if stored is not None:
        # Replacing the resume: drop the old bytes BEFORE the row points at the
        # new ones, so a crash between the two leaves a dangling file, never a
        # row naming bytes that are gone.
        if prof.resume_stored_name:
            document_store_delete(prof.resume_stored_name)
        stored_name, mime, size = stored
        prof.resume_original_name = resume.filename
        prof.resume_stored_name = stored_name
        prof.resume_mime_type = mime
        prof.resume_size_bytes = size

    db.commit()
    db.refresh(prof)
    return _profile_out(session, prof)


@router.get("/profile/resume")
def download_resume(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> Response:
    require_alumni(session)
    prof = _own_profile(session, db)
    if prof is None or not prof.resume_stored_name:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No resume on file.")
    try:
        content = read_bytes(prof.resume_stored_name)
    except FileNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Stored file is missing.")
    return Response(
        content=content,
        media_type=prof.resume_mime_type or "application/octet-stream",
        headers={
            "Content-Disposition": content_disposition(prof.resume_original_name or "resume")
        },
    )


class JobSheetRowOut(BaseModel):
    id: str
    title: str
    company: str
    degree_level: str
    location: str | None
    apply_url: str | None
    required_skills: list[str]
    closes_on: str | None
    posted_on: str | None


@router.get("/jobs", response_model=list[JobSheetRowOut])
def jobs_sheet(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[JobSheetRowOut]:
    require_alumni(session)
    return [
        JobSheetRowOut(
            id=j.id,
            title=j.title,
            company=j.company,
            degree_level=j.degree_level.value,
            location=j.location,
            apply_url=j.apply_url,
            required_skills=j.required_skills or [],
            closes_on=j.closes_on.isoformat() if j.closes_on else None,
            posted_on=j.posted_on.isoformat() if j.posted_on else None,
        )
        for j in db.scalars(select(Job).order_by(Job.posted_on.desc())).all()
    ]
