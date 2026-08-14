"""Student self-service endpoints. First slice: read your own profile."""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from collections import defaultdict
from datetime import date, datetime, timedelta

from ..db import get_db
from ..deps import get_current_session
from ..models.academic_history import AcademicGap, AcademicQualification
from ..models.academics import SemesterResult
from ..models.attendance import AttendanceRecord
from ..models.mock import MockAttempt
from ..models.profile import StudentProfile
from ..models.skill import StudentSkill
from ..models.swoc import SwocEntry
from ..models.timesheet import TimeSheetEntry
from ..models.user import LoginDay, Student

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


class StreakOut(BaseModel):
    current: int
    longest: int
    days_active: int
    last_active: date | None


@router.get("/streak", response_model=StreakOut)
def my_streak(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> StreakOut:
    """Login streak from LoginDay (one row per active day). Current counts back
    from today (or yesterday, so an as-yet-unopened today doesn't break it)."""
    days = sorted(
        set(db.scalars(select(LoginDay.day).where(LoginDay.user_id == session["userId"])).all())
    )
    if not days:
        return StreakOut(current=0, longest=0, days_active=0, last_active=None)

    longest = run = 1
    for prev, cur in zip(days, days[1:]):
        run = run + 1 if cur - prev == timedelta(days=1) else 1
        longest = max(longest, run)

    today = date.today()
    current = 0
    if days[-1] in (today, today - timedelta(days=1)):
        current = 1
        i = len(days) - 1
        while i > 0 and days[i] - days[i - 1] == timedelta(days=1):
            current += 1
            i -= 1

    return StreakOut(
        current=current, longest=longest, days_active=len(days), last_active=days[-1]
    )


class TimeSheetEntryOut(BaseModel):
    day: date
    activity: str
    minutes: int


class TimeSheetSummaryOut(BaseModel):
    window_days: int
    by_activity_minutes: dict[str, int]
    skilling_hours: float
    weekly_hour_target: float
    entries: list[TimeSheetEntryOut]


@router.get("/timesheet", response_model=TimeSheetSummaryOut)
def my_timesheet(
    days: int = 7,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> TimeSheetSummaryOut:
    """The self-learning time log over the last `days`, with per-activity totals
    and the SKILLING-hours-vs-target the chart draws."""
    student_id = _require_student(session)
    window = max(1, min(days, 90))
    since = date.today() - timedelta(days=window - 1)
    rows = db.scalars(
        select(TimeSheetEntry)
        .where(TimeSheetEntry.student_id == student_id, TimeSheetEntry.day >= since)
        .order_by(TimeSheetEntry.day)
    ).all()

    by_activity: dict[str, int] = {}
    for r in rows:
        by_activity[r.activity.value] = by_activity.get(r.activity.value, 0) + r.minutes

    stu = db.get(Student, student_id)
    return TimeSheetSummaryOut(
        window_days=window,
        by_activity_minutes=by_activity,
        skilling_hours=round(by_activity.get("SKILLING", 0) / 60, 1),
        weekly_hour_target=stu.weekly_hour_target if stu else 12.0,
        entries=[
            TimeSheetEntryOut(day=r.day, activity=r.activity.value, minutes=r.minutes) for r in rows
        ],
    )


class QualificationOut(BaseModel):
    level: str
    institution: str
    board: str | None
    year: int
    marks: float
    max_marks: float
    percent: float
    medium: str | None
    location: str | None
    subjects: str | None


class AcademicGapOut(BaseModel):
    twelfth_to_grad_mo: int
    diploma_to_grad_mo: int
    grad_to_pg_mo: int
    other_mo: int
    total_mo: int


class AcademicsOut(BaseModel):
    qualifications: list[QualificationOut]
    gap: AcademicGapOut


@router.get("/academics", response_model=AcademicsOut)
def my_academics(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> AcademicsOut:
    student_id = _require_student(session)
    quals = db.scalars(
        select(AcademicQualification)
        .where(AcademicQualification.student_id == student_id)
        .order_by(AcademicQualification.year)
    ).all()
    gap = db.get(AcademicGap, student_id)
    gap_out = AcademicGapOut(
        twelfth_to_grad_mo=gap.twelfth_to_grad_mo if gap else 0,
        diploma_to_grad_mo=gap.diploma_to_grad_mo if gap else 0,
        grad_to_pg_mo=gap.grad_to_pg_mo if gap else 0,
        other_mo=gap.other_mo if gap else 0,
        total_mo=(
            gap.twelfth_to_grad_mo + gap.diploma_to_grad_mo + gap.grad_to_pg_mo + gap.other_mo
            if gap
            else 0
        ),
    )
    return AcademicsOut(
        qualifications=[
            QualificationOut(
                level=q.level.value,
                institution=q.institution,
                board=q.board,
                year=q.year,
                marks=q.marks,
                max_marks=q.max_marks,
                percent=round(100 * q.marks / q.max_marks, 1) if q.max_marks else 0.0,
                medium=q.medium,
                location=q.location,
                subjects=q.subjects,
            )
            for q in quals
        ],
        gap=gap_out,
    )
