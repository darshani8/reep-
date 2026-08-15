"""Student self-service endpoints. First slice: read your own profile."""

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from ..ai.llm import complete_chat, llm_config, student_data_egress_allowed
from ..db import get_db
from ..deps import get_current_session
from ..filestore import UploadRejected, read_bytes, save_bytes
from ..resume_pdf import render_resume_pdf
from ..models.academic_history import AcademicGap, AcademicQualification
from ..models.academics import SemesterResult
from ..models.attendance import AttendanceRecord
from ..models.certification import Certification, CertificationProgress
from ..models.course import Course, Enrollment, ProgressStatus
from ..models.job import Job, JobApplication
from ..models.lab import ActivityType, CheckInSource, LabSession, LearningMode
from ..models.mock import MockAttempt
from ..models.offer import (
    OfferChannel,
    OfferRoleType,
    OfferStatus,
    OfferWorkMode,
    PlacementOffer,
)
from ..models.placement_criteria import PlacementCriteria
from ..models.profile import StudentProfile
from ..models.resume import Resume, ResumeStatus
from ..models.schedule import ScheduleItem
from ..models.skill import Skill, SkillClaim, StudentSkill
from ..models.swoc import SwocEntry
from ..models.resume_profile import ResumeProfile
from ..models.timesheet import DayActivity, TimeSheetEntry
from ..models.upload import Upload, UploadKind, UploadStatus
from ..models.user import LoginDay, Student, User

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


class SkillCatalogueOut(BaseModel):
    id: str
    slug: str
    name: str
    category: str


