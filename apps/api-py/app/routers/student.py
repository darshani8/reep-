"""Student self-service endpoints. First slice: read your own profile."""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_session
from ..models.academics import SemesterResult
from ..models.profile import StudentProfile

router = APIRouter(prefix="/student", tags=["student"])


class ProfileOut(BaseModel):
    student_id: str
    phone: str | None
    email: str | None
    linkedin_url: str | None
    github_url: str | None
    portfolio_url: str | None
    city: str | None
    career_summary: str | None
    placement_eligible: bool
    interested_in_jobs: bool
    interested_in_internships: bool
    education: list
    experience: list
    projects: list
    skills: list
    achievements: list
    leaderboard_opt_out: bool


@router.get("/profile", response_model=ProfileOut)
def my_profile(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> ProfileOut:
    student_id = session.get("studentId")
    if not student_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Not a student account."
        )
    prof = db.scalar(select(StudentProfile).where(StudentProfile.student_id == student_id))
    if prof is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No profile yet.")
    return ProfileOut(
        student_id=prof.student_id,
        phone=prof.phone,
        email=prof.email,
        linkedin_url=prof.linkedin_url,
        github_url=prof.github_url,
        portfolio_url=prof.portfolio_url,
        city=prof.city,
        career_summary=prof.career_summary,
        placement_eligible=prof.placement_eligible,
        interested_in_jobs=prof.interested_in_jobs,
        interested_in_internships=prof.interested_in_internships,
        education=prof.education or [],
        experience=prof.experience or [],
        projects=prof.projects or [],
        skills=prof.skills or [],
        achievements=prof.achievements or [],
        leaderboard_opt_out=prof.leaderboard_opt_out,
    )


class SubjectMarkOut(BaseModel):
    subject_code: str
    subject_name: str
    credits: int
    internal: int
    external: int
    total: int
    passed: bool


class SemesterResultOut(BaseModel):
    semester: int
    sgpa: float | None
    cgpa: float | None
    closed_backlogs: int
    live_backlogs: int
    result_class: str | None
    subjects: list[SubjectMarkOut]


def _require_student(session: dict) -> str:
    student_id = session.get("studentId")
    if not student_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a student account.")
    return student_id


@router.get("/results", response_model=list[SemesterResultOut])
def my_results(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[SemesterResultOut]:
    student_id = _require_student(session)
    rows = db.scalars(
        select(SemesterResult)
        .where(SemesterResult.student_id == student_id)
        .order_by(SemesterResult.semester)
    ).all()
    return [
        SemesterResultOut(
            semester=r.semester,
            sgpa=r.sgpa,
            cgpa=r.cgpa,
            closed_backlogs=r.closed_backlogs,
            live_backlogs=r.live_backlogs,
            result_class=r.result_class,
            subjects=[
                SubjectMarkOut(
                    subject_code=s.subject_code,
                    subject_name=s.subject_name,
                    credits=s.credits,
                    internal=s.internal,
                    external=s.external,
                    total=s.total,
                    passed=s.passed,
                )
                for s in r.subjects
            ],
        )
        for r in rows
    ]
