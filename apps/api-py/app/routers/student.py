"""Student self-service endpoints. First slice: read your own profile."""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from collections import defaultdict
from datetime import datetime

from ..db import get_db
from ..deps import get_current_session
from ..models.academics import SemesterResult
from ..models.attendance import AttendanceRecord
from ..models.mock import MockAttempt
from ..models.profile import StudentProfile
from ..models.skill import StudentSkill
from ..models.swoc import SwocEntry
from ..models.user import Student

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


class CourseAttendanceOut(BaseModel):
    course_code: str
    present: int
    total: int
    percent: float


class AttendanceSummaryOut(BaseModel):
    overall_percent: float
    present: int
    total: int
    by_course: list[CourseAttendanceOut]


@router.get("/attendance", response_model=AttendanceSummaryOut)
def my_attendance(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> AttendanceSummaryOut:
    student_id = _require_student(session)
    rows = db.execute(
        select(AttendanceRecord.course_code, AttendanceRecord.present).where(
            AttendanceRecord.student_id == student_id
        )
    ).all()

    per_course: dict[str, list[int]] = defaultdict(lambda: [0, 0])  # code -> [present, total]
    present_total = grand_total = 0
    for course_code, present in rows:
        per_course[course_code][1] += 1
        grand_total += 1
        if present:
            per_course[course_code][0] += 1
            present_total += 1

    def pct(p: int, t: int) -> float:
        return round(100 * p / t, 1) if t else 0.0

    by_course = [
        CourseAttendanceOut(course_code=code, present=p, total=t, percent=pct(p, t))
        for code, (p, t) in sorted(per_course.items())
    ]
    return AttendanceSummaryOut(
        overall_percent=pct(present_total, grand_total),
        present=present_total,
        total=grand_total,
        by_course=by_course,
    )


class DashboardOut(BaseModel):
    name: str
    usn: str | None
    current_stage: str
    current_semester: int
    latest_cgpa: float | None
    attendance_percent: float


@router.get("/dashboard", response_model=DashboardOut)
def dashboard(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> DashboardOut:
    """One call for the landing page: REEP stage, latest CGPA, and attendance %."""
    student_id = _require_student(session)
    stu = db.get(Student, student_id)
    if stu is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")

    latest = db.scalar(
        select(SemesterResult)
        .where(SemesterResult.student_id == student_id)
        .order_by(SemesterResult.semester.desc())
        .limit(1)
    )
    att = db.execute(
        select(AttendanceRecord.present).where(AttendanceRecord.student_id == student_id)
    ).all()
    total = len(att)
    present = sum(1 for (p,) in att if p)

    return DashboardOut(
        name=session.get("name", ""),
        usn=stu.usn,
        current_stage=stu.current_stage.value,
        current_semester=stu.current_semester,
        latest_cgpa=latest.cgpa if latest else None,
        attendance_percent=round(100 * present / total, 1) if total else 0.0,
    )


class SwocItemOut(BaseModel):
    source: str
    text: str
    weight: int


class SwocBoardOut(BaseModel):
    strengths: list[SwocItemOut]
    weaknesses: list[SwocItemOut]
    opportunities: list[SwocItemOut]
    challenges: list[SwocItemOut]


@router.get("/swoc", response_model=SwocBoardOut)
def my_swoc(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> SwocBoardOut:
    student_id = _require_student(session)
    rows = db.scalars(
        select(SwocEntry)
        .where(SwocEntry.student_id == student_id)
        .order_by(SwocEntry.weight.desc())
    ).all()
    buckets: dict[str, list[SwocItemOut]] = {
        "STRENGTH": [],
        "WEAKNESS": [],
        "OPPORTUNITY": [],
        "CHALLENGE": [],
    }
    for r in rows:
        buckets[r.kind.value].append(
            SwocItemOut(source=r.source.value, text=r.text, weight=r.weight)
        )
    return SwocBoardOut(
        strengths=buckets["STRENGTH"],
        weaknesses=buckets["WEAKNESS"],
        opportunities=buckets["OPPORTUNITY"],
        challenges=buckets["CHALLENGE"],
    )


class MockAttemptOut(BaseModel):
    type: str
    taken_on: datetime
    score: float | None
    max_score: float | None
    percent: float | None
    notes: str | None


@router.get("/mocks", response_model=list[MockAttemptOut])
def my_mocks(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[MockAttemptOut]:
    student_id = _require_student(session)
    rows = db.scalars(
        select(MockAttempt)
        .where(MockAttempt.student_id == student_id)
        .order_by(MockAttempt.taken_on.desc())
    ).all()
    return [
        MockAttemptOut(
            type=r.type.value,
            taken_on=r.taken_on,
            score=r.score,
            max_score=r.max_score,
            percent=(
                round(100 * r.score / r.max_score, 1)
                if (r.score is not None and r.max_score)
                else None
            ),
            notes=r.notes,
        )
        for r in rows
    ]


class StudentSkillOut(BaseModel):
    slug: str
    name: str
    category: str
    level: int
    verified: bool


@router.get("/skills", response_model=list[StudentSkillOut])
def my_skills(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[StudentSkillOut]:
    student_id = _require_student(session)
    rows = db.scalars(
        select(StudentSkill).where(StudentSkill.student_id == student_id)
    ).all()
    out = [
        StudentSkillOut(
            slug=r.skill.slug,
            name=r.skill.name,
            category=r.skill.category,
            level=r.level,
            verified=r.verified,
        )
        for r in rows
    ]
    # Grouped by category, strongest first within each.
    return sorted(out, key=lambda s: (s.category, -s.level))