@router.get("/skills/catalogue", response_model=list[SkillCatalogueOut])
def skills_catalogue(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[SkillCatalogueOut]:
    """The full skill catalogue — what a student picks from when filing a claim."""
    _require_student(session)
    rows = db.scalars(select(Skill).order_by(Skill.category, Skill.name)).all()
    return [
        SkillCatalogueOut(id=s.id, slug=s.slug, name=s.name, category=s.category) for s in rows
    ]


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


class JobRowOut(BaseModel):
    id: str
    title: str
    company: str
    degree_level: str
    location: str | None
    apply_url: str | None
    required_skills: list[str]
    match_percent: float
    eligible: bool
    reasons: list[str]
    applied: bool


@router.get("/jobs", response_model=list[JobRowOut])
def my_jobs(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[JobRowOut]:
    """The opportunities feed with a per-row skill match % and the eligibility
    verdict (per-posting CGPA / live-backlog gates)."""
    student_id = _require_student(session)

    skill_slugs = set(
        db.scalars(
            select(Skill.slug)
            .join(StudentSkill, StudentSkill.skill_id == Skill.id)
            .where(StudentSkill.student_id == student_id)
        ).all()
    )
    latest = db.scalar(
        select(SemesterResult)
        .where(SemesterResult.student_id == student_id)
        .order_by(SemesterResult.semester.desc())
        .limit(1)
    )
    latest_cgpa = latest.cgpa if latest else None
    live_backlogs = (
        db.scalar(
            select(func.coalesce(func.sum(SemesterResult.live_backlogs), 0)).where(
                SemesterResult.student_id == student_id
            )
        )
        or 0
    )
    applied_ids = set(
        db.scalars(
            select(JobApplication.job_id).where(JobApplication.student_id == student_id)
        ).all()
    )
    # Active placement criteria supply the defaults when a posting has no override.
    crit = db.scalar(
        select(PlacementCriteria)
        .where(PlacementCriteria.active.is_(True))
        .order_by(PlacementCriteria.updated_at.desc())
        .limit(1)
    )
    gap = db.get(AcademicGap, student_id)
    gap_months = (
        gap.twelfth_to_grad_mo + gap.diploma_to_grad_mo + gap.grad_to_pg_mo + gap.other_mo
        if gap
        else 0
    )

    rows: list[JobRowOut] = []
    for j in db.scalars(select(Job).order_by(Job.posted_on.desc())).all():
        required = set(j.required_skills or [])
        match = round(100 * len(skill_slugs & required) / len(required), 1) if required else 100.0
        # Per-posting override wins; else fall back to the active criteria.
        min_cgpa = j.min_cgpa if j.min_cgpa is not None else (crit.min_cgpa if crit else None)
        max_backlogs = (
            j.max_live_backlogs
            if j.max_live_backlogs is not None
            else (crit.max_live_backlogs if crit else None)
        )
        max_gap = crit.max_gap_months if crit else None
        reasons: list[str] = []
        # A null CGPA is unassessed (not blocking); only an actual below-cutoff blocks.
        if min_cgpa is not None and latest_cgpa is not None and latest_cgpa < min_cgpa:
            reasons.append(f"CGPA {latest_cgpa} is below the required {min_cgpa}")
        if max_backlogs is not None and live_backlogs > max_backlogs:
            reasons.append(f"{live_backlogs} live backlog(s) exceeds the limit of {max_backlogs}")
        if max_gap is not None and gap_months > max_gap:
            reasons.append(f"education gap {gap_months}mo exceeds the limit of {max_gap}mo")
        rows.append(
            JobRowOut(
                id=j.id,
                title=j.title,
                company=j.company,
                degree_level=j.degree_level.value,
                location=j.location,
                apply_url=j.apply_url,
                required_skills=j.required_skills or [],
                match_percent=match,
                eligible=not reasons,
                reasons=reasons,
                applied=j.id in applied_ids,
            )
        )
    return rows


class ApplyIn(BaseModel):
    notes: str | None = None


@router.post("/jobs/{job_id}/apply")
def apply_to_job(
    job_id: str,
    body: ApplyIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> dict:
    student_id = _require_student(session)
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found.")
    existing = db.scalar(
        select(JobApplication).where(
            JobApplication.student_id == student_id, JobApplication.job_id == job_id
        )
    )
    if existing:
        return {"applied": True, "already": True}
    db.add(JobApplication(student_id=student_id, job_id=job_id, notes=body.notes))
    db.commit()
    return {"applied": True, "already": False}


class OfferIn(BaseModel):
    role_type: str
    job_title: str
    organisation: str
    channel: str = "ON_CAMPUS"
    work_mode: str = "ONSITE"
    location: str | None = None
    ctc_inr: int = 0
    fixed_gross_inr: int = 0
    joining_date: datetime | None = None
    job_id: str | None = None


class OfferOut(BaseModel):
    id: str
    role_type: str
    job_title: str
    organisation: str
    channel: str
    work_mode: str
    location: str | None
    ctc_inr: int
    fixed_gross_inr: int
    status: str


def _offer_out(o: PlacementOffer) -> OfferOut:
    return OfferOut(
        id=o.id,
        role_type=o.role_type.value,
        job_title=o.job_title,
        organisation=o.organisation,
        channel=o.channel.value,
        work_mode=o.work_mode.value,
        location=o.location,
        ctc_inr=o.ctc_inr,
        fixed_gross_inr=o.fixed_gross_inr,
        status=o.status.value,
    )


@router.post("/offers", response_model=OfferOut, status_code=status.HTTP_201_CREATED)
def create_offer(
    body: OfferIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> OfferOut:
    student_id = _require_student(session)
    try:
        role = OfferRoleType(body.role_type)
        channel = OfferChannel(body.channel)
        mode = OfferWorkMode(body.work_mode)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid role_type / channel / work_mode.",
        )
    offer = PlacementOffer(
        student_id=student_id,
        role_type=role,
        job_title=body.job_title,
        organisation=body.organisation,
        channel=channel,
        work_mode=mode,
        location=body.location,
        ctc_inr=body.ctc_inr,
        fixed_gross_inr=body.fixed_gross_inr,
        joining_date=body.joining_date,
        job_id=body.job_id,
        status=OfferStatus.DRAFT,
    )
    db.add(offer)
    db.commit()
    db.refresh(offer)
    return _offer_out(offer)


@router.get("/offers", response_model=list[OfferOut])
def list_offers(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[OfferOut]:
    student_id = _require_student(session)
    rows = db.scalars(
        select(PlacementOffer)
        .where(PlacementOffer.student_id == student_id)
        .order_by(PlacementOffer.created_at.desc())
    ).all()
    return [_offer_out(o) for o in rows]


@router.post("/offers/{offer_id}/submit", response_model=OfferOut)
def submit_offer(
    offer_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> OfferOut:
    student_id = _require_student(session)
    offer = db.get(PlacementOffer, offer_id)
    if offer is None or offer.student_id != student_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Offer not found.")
    if offer.status != OfferStatus.DRAFT:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Only a draft offer can be submitted."
        )
    offer.status = OfferStatus.PENDING_APPROVAL
    db.commit()
    db.refresh(offer)
    return _offer_out(offer)


def _profile_out(prof: StudentProfile) -> ProfileOut:
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


class ProfileUpdateIn(BaseModel):
    phone: str | None = None
    email: str | None = None
    linkedin_url: str | None = None
    github_url: str | None = None
    portfolio_url: str | None = None
    city: str | None = None
    career_summary: str | None = None
    interested_in_jobs: bool | None = None
    interested_in_internships: bool | None = None
    leaderboard_opt_out: bool | None = None
    education: list | None = None
    experience: list | None = None
    projects: list | None = None
    achievements: list | None = None


@router.put("/profile", response_model=ProfileOut)
def update_profile(
    body: ProfileUpdateIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> ProfileOut:
    """Edit your own profile. Only the fields sent are changed; placement_eligible
    is admin-set and intentionally absent from the editable set."""
    student_id = _require_student(session)
    prof = db.scalar(select(StudentProfile).where(StudentProfile.student_id == student_id))
    if prof is None:
        prof = StudentProfile(student_id=student_id)
        db.add(prof)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(prof, field, value)
    db.commit()
    db.refresh(prof)
    return _profile_out(prof)


class ScheduleItemOut(BaseModel):
    id: str
    type: str
    title: str
    starts_at: datetime
    location: str | None
    course_code: str | None


@router.get("/schedule", response_model=list[ScheduleItemOut])
def my_schedule(
    upcoming: bool = True,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[ScheduleItemOut]:
    student_id = _require_student(session)
    query = select(ScheduleItem).where(ScheduleItem.student_id == student_id)
    if upcoming:
        query = query.where(ScheduleItem.starts_at >= datetime.now(timezone.utc))
    rows = db.scalars(query.order_by(ScheduleItem.starts_at)).all()
    return [
        ScheduleItemOut(
            id=i.id,
            type=i.type.value,
            title=i.title,
            starts_at=i.starts_at,
            location=i.location,
            course_code=i.course_code,
        )
        for i in rows
    ]


class TimeSheetLogIn(BaseModel):
    day: date
    activity: str  # DayActivity
    minutes: int = Field(ge=0, le=1440)


@router.post("/timesheet")
def log_timesheet(
    body: TimeSheetLogIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> dict:
    """Upsert the minutes for one (day, activity) — one row per bucket per day."""
    student_id = _require_student(session)
    try:
        activity = DayActivity(body.activity)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid activity."
        )
    entry = db.scalar(
        select(TimeSheetEntry).where(
            TimeSheetEntry.student_id == student_id,
            TimeSheetEntry.day == body.day,
            TimeSheetEntry.activity == activity,
        )
    )
    if entry is None:
        entry = TimeSheetEntry(
            student_id=student_id, day=body.day, activity=activity, minutes=body.minutes
        )
        db.add(entry)
    else:
        entry.minutes = body.minutes
    db.commit()
    return {"day": str(body.day), "activity": activity.value, "minutes": body.minutes}


def _compose_resume_markdown(name, profile, skill_names, cgpa, quals) -> str:
    lines = [f"# {name or 'REEP Student'}", ""]
    if profile and profile.career_summary:
        lines += [profile.career_summary, ""]
    contact = []
    if profile:
        contact = [x for x in (profile.email, profile.phone, profile.linkedin_url, profile.city) if x]
    if contact:
        lines += ["**Contact:** " + " · ".join(contact), ""]
    lines += ["## Skills", ", ".join(skill_names) if skill_names else "—", ""]
    lines += ["## Academics", f"- Latest CGPA: {cgpa}" if cgpa is not None else "- CGPA: not yet assessed"]
    for q in quals:
        pct = round(100 * q.marks / q.max_marks) if q.max_marks else 0
        lines.append(f"- {q.level.value.title()}: {q.institution} ({q.year}) — {pct}%")
    return "\n".join(lines)


class ResumeGenerateIn(BaseModel):
    title: str | None = None
    target_role: str | None = None


@router.post("/resume/generate")
def generate_resume(
    body: ResumeGenerateIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> dict:
    """Compose a resume from the student's REEP data. The prompt carries student
    PII, so a model is used ONLY when it is local or explicitly allowed; otherwise
    it composes deterministically and says so (the AGENTS.md egress rule)."""
    student_id = _require_student(session)
    name = session.get("name", "")
    profile = db.scalar(select(StudentProfile).where(StudentProfile.student_id == student_id))
    skill_names = list(
        db.scalars(
            select(Skill.name)
            .join(StudentSkill, StudentSkill.skill_id == Skill.id)
            .where(StudentSkill.student_id == student_id)
        ).all()
    )
    latest = db.scalar(
        select(SemesterResult)
        .where(SemesterResult.student_id == student_id)
        .order_by(SemesterResult.semester.desc())
        .limit(1)
    )
    cgpa = latest.cgpa if latest else None
    quals = db.scalars(
        select(AcademicQualification)
        .where(AcademicQualification.student_id == student_id)
        .order_by(AcademicQualification.year)
    ).all()

    markdown = _compose_resume_markdown(name, profile, skill_names, cgpa, quals)
    generated_by, model, used_ai, note = "fallback", None, False, None

    cfg = llm_config()
    if cfg is not None and student_data_egress_allowed(cfg.base_url):
        prompt = (
            "Rewrite this into a crisp one-page markdown resume for an MBA student. "
            "Keep every fact; invent nothing.\n\n" + markdown
        )
        try:
            markdown = complete_chat(
                [
                    {"role": "system", "content": "You are a concise resume writer."},
                    {"role": "user", "content": prompt},
                ],
                carries_student_data=True,
                max_tokens=1500,
            )
            generated_by, model, used_ai = cfg.provider, cfg.model, True
        except Exception as exc:  # keep the deterministic draft on any failure
            note = f"AI polish failed ({exc}); kept the deterministic draft."
    else:
        note = (
            "AI generation skipped: the resume carries student data and the configured "
            "model runs off this machine. Composed deterministically. Set "
            "LLM_ALLOW_REMOTE_STUDENT_DATA=true or use a local model to enable AI."
        )

    version = (
        db.scalar(select(func.max(Resume.version)).where(Resume.student_id == student_id)) or 0
    ) + 1
    resume = Resume(
        student_id=student_id,
        version=version,
        title=body.title or "REEP Resume",
        target_role=body.target_role,
        status=ResumeStatus.GENERATED,
        content={},
        markdown=markdown,
        generated_by=generated_by,
        model=model,
    )
    db.add(resume)
    db.commit()
    db.refresh(resume)
    return {
        "id": resume.id,
        "version": version,
        "generated_by": generated_by,
        "model": model,
        "used_ai": used_ai,
        "note": note,
        "markdown": markdown,
    }


class ResumeOut(BaseModel):
    id: str
    version: int
    title: str
    status: str
    generated_by: str
    model: str | None


@router.get("/resume", response_model=list[ResumeOut])
def list_resumes(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[ResumeOut]:
    student_id = _require_student(session)
    rows = db.scalars(
        select(Resume).where(Resume.student_id == student_id).order_by(Resume.created_at.desc())
    ).all()
    return [
        ResumeOut(
            id=r.id,
            version=r.version,
            title=r.title,
            status=r.status.value,
            generated_by=r.generated_by,
            model=r.model,
        )
        for r in rows
    ]


@router.get("/resume/{resume_id}/pdf")
def resume_pdf(
    resume_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> Response:
    """Render one of the student's own resumes to a PDF. Local render (no model,
    no network), so the egress gate does not apply — but ownership does: a
    student can only export their own resume."""
    student_id = _require_student(session)
    resume = db.get(Resume, resume_id)
    if resume is None or resume.student_id != student_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Resume not found.")
    pdf = render_resume_pdf(resume.markdown or "", fallback_title=resume.title or "REEP Resume")
    filename = f"resume-v{resume.version}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


class CourseOut(BaseModel):
    code: str
    name: str
    stage: str
    dimension: str
    semester: int
    status: str
    teaching_hours_attended: float
    self_learning_hours_logged: float
    lectures_attended: int
    lectures_total: int
    lecture_percent: float


@router.get("/courses", response_model=list[CourseOut])
def my_courses(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[CourseOut]:
    student_id = _require_student(session)
    rows = db.execute(
        select(Enrollment, Course)
        .join(Course, Enrollment.course_code == Course.code)
        .where(Enrollment.student_id == student_id)
        .order_by(Course.semester, Course.code)
    ).all()
    return [
        CourseOut(
            code=course.code,
            name=course.name,
            stage=course.stage.value,
            dimension=course.dimension.value,
            semester=course.semester,
            status=enr.status.value,
            teaching_hours_attended=enr.teaching_hours_attended,
            self_learning_hours_logged=enr.self_learning_hours_logged,
            lectures_attended=enr.lectures_attended,
            lectures_total=enr.lectures_total,
            lecture_percent=(
                round(100 * enr.lectures_attended / enr.lectures_total, 1)
                if enr.lectures_total
                else 0.0
            ),
        )
        for enr, course in rows
    ]


class CertProgressOut(BaseModel):
    code: str
    name: str
    provider: str
    status: str
    progress_pct: float
    hours_logged: float
    required_hours: float
    due_date: datetime
    self_reported: bool


@router.get("/certifications", response_model=list[CertProgressOut])
def my_certifications(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[CertProgressOut]:
    student_id = _require_student(session)
    rows = db.execute(
        select(CertificationProgress, Certification)
        .join(Certification, CertificationProgress.cert_code == Certification.code)
        .where(CertificationProgress.student_id == student_id)
        .order_by(CertificationProgress.due_date)
    ).all()
    return [
        CertProgressOut(
            code=cert.code,
            name=cert.name,
            provider=cert.provider,
            status=prog.status.value,
            progress_pct=prog.progress_pct,
            hours_logged=prog.hours_logged,
            required_hours=cert.required_hours,
            due_date=prog.due_date,
            self_reported=prog.self_reported,
        )
        for prog, cert in rows
    ]


class CheckInIn(BaseModel):
    course_code: str
    module: str
    activity: str = "ONLINE_COURSE"
    mode: str = "SUPERVISED_LAB"


@router.post("/checkin")
def check_in(
    body: CheckInIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> dict:
    """Open a focus session (self-reported). Close it with /student/checkout/{id}."""
    student_id = _require_student(session)
    try:
        activity = ActivityType(body.activity)
        mode = LearningMode(body.mode)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid activity or mode."
        )
    ls = LabSession(
        student_id=student_id,
        course_code=body.course_code,
        module=body.module,
        activity=activity,
        mode=mode,
        source=CheckInSource.SELF_REPORTED,
        check_in_at=datetime.now(timezone.utc),
    )
    db.add(ls)
    db.commit()
    db.refresh(ls)
    return {"id": ls.id, "check_in_at": ls.check_in_at.isoformat(), "open": True}


@router.post("/checkout/{session_id}")
def check_out(
    session_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> dict:
    student_id = _require_student(session)
    ls = db.get(LabSession, session_id)
    if ls is None or ls.student_id != student_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found.")
    if ls.check_out_at is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Session already closed.")
    now = datetime.now(timezone.utc)
    ls.check_out_at = now
    ls.duration_min = max(0, int((now - ls.check_in_at).total_seconds() // 60))
    db.commit()
    return {"id": ls.id, "duration_min": ls.duration_min, "open": False}


class FocusSessionOut(BaseModel):
    id: str
    course_code: str
    module: str
    activity: str
    mode: str
    check_in_at: datetime
    check_out_at: datetime | None
    duration_min: int | None
    mentor_confirmed: bool


@router.get("/focus", response_model=list[FocusSessionOut])
def my_focus(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[FocusSessionOut]:
    student_id = _require_student(session)
    rows = db.scalars(
        select(LabSession)
        .where(LabSession.student_id == student_id)
        .order_by(LabSession.check_in_at.desc())
    ).all()
    return [
        FocusSessionOut(
            id=ls.id,
            course_code=ls.course_code,
            module=ls.module,
            activity=ls.activity.value,
            mode=ls.mode.value,
            check_in_at=ls.check_in_at,
            check_out_at=ls.check_out_at,
            duration_min=ls.duration_min,
            mentor_confirmed=ls.mentor_confirmed,
        )
        for ls in rows
    ]


class UploadRowOut(BaseModel):
    id: str
    kind: str
    cert_code: str | None
    title: str
    original_name: str
    mime_type: str
    size_bytes: int
    status: str
    review_note: str | None
    reviewed_at: datetime | None
    uploaded_at: datetime


@router.get("/uploads", response_model=list[UploadRowOut])
def my_uploads(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[UploadRowOut]:
    """A student's own submitted documents and their review state."""
    student_id = _require_student(session)
    rows = db.scalars(
        select(Upload)
        .where(Upload.student_id == student_id)
        .order_by(Upload.uploaded_at.desc())
    ).all()
    return [_upload_row(u) for u in rows]


def _upload_row(u: Upload) -> "UploadRowOut":
    return UploadRowOut(
        id=u.id,
        kind=u.kind.value,
        cert_code=u.cert_code,
        title=u.title,
        original_name=u.original_name,
        mime_type=u.mime_type,
        size_bytes=u.size_bytes,
        status=u.status.value,
        review_note=u.review_note,
        reviewed_at=u.reviewed_at,
        uploaded_at=u.uploaded_at,
    )


@router.post("/uploads", response_model=UploadRowOut, status_code=status.HTTP_201_CREATED)
async def create_upload(
    file: UploadFile = File(...),
    kind: str = Form("DOCUMENT"),
    title: str = Form(""),
    cert_code: str | None = Form(None),
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> "UploadRowOut":
    """Upload a document (multipart). The type is decided by magic bytes, not the
    client — PDF/PNG/JPEG only, 10 MB max — and the row starts PENDING_REVIEW."""
    student_id = _require_student(session)
    try:
        upload_kind = UploadKind(kind)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Unknown upload kind."
        )
    content = await file.read()
    try:
        stored_name, mime, size = save_bytes(content)
    except UploadRejected as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))

    upload = Upload(
        student_id=student_id,
        kind=upload_kind,
        cert_code=cert_code or None,
        title=title.strip() or (file.filename or "Upload"),
        original_name=file.filename or stored_name,
        stored_name=stored_name,
        mime_type=mime,
        size_bytes=size,
    )
    db.add(upload)
    db.commit()
    db.refresh(upload)
    return _upload_row(upload)


@router.get("/uploads/{upload_id}/file")
def download_upload(
    upload_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> Response:
    """Stream one of the student's own uploaded files back."""
    student_id = _require_student(session)
    upload = db.get(Upload, upload_id)
    if upload is None or upload.student_id != student_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found.")
    try:
        content = read_bytes(upload.stored_name)
    except FileNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Stored file is missing."
        )
    return Response(
        content=content,
        media_type=upload.mime_type,
        headers={"Content-Disposition": f'inline; filename="{upload.original_name}"'},
    )


class SkillClaimOut(BaseModel):
    id: str
    skill_id: str
    skill_name: str
    upload_id: str
    claimed_level: int
    status: str
    review_note: str | None
    reviewed_at: datetime | None
    created_at: datetime


class SkillClaimIn(BaseModel):
    skill_id: str
    upload_id: str
    claimed_level: int = Field(default=3, ge=1, le=5)


@router.get("/skill-claims", response_model=list[SkillClaimOut])
def my_skill_claims(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[SkillClaimOut]:
    """A student's own skill claims and their review state."""
    student_id = _require_student(session)
    rows = db.execute(
        select(SkillClaim, Skill.name)
        .join(Skill, SkillClaim.skill_id == Skill.id)
        .where(SkillClaim.student_id == student_id)
        .order_by(SkillClaim.created_at.desc())
    ).all()
    return [
        SkillClaimOut(
            id=sc.id,
            skill_id=sc.skill_id,
            skill_name=name,
            upload_id=sc.upload_id,
            claimed_level=sc.claimed_level,
            status=sc.status.value,
            review_note=sc.review_note,
            reviewed_at=sc.reviewed_at,
            created_at=sc.created_at,
        )
        for sc, name in rows
    ]


@router.post("/skill-claims", response_model=SkillClaimOut, status_code=status.HTTP_201_CREATED)
def create_skill_claim(
    body: SkillClaimIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> SkillClaimOut:
    """Claim a skill level, backed by one of your own uploads, for mentor review."""
    student_id = _require_student(session)
    skill = db.get(Skill, body.skill_id)
    if skill is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Skill not found.")
    upload = db.get(Upload, body.upload_id)
    if upload is None or upload.student_id != student_id:
        # Never let a claim point at someone else's upload.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Evidence upload not found."
        )
    claim = SkillClaim(
        student_id=student_id,
        skill_id=body.skill_id,
        upload_id=body.upload_id,
        claimed_level=body.claimed_level,
    )
    db.add(claim)
    db.commit()
    db.refresh(claim)
    return SkillClaimOut(
        id=claim.id,
        skill_id=claim.skill_id,
        skill_name=skill.name,
        upload_id=claim.upload_id,
        claimed_level=claim.claimed_level,
        status=claim.status.value,
        review_note=claim.review_note,
        reviewed_at=claim.reviewed_at,
        created_at=claim.created_at,
    )


# The resume-builder sections that ResumeProfile owns (the ones with no other
# home). Education / certifications / attachments are shown by the builder too
# but come from their own endpoints, so they don't count here.
_RESUME_SECTIONS = [
    "basic", "contact", "family", "experience", "internship", "projects",
    "publications", "seminars", "por", "other", "references", "policy",
]


def _section_filled(value) -> bool:
    """A section counts as filled if it holds any real content."""
    if value in (None, "", [], {}):
        return False
    if isinstance(value, dict):
        return any(_section_filled(v) for v in value.values())
    if isinstance(value, list):
        return len(value) > 0
    return True


def _resume_completeness(data: dict) -> int:
    if not data:
        return 0
    filled = sum(1 for k in _RESUME_SECTIONS if _section_filled(data.get(k)))
    return round(100 * filled / len(_RESUME_SECTIONS))


class ResumeProfileIn(BaseModel):
    data: dict = Field(default_factory=dict)


class ResumeProfileOut(BaseModel):
    data: dict
    completeness: int
    updated_at: datetime | None


@router.get("/resume-profile", response_model=ResumeProfileOut)
def get_resume_profile(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> ResumeProfileOut:
    """The student's saved resume-builder state (the free-form sections)."""
    student_id = _require_student(session)
    row = db.scalar(select(ResumeProfile).where(ResumeProfile.student_id == student_id))
    data = row.data if row else {}
    return ResumeProfileOut(
        data=data,
        completeness=_resume_completeness(data),
        updated_at=row.updated_at if row else None,
    )


@router.put("/resume-profile", response_model=ResumeProfileOut)
def put_resume_profile(
    body: ResumeProfileIn,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> ResumeProfileOut:
    """Upsert the whole builder state for the caller (one row per student)."""
    student_id = _require_student(session)
    row = db.scalar(select(ResumeProfile).where(ResumeProfile.student_id == student_id))
    if row is None:
        row = ResumeProfile(student_id=student_id, data=body.data)
        db.add(row)
    else:
        row.data = body.data
    db.commit()
    db.refresh(row)
    return ResumeProfileOut(
        data=row.data,
        completeness=_resume_completeness(row.data),
        updated_at=row.updated_at,
    )


# --- Leaderboards --------------------------------------------------------------

_BOARDS = ("certificates", "skills", "vtu", "streak", "mocks")


def _initials(name: str) -> str:
    parts = [p for p in name.split() if p]
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def _board_values(db: Session, board: str, roster: list[tuple[str, str]]) -> dict[str, tuple[float, str]]:
    """student_id -> (value, label) for the chosen board, over the cohort roster
    (list of (student_id, user_id)). Students with no activity score 0."""
    sids = [sid for sid, _ in roster]
    uid_by_sid = {sid: uid for sid, uid in roster}
    out: dict[str, tuple[float, str]] = {sid: (0.0, "") for sid in sids}

    if board == "certificates":
        rows = db.execute(
            select(CertificationProgress.student_id, func.count())
            .where(
                CertificationProgress.student_id.in_(sids),
                CertificationProgress.status == ProgressStatus.COMPLETED,
            )
            .group_by(CertificationProgress.student_id)
        ).all()
        counts = {sid: n for sid, n in rows}
        return {sid: (float(counts.get(sid, 0)), f"{counts.get(sid, 0)} certs") for sid in sids}

    if board == "skills":
        rows = db.execute(
            select(StudentSkill.student_id, func.count())
            .where(StudentSkill.student_id.in_(sids))
            .group_by(StudentSkill.student_id)
        ).all()
        counts = {sid: n for sid, n in rows}
        return {sid: (float(counts.get(sid, 0)), f"{counts.get(sid, 0)} skills") for sid in sids}

    if board == "mocks":
        rows = db.execute(
            select(MockAttempt.student_id, func.count())
            .where(MockAttempt.student_id.in_(sids))
            .group_by(MockAttempt.student_id)
        ).all()
        counts = {sid: n for sid, n in rows}
        return {sid: (float(counts.get(sid, 0)), f"{counts.get(sid, 0)} mocks") for sid in sids}

    if board == "vtu":
        # Latest semester's CGPA per student.
        rows = db.execute(
            select(SemesterResult.student_id, SemesterResult.semester, SemesterResult.cgpa)
            .where(SemesterResult.student_id.in_(sids))
            .order_by(SemesterResult.student_id, SemesterResult.semester.desc())
        ).all()
        latest: dict[str, float] = {}
        for sid, _sem, cgpa in rows:
            if sid not in latest:  # first row per student is the highest semester
                latest[sid] = float(cgpa)
        return {sid: (latest.get(sid, 0.0), f"CGPA {latest.get(sid, 0.0):.2f}") for sid in sids}

    if board == "streak":
        # Active-day count (LoginDay is keyed by user_id).
        uids = list(uid_by_sid.values())
        rows = db.execute(
            select(LoginDay.user_id, func.count())
            .where(LoginDay.user_id.in_(uids))
            .group_by(LoginDay.user_id)
        ).all()
        by_uid = {uid: n for uid, n in rows}
        return {
            sid: (float(by_uid.get(uid_by_sid[sid], 0)), f"{by_uid.get(uid_by_sid[sid], 0)} active days")
            for sid in sids
        }

    return out


class LeaderRow(BaseModel):
    rank: int
    student_id: str
    name: str
    initials: str
    value: float
    value_label: str
    is_me: bool


class LeaderboardOut(BaseModel):
    board: str
    opted_out: bool
    rows: list[LeaderRow]


@router.get("/leaderboards", response_model=LeaderboardOut)
def leaderboards(
    board: str = "certificates",
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> LeaderboardOut:
    """Rank the caller's cohort on one board. A student who opted out is excluded
    from every board and — in both directions — sees no ranks themselves."""
    student_id = _require_student(session)
    if board not in _BOARDS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unknown board. One of: {', '.join(_BOARDS)}.",
        )
    me = db.get(Student, student_id)
    my_profile = db.scalar(
        select(StudentProfile).where(StudentProfile.student_id == student_id)
    )
    if my_profile is not None and my_profile.leaderboard_opt_out:
        return LeaderboardOut(board=board, opted_out=True, rows=[])

    # Cohort roster, minus anyone who opted out.
    opted_out = set(
        db.scalars(
            select(StudentProfile.student_id).where(StudentProfile.leaderboard_opt_out.is_(True))
        ).all()
    )
    roster_rows = db.execute(
        select(Student.id, Student.user_id, User.name)
        .join(User, Student.user_id == User.id)
        .where(Student.cohort_id == me.cohort_id)
    ).all()
    roster = [(sid, uid, name) for sid, uid, name in roster_rows if sid not in opted_out]

    values = _board_values(db, board, [(sid, uid) for sid, uid, _ in roster])
    name_by_sid = {sid: name for sid, _uid, name in roster}

    ranked = sorted(roster, key=lambda r: values[r[0]][0], reverse=True)
    rows = [
        LeaderRow(
            rank=i + 1,
            student_id=sid,
            name=name_by_sid[sid],
            initials=_initials(name_by_sid[sid]),
            value=values[sid][0],
            value_label=values[sid][1],
            is_me=(sid == student_id),
        )
        for i, (sid, _uid, _name) in enumerate(ranked)
    ]
    return LeaderboardOut(board=board, opted_out=False, rows=rows)


# --- Rule-based guidance (no LLM): next actions, readiness, recommendations ----
#
# Every value below is computed from the caller's own rows. These endpoints are
# STUDENT-only and never touch a model, so they carry no student-data egress.


def _attendance_pct(db: Session, student_id: str) -> float:
    """Overall attendance %, same computation the dashboard/attendance uses."""
    rows = db.execute(
        select(AttendanceRecord.present).where(AttendanceRecord.student_id == student_id)
    ).all()
    total = len(rows)
    present = sum(1 for (p,) in rows if p)
    return round(100 * present / total, 1) if total else 0.0


def _latest_cgpa(db: Session, student_id: str) -> float | None:
    latest = db.scalar(
        select(SemesterResult)
        .where(SemesterResult.student_id == student_id)
        .order_by(SemesterResult.semester.desc())
        .limit(1)
    )
    return latest.cgpa if latest else None


def _live_backlogs(db: Session, student_id: str) -> int:
    return int(
        db.scalar(
            select(func.coalesce(func.sum(SemesterResult.live_backlogs), 0)).where(
                SemesterResult.student_id == student_id
            )
        )
        or 0
    )


def _cert_completion_pct(db: Session, student_id: str) -> float:
    """Share of the student's certifications that are COMPLETED."""
    rows = db.execute(
        select(CertificationProgress.status).where(
            CertificationProgress.student_id == student_id
        )
    ).all()
    total = len(rows)
    if not total:
        return 0.0
    done = sum(1 for (s,) in rows if s == ProgressStatus.COMPLETED)
    return round(100 * done / total, 1)


def _resume_pct(db: Session, student_id: str) -> int:
    row = db.scalar(select(ResumeProfile).where(ResumeProfile.student_id == student_id))
    return _resume_completeness(row.data if row else {})


class NextActionOut(BaseModel):
    id: str
    title: str
    reason: str
    cta_label: str
    cta_route: str
    status: str
    deadline: datetime | None
    priority: int


class NextActionsOut(BaseModel):
    actions: list[NextActionOut]


@router.get("/next-actions", response_model=NextActionsOut)
def next_actions(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> NextActionsOut:
    """The student's 'what to do next' list — the top 5 candidate actions drawn
    from their real certification, course, profile, resume and skilling state,
    sorted by urgency (lower priority = more urgent). Rule-based; no model."""
    student_id = _require_student(session)
    actions: list[NextActionOut] = []

    # Certifications (join for the display name), split by status.
    cert_rows = db.execute(
        select(CertificationProgress, Certification)
        .join(Certification, CertificationProgress.cert_code == Certification.code)
        .where(CertificationProgress.student_id == student_id)
        .order_by(CertificationProgress.due_date)
    ).all()
    for prog, cert in cert_rows:
        if prog.status == ProgressStatus.OVERDUE:
            actions.append(
                NextActionOut(
                    id=f"cert-overdue-{cert.code}",
                    title=f"Finish {cert.name}",
                    reason="Overdue — behind the pace to complete in time",
                    cta_label="Continue",
                    cta_route="/student/certifications",
                    status="Overdue",
                    deadline=prog.due_date,
                    priority=1,
                )
            )
        elif prog.status == ProgressStatus.IN_PROGRESS:
            actions.append(
                NextActionOut(
                    id=f"cert-progress-{cert.code}",
                    title=f"Finish {cert.name}",
                    reason=f"In progress ({round(prog.progress_pct)}%)",
                    cta_label="Continue",
                    cta_route="/student/certifications",
                    status="In progress",
                    deadline=prog.due_date,
                    priority=3,
                )
            )

    # In-progress courses.
    course_rows = db.execute(
        select(Enrollment, Course)
        .join(Course, Enrollment.course_code == Course.code)
        .where(
            Enrollment.student_id == student_id,
            Enrollment.status == ProgressStatus.IN_PROGRESS,
        )
        .order_by(Course.semester, Course.code)
    ).all()
    for enr, course in course_rows:
        if enr.lectures_total:
            reason = f"{enr.lectures_attended}/{enr.lectures_total} lectures attended"
        else:
            reason = "In progress — keep logging your self-learning hours"
        actions.append(
            NextActionOut(
                id=f"course-{course.code}",
                title=f"Finish {course.name}",
                reason=reason,
                cta_label="Continue",
                cta_route="/student/courses",
                status="In progress",
                deadline=None,
                priority=3,
            )
        )

    # Missing placement-profile fields.
    prof = db.scalar(select(StudentProfile).where(StudentProfile.student_id == student_id))
    if not (prof and prof.phone):
        actions.append(
            NextActionOut(
                id="profile-phone",
                title="Add your phone number to your placement profile",
                reason="Recruiters need a way to reach you",
                cta_label="Add",
                cta_route="/student/profile",
                status="Missing",
                deadline=None,
                priority=2,
            )
        )
    if not (prof and prof.linkedin_url):
        actions.append(
            NextActionOut(
                id="profile-linkedin",
                title="Add your LinkedIn URL to your placement profile",
                reason="A LinkedIn profile strengthens your placement record",
                cta_label="Add",
                cta_route="/student/profile",
                status="Missing",
                deadline=None,
                priority=2,
            )
        )

    # Low resume completeness.
    resume_pct = _resume_pct(db, student_id)
    if resume_pct < 70:
        actions.append(
            NextActionOut(
                id="resume-completeness",
                title=f"Complete your resume profile ({resume_pct}%)",
                reason="A fuller resume profile means a stronger auto-generated CV",
                cta_label="Complete",
                cta_route="/student/resume",
                status="Incomplete",
                deadline=None,
                priority=4,
            )
        )

    # A pending skill claim under review, or a held-but-unverified skill.
    pending_claim = db.execute(
        select(SkillClaim, Skill.name)
        .join(Skill, SkillClaim.skill_id == Skill.id)
        .where(
            SkillClaim.student_id == student_id,
            SkillClaim.status == UploadStatus.PENDING_REVIEW,
        )
        .order_by(SkillClaim.created_at.desc())
        .limit(1)
    ).first()
    if pending_claim is not None:
        _claim, skill_name = pending_claim
        actions.append(
            NextActionOut(
                id="skill-claim-pending",
                title=f"Your {skill_name} skill claim is under review",
                reason="A mentor is reviewing your evidence",
                cta_label="View",
                cta_route="/student/skilling",
                status="Pending review",
                deadline=None,
                priority=4,
            )
        )
    else:
        unverified = db.execute(
            select(StudentSkill, Skill.name)
            .join(Skill, StudentSkill.skill_id == Skill.id)
            .where(
                StudentSkill.student_id == student_id,
                StudentSkill.verified.is_(False),
            )
            .order_by(StudentSkill.updated_at.desc())
            .limit(1)
        ).first()
        if unverified is not None:
            _ss, skill_name = unverified
            actions.append(
                NextActionOut(
                    id="skill-unverified",
                    title=f"Get your {skill_name} skill verified",
                    reason="Upload evidence so a mentor can verify it",
                    cta_label="Verify",
                    cta_route="/student/skilling",
                    status="Unverified",
                    deadline=None,
                    priority=4,
                )
            )

    actions.sort(key=lambda a: a.priority)
    return NextActionsOut(actions=actions[:5])


class ReadinessFactorOut(BaseModel):
    label: str
    met: bool
    detail: str
    weight: int


class PlacementReadinessOut(BaseModel):
    score: int
    band: str
    summary: str
    factors: list[ReadinessFactorOut]


def _readiness_band(score: int) -> str:
    if score < 40:
        return "Not ready"
    if score < 60:
        return "Developing"
    if score < 80:
        return "On track"
    return "Ready"


@router.get("/placement-readiness", response_model=PlacementReadinessOut)
def placement_readiness(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> PlacementReadinessOut:
    """A weighted placement-readiness score against the active PlacementCriteria
    (or sensible defaults when none is set). Rule-based; no model."""
    student_id = _require_student(session)

    crit = db.scalar(
        select(PlacementCriteria)
        .where(PlacementCriteria.active.is_(True))
        .order_by(PlacementCriteria.updated_at.desc())
        .limit(1)
    )
    # Defaults when the director has set no active criteria.
    min_cgpa = crit.min_cgpa if crit else 6.0
    max_backlogs = crit.max_live_backlogs if crit else 0
    min_att = crit.min_attendance_pct if crit else 75.0
    min_cert = crit.min_cert_completion_pct if crit else 50.0

    cgpa = _latest_cgpa(db, student_id)
    backlogs = _live_backlogs(db, student_id)
    att = _attendance_pct(db, student_id)
    cert_pct = _cert_completion_pct(db, student_id)
    prof = db.scalar(select(StudentProfile).where(StudentProfile.student_id == student_id))
    has_contacts = bool(prof and prof.phone and prof.linkedin_url)
    resume_pct = _resume_pct(db, student_id)

    factors = [
        ReadinessFactorOut(
            label="CGPA",
            met=(cgpa is not None and cgpa >= min_cgpa),
            detail=(
                f"CGPA {cgpa} meets the {min_cgpa} cut-off"
                if (cgpa is not None and cgpa >= min_cgpa)
                else (
                    f"CGPA {cgpa} is below the {min_cgpa} cut-off"
                    if cgpa is not None
                    else "CGPA not yet assessed"
                )
            ),
            weight=3,
        ),
        ReadinessFactorOut(
            label="Live backlogs",
            met=(backlogs <= max_backlogs),
            detail=f"{backlogs} live backlog(s); limit is {max_backlogs}",
            weight=3,
        ),
        ReadinessFactorOut(
            label="Attendance",
            met=(att >= min_att),
            detail=f"Attendance {att}% vs required {min_att}%",
            weight=2,
        ),
        ReadinessFactorOut(
            label="Certification completion",
            met=(cert_pct >= min_cert),
            detail=f"{cert_pct}% of certifications completed vs required {min_cert}%",
            weight=2,
        ),
        ReadinessFactorOut(
            label="Placement profile",
            met=has_contacts,
            detail=(
                "Phone and LinkedIn are on file"
                if has_contacts
                else "Add your phone number and LinkedIn URL"
            ),
            weight=1,
        ),
        ReadinessFactorOut(
            label="Resume profile",
            met=(resume_pct >= 70),
            detail=f"Resume profile {resume_pct}% complete (target 70%)",
            weight=1,
        ),
    ]

    total_weight = sum(f.weight for f in factors)
    met_weight = sum(f.weight for f in factors if f.met)
    score = round(100 * met_weight / total_weight) if total_weight else 0
    band = _readiness_band(score)
    met_count = sum(1 for f in factors if f.met)
    summary = f"{score}/100 — {band}. {met_count} of {len(factors)} placement checks met."

    return PlacementReadinessOut(score=score, band=band, summary=summary, factors=factors)


class RecommendationOut(BaseModel):
    title: str
    why: str
    cta_label: str
    cta_route: str


class RecommendationsOut(BaseModel):
    items: list[RecommendationOut]


@router.get("/recommendations", response_model=RecommendationsOut)
def recommendations(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> RecommendationsOut:
    """Up to three rule-based next-skill (or fallback) recommendations, drawn from
    the catalogue skills the student does not yet hold. Never empty when any
    sensible recommendation exists. No model."""
    student_id = _require_student(session)

    held_ids = set(
        db.scalars(
            select(StudentSkill.skill_id).where(StudentSkill.student_id == student_id)
        ).all()
    )
    catalogue = db.scalars(select(Skill).order_by(Skill.category, Skill.name)).all()
    missing = [s for s in catalogue if s.id not in held_ids]

    items: list[RecommendationOut] = []
    for s in missing[:3]:
        items.append(
            RecommendationOut(
                title=f"Learn {s.name}",
                why=f"Unlocks your {s.category} badge",
                cta_label="Start",
                cta_route="/student/skilling",
            )
        )

    # Holds every catalogue skill (or the catalogue is empty): fall back to
    # finishing an in-progress certification, then completing the resume profile.
    if not items:
        in_prog = db.execute(
            select(Certification.name)
            .join(
                CertificationProgress,
                CertificationProgress.cert_code == Certification.code,
            )
            .where(
                CertificationProgress.student_id == student_id,
                CertificationProgress.status.in_(
                    (ProgressStatus.IN_PROGRESS, ProgressStatus.OVERDUE)
                ),
            )
            .order_by(CertificationProgress.due_date)
            .limit(3)
        ).all()
        for (cert_name,) in in_prog:
            items.append(
                RecommendationOut(
                    title=f"Finish {cert_name}",
                    why="You have every catalogue skill — completing this certification is your next win",
                    cta_label="Continue",
                    cta_route="/student/certifications",
                )
            )
        if len(items) < 3 and _resume_pct(db, student_id) < 100:
            items.append(
                RecommendationOut(
                    title="Complete your resume profile",
                    why="A fuller resume profile means a stronger auto-generated CV",
                    cta_label="Complete",
                    cta_route="/student/resume",
                )
            )

    return RecommendationsOut(items=items[:3])
