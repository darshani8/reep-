"""Dev seed: insert a demo director. Run AFTER migrations:

    python -m alembic upgrade head
    python -m app.seed

Data only — Alembic owns the schema now. Requires the DB reachable and the
reep_py database created (see .env.example).
"""

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select

from .db import SessionLocal
from .models.academic_history import AcademicGap, AcademicQualification, QualificationLevel
from .models.academics import SemesterResult, SubjectMark
from .models.alert import Alert, AlertRuleConfig, AlertRuleKey, AlertSeverity
from .models.attendance import AttendanceRecord
from .models.certification import Certification, CertificationProgress
from .models.cohort import Cohort
from .models.course import Course, CourseModel, Dimension, Enrollment, ProgressStatus
from .models.job import DegreeLevel, Job
from .models.job_import_run import JobImportRun
from .models.lab import ActivityType, CheckInSource, LabSession, LearningMode
from .models.mail import MailLog
from .models.registration import Registration, RegistrationRule, RegistrationStatus
from .models.upload import Upload, UploadKind, UploadStatus
from .mailer import deliver_once
from .models.mentor_note import MentorAction, MentorNote
from .models.mock import MockAttempt, MockType
from .models.placement_criteria import PlacementCriteria
from .models.profile import StudentProfile
from .models.schedule import ScheduleItem, ScheduleType
from .models.skill import Skill, SkillClaim, StudentSkill
from .models.swoc import SwocEntry, SwocKind, SwocSource
from .models.timesheet import DayActivity, TimeSheetEntry
from .models.user import LoginDay, Mentor, Role, Stage, Student, User
from .security import hash_password


def main() -> None:
    db = SessionLocal()
    try:
        director = "director@bgscet.ac.in"
        if db.scalar(select(User).where(User.email == director)) is None:
            db.add(
                User(
                    email=director,
                    name="Director (seed)",
                    role=Role.DIRECTOR,
                    password_hash=hash_password("director123"),
                )
            )
            db.commit()
            print(f"created {director} / director123")
        else:
            print(f"{director} already exists")

        student_email = "student@bgscet.ac.in"
        if db.scalar(select(User).where(User.email == student_email)) is None:
            user = User(
                email=student_email,
                name="Test Student",
                role=Role.STUDENT,
                password_hash=hash_password("student123"),
            )
            db.add(user)
            db.flush()
            stu = Student(user_id=user.id)
            db.add(stu)
            db.flush()
            db.add(
                StudentProfile(
                    student_id=stu.id,
                    city="Bengaluru",
                    career_summary="MBA finance candidate seeking placement.",
                )
            )
            db.commit()
            print(f"created {student_email} / student123 (+ profile)")
        else:
            print(f"{student_email} already exists")

        mentor_email = "mentor@bgscet.ac.in"
        if db.scalar(select(User).where(User.email == mentor_email)) is None:
            mentor_user = User(
                email=mentor_email,
                name="Test Mentor",
                role=Role.MENTOR,
                password_hash=hash_password("mentor123"),
            )
            db.add(mentor_user)
            db.flush()
            db.add(Mentor(user_id=mentor_user.id))
            db.commit()
            print(f"created {mentor_email} / mentor123")

        # Idempotently give the test student one semester result with subjects.
        stu_user = db.scalar(select(User).where(User.email == student_email))
        stu = (
            db.scalar(select(Student).where(Student.user_id == stu_user.id)) if stu_user else None
        )
        if stu and stu.usn is None:
            stu.usn = "1BG24MBA001"
            stu.current_stage = Stage.EXCEL_ADVANCED
            stu.current_semester = 2
            db.commit()
            print("backfilled student USN + stage")
        mentor = db.scalar(
            select(Mentor).join(User, Mentor.user_id == User.id).where(User.email == "mentor@bgscet.ac.in")
        )
        if stu and mentor and stu.mentor_id != mentor.id:
            stu.mentor_id = mentor.id
            db.commit()
            print("assigned student to mentor group")
        if stu and mentor and db.scalar(
            select(MentorNote).where(MentorNote.student_id == stu.id)
        ) is None:
            db.add(
                MentorNote(
                    mentor_id=mentor.id,
                    student_id=stu.id,
                    note_text="Discussed placement readiness; strong on analytics, work on GD delivery.",
                    linked_action=MentorAction.ONE_ON_ONE_SCHEDULED,
                )
            )
            db.commit()
            print("added a mentor note")
        if stu and db.scalar(select(Alert).where(Alert.student_id == stu.id)) is None:
            db.add(
                Alert(
                    student_id=stu.id,
                    rule_triggered=AlertRuleKey.ATTENDANCE_BELOW_THRESHOLD,
                    severity=AlertSeverity.WARNING,
                    message="Attendance in Managerial Economics dropped below 80%.",
                    context={"course": "22MBA12", "percent": 80},
                )
            )
            db.commit()
            print("added an alert")
        if stu and db.scalar(select(SemesterResult).where(SemesterResult.student_id == stu.id)) is None:
            result = SemesterResult(
                student_id=stu.id,
                semester=1,
                sgpa=8.2,
                cgpa=8.2,
                closed_backlogs=0,
                live_backlogs=0,
                result_class="FIRST CLASS WITH DISTINCTION",
            )
            result.subjects = [
                SubjectMark(
                    subject_code="22MBA11",
                    subject_name="Management & Organisational Behaviour",
                    credits=4,
                    internal=42,
                    external=40,
                    total=82,
                    passed=True,
                ),
                SubjectMark(
                    subject_code="22MBA12",
                    subject_name="Managerial Economics",
                    credits=4,
                    internal=38,
                    external=36,
                    total=74,
                    passed=True,
                ),
            ]
            db.add(result)
            db.commit()
            print("added a semester result (2 subjects) for the test student")

        # Idempotently add attendance: 2 courses x 20 sessions (~85% overall).
        if stu and db.scalar(
            select(AttendanceRecord).where(AttendanceRecord.student_id == stu.id)
        ) is None:
            base = datetime(2026, 1, 6, tzinfo=timezone.utc)
            records = []
            for code, present_count in (("22MBA11", 18), ("22MBA12", 16)):  # of 20
                for n in range(1, 21):
                    records.append(
                        AttendanceRecord(
                            student_id=stu.id,
                            course_code=code,
                            session_date=base + timedelta(days=n),
                            session_no=n,
                            present=(n <= present_count),
                        )
                    )
            db.add_all(records)
            db.commit()
            print("added attendance (40 sessions across 2 courses)")

        # Idempotently add a few SWOC entries across the viewpoints.
        if stu and db.scalar(select(SwocEntry).where(SwocEntry.student_id == stu.id)) is None:
            db.add_all(
                [
                    SwocEntry(student_id=stu.id, source=SwocSource.MENTOR, kind=SwocKind.STRENGTH, text="Strong analytical and quantitative skills.", weight=5),
                    SwocEntry(student_id=stu.id, source=SwocSource.PLACEMENT, kind=SwocKind.WEAKNESS, text="Needs structured problem-solving practice.", weight=4),
                    SwocEntry(student_id=stu.id, source=SwocSource.PM, kind=SwocKind.OPPORTUNITY, text="Fintech internships opening this quarter.", weight=3),
                    SwocEntry(student_id=stu.id, source=SwocSource.MENTOR, kind=SwocKind.CHALLENGE, text="Public speaking under time pressure.", weight=3),
                ]
            )
            db.commit()
            print("added SWOC entries (4 across quadrants)")

        # Idempotently add a couple of mock-assessment attempts.
        if stu and db.scalar(select(MockAttempt).where(MockAttempt.student_id == stu.id)) is None:
            base = datetime(2026, 2, 1, tzinfo=timezone.utc)
            db.add_all(
                [
                    MockAttempt(student_id=stu.id, type=MockType.APTITUDE, taken_on=base, score=72, max_score=100, notes="Solid quant; revise data interpretation."),
                    MockAttempt(student_id=stu.id, type=MockType.GD, taken_on=base + timedelta(days=7), score=7, max_score=10, notes="Good points; interrupt less."),
                ]
            )
            db.commit()
            print("added mock attempts (2)")

        # Idempotently seed a small skill catalogue + the student's skills.
        if db.scalar(select(Skill)) is None:
            db.add_all(
                [
                    Skill(slug="excel", name="MS Excel", category="Analytics", aliases=["advanced excel"]),
                    Skill(slug="power-bi", name="Power BI", category="Analytics", aliases=[]),
                    Skill(slug="financial-modeling", name="Financial Modeling", category="Business", aliases=[]),
                ]
            )
            db.commit()
            print("added skill catalogue (3)")
        if stu and db.scalar(select(StudentSkill).where(StudentSkill.student_id == stu.id)) is None:
            catalogue = {s.slug: s for s in db.scalars(select(Skill)).all()}
            db.add_all(
                [
                    StudentSkill(student_id=stu.id, skill_id=catalogue["excel"].id, level=4, verified=True),
                    StudentSkill(student_id=stu.id, skill_id=catalogue["power-bi"].id, level=3, verified=False),
                    StudentSkill(student_id=stu.id, skill_id=catalogue["financial-modeling"].id, level=3, verified=False),
                ]
            )
            db.commit()
            print("added student skills (3)")

        # Idempotently seed a 5-day login streak ending today.
        if stu_user:
            existing_days = set(
                db.scalars(select(LoginDay.day).where(LoginDay.user_id == stu_user.id)).all()
            )
            today = date.today()
            added = 0
            for delta in range(5):  # today .. today-4
                day = today - timedelta(days=delta)
                if day not in existing_days:
                    db.add(LoginDay(user_id=stu_user.id, day=day))
                    added += 1
            if added:
                db.commit()
                print(f"seeded {added} login-day(s) for a streak")

        # Idempotently add 3 days of time-sheet entries (5 activities each).
        if stu and db.scalar(
            select(TimeSheetEntry).where(TimeSheetEntry.student_id == stu.id)
        ) is None:
            today = date.today()
            plan = [
                (DayActivity.SLEEPING, 420),
                (DayActivity.LECTURES, 240),
                (DayActivity.COURSEWORK, 90),
                (DayActivity.SKILLING, 120),
                (DayActivity.LEISURE, 120),
            ]
            entries = [
                TimeSheetEntry(
                    student_id=stu.id,
                    day=today - timedelta(days=delta),
                    activity=act,
                    minutes=mins,
                )
                for delta in range(3)
                for act, mins in plan
            ]
            db.add_all(entries)
            db.commit()
            print(f"added timesheet entries ({len(entries)})")

        # Idempotently add prior qualifications + a gap row.
        if stu and db.scalar(
            select(AcademicQualification).where(AcademicQualification.student_id == stu.id)
        ) is None:
            db.add_all(
                [
                    AcademicQualification(student_id=stu.id, level=QualificationLevel.TENTH, institution="St. Joseph's High School", board="CBSE", year=2018, marks=88, max_marks=100, medium="English"),
                    AcademicQualification(student_id=stu.id, level=QualificationLevel.TWELFTH, institution="Sri Chaitanya PU College", board="Karnataka PUC", year=2020, marks=82, max_marks=100, medium="English"),
                    AcademicQualification(student_id=stu.id, level=QualificationLevel.UNDERGRAD, institution="Bangalore University", year=2024, marks=72, max_marks=100),
                ]
            )
            db.commit()
            print("added academic qualifications (3)")
        if stu and db.scalar(select(AcademicGap).where(AcademicGap.student_id == stu.id)) is None:
            db.add(AcademicGap(student_id=stu.id, twelfth_to_grad_mo=0, grad_to_pg_mo=0))
            db.commit()
            print("added academic gap row")

        # Idempotently seed a few jobs with varied eligibility gates.
        if db.scalar(select(Job)) is None:
            base = datetime(2026, 8, 1, tzinfo=timezone.utc)
            db.add_all(
                [
                    Job(title="Financial Analyst", company="Acme Capital", degree_level=DegreeLevel.PG, location="Bengaluru", required_skills=["excel", "financial-modeling"], posted_on=base, min_cgpa=7.0, max_live_backlogs=0, description="Financial analysis and modeling.", apply_url="https://example.com/apply/1"),
                    Job(title="BI Developer", company="DataWorks", degree_level=DegreeLevel.PG, location="Remote", required_skills=["power-bi", "excel"], posted_on=base, min_cgpa=8.5, description="Build dashboards.", apply_url="https://example.com/apply/2"),
                    Job(title="Junior Accountant", company="LedgerCo", degree_level=DegreeLevel.UG, location="Mysuru", required_skills=["excel"], posted_on=base, description="Entry-level accounting."),
                ]
            )
            db.commit()
            print("added jobs (3)")

        # Idempotently add a few upcoming schedule items for the student.
        if stu and db.scalar(select(ScheduleItem).where(ScheduleItem.student_id == stu.id)) is None:
            now = datetime.now(timezone.utc)
            db.add_all(
                [
                    ScheduleItem(student_id=stu.id, type=ScheduleType.MENTOR_MEETING, title="1:1 with mentor", starts_at=now + timedelta(days=1), location="Cabin 3"),
                    ScheduleItem(student_id=stu.id, type=ScheduleType.LECTURE, title="Managerial Economics", starts_at=now + timedelta(days=2), course_code="22MBA12", location="Room 201"),
                    ScheduleItem(student_id=stu.id, type=ScheduleType.CERT_DEADLINE, title="Power BI certification due", starts_at=now + timedelta(days=5)),
                ]
            )
            db.commit()
            print("added schedule items (3)")

        # Idempotently seed two courses + the student's enrollments.
        if db.scalar(select(Course)) is None:
            db.add_all(
                [
                    Course(code="22MBA11", name="Management & Organisational Behaviour", stage=Stage.EXCEL, dimension=Dimension.PROFESSIONAL, semester=1, model_type=CourseModel.INSTRUCTOR_LED, teaching_hours=40, self_learning_hours_required=20),
                    Course(code="22MBA12", name="Managerial Economics", stage=Stage.EXCEL, dimension=Dimension.THINKING, semester=1, model_type=CourseModel.TEACHING_PLUS_SELF_LEARN, teaching_hours=40, self_learning_hours_required=20),
                ]
            )
            db.commit()
            print("added courses (2)")
        if stu and db.scalar(select(Enrollment).where(Enrollment.student_id == stu.id)) is None:
            db.add_all(
                [
                    Enrollment(student_id=stu.id, course_code="22MBA11", status=ProgressStatus.IN_PROGRESS, teaching_hours_attended=32, lectures_attended=18, lectures_total=20),
                    Enrollment(student_id=stu.id, course_code="22MBA12", status=ProgressStatus.IN_PROGRESS, teaching_hours_attended=28, lectures_attended=16, lectures_total=20),
                ]
            )
            db.commit()
            print("added enrollments (2)")

        # Idempotently seed a certification (on 22MBA11) + the student's progress.
        if db.scalar(select(Certification)) is None:
            db.add(
                Certification(
                    code="CERT-22MBA11-LEAD",
                    course_code="22MBA11",
                    name="Leadership Foundations",
                    provider="Coursera",
                    required_hours=15,
                    link="https://coursera.org/learn/leadership-foundations",
                    due_week=12,
                )
            )
            db.commit()
            print("added certification (1)")
        if stu and db.scalar(
            select(CertificationProgress).where(CertificationProgress.student_id == stu.id)
        ) is None:
            db.add(
                CertificationProgress(
                    student_id=stu.id,
                    cert_code="CERT-22MBA11-LEAD",
                    status=ProgressStatus.IN_PROGRESS,
                    progress_pct=60,
                    hours_logged=9,
                    due_date=datetime(2026, 10, 1, tzinfo=timezone.utc),
                )
            )
            db.commit()
            print("added certification progress (1)")

        # Idempotently add two completed focus/lab sessions.
        if stu and db.scalar(select(LabSession).where(LabSession.student_id == stu.id)) is None:
            base = datetime.now(timezone.utc)
            db.add_all(
                [
                    LabSession(student_id=stu.id, course_code="22MBA12", module="Demand analysis", activity=ActivityType.ONLINE_COURSE, mode=LearningMode.SUPERVISED_LAB, source=CheckInSource.LAB_PC, check_in_at=base - timedelta(days=1, hours=2), check_out_at=base - timedelta(days=1), duration_min=120, mentor_confirmed=True),
                    LabSession(student_id=stu.id, course_code="22MBA11", module="OB case study", activity=ActivityType.GROUP_STUDY, mode=LearningMode.INDEPENDENT, source=CheckInSource.SELF_REPORTED, check_in_at=base - timedelta(hours=3), check_out_at=base - timedelta(hours=1, minutes=30), duration_min=90),
                ]
            )
            db.commit()
            print("added lab sessions (2)")

        # Idempotently create a cohort and assign the student to it.
        if db.scalar(select(Cohort)) is None:
            db.add(
                Cohort(
                    code="MBA-2026-B",
                    name="MBA Batch 2024-26 - Section B",
                    batch_label="2024-26",
                    degree_level=DegreeLevel.PG,
                    start_date=datetime(2024, 8, 1, tzinfo=timezone.utc),
                    end_date=datetime(2026, 7, 31, tzinfo=timezone.utc),
                )
            )
            db.commit()
            print("added cohort (1)")
        cohort = db.scalar(select(Cohort).where(Cohort.code == "MBA-2026-B"))
        if stu and cohort and stu.cohort_id != cohort.id:
            stu.cohort_id = cohort.id
            db.commit()
            print("assigned student to cohort")

        # Idempotently create the default active placement criteria.
        if db.scalar(select(PlacementCriteria)) is None:
            db.add(PlacementCriteria(name="Default", active=True))
            db.commit()
            print("added placement criteria (default)")

        # Idempotently seed sample uploads awaiting mentor review: a profile
        # photo, a certificate proof (tied to the seeded certification), and a
        # resume — one already VERIFIED so the review states are visible.
        if stu and db.scalar(select(Upload).where(Upload.student_id == stu.id)) is None:
            base = datetime.now(timezone.utc)
            db.add_all(
                [
                    Upload(student_id=stu.id, kind=UploadKind.PROFILE_PHOTO, title="Profile photo", original_name="me.jpg", stored_name="up_photo_0001.jpg", mime_type="image/jpeg", size_bytes=184_320, status=UploadStatus.PENDING_REVIEW, uploaded_at=base - timedelta(days=2)),
                    Upload(student_id=stu.id, kind=UploadKind.CERTIFICATE_PROOF, cert_code="CERT-22MBA11-LEAD", title="Leadership certificate", original_name="leadership_completion.pdf", stored_name="up_cert_0002.pdf", mime_type="application/pdf", size_bytes=524_288, status=UploadStatus.PENDING_REVIEW, uploaded_at=base - timedelta(days=1)),
                    Upload(student_id=stu.id, kind=UploadKind.RESUME, title="Existing CV", original_name="resume_v1.pdf", stored_name="up_resume_0003.pdf", mime_type="application/pdf", size_bytes=98_304, status=UploadStatus.VERIFIED, reviewed_at=base - timedelta(hours=6), review_note="Looks good.", uploaded_at=base - timedelta(days=3)),
                ]
            )
            db.commit()
            print("added uploads (3: 2 pending, 1 verified)")

        # Idempotently seed one pending skill claim: the student claims a level
        # on a catalogue skill, backed by their certificate-proof upload.
        if stu and db.scalar(select(SkillClaim).where(SkillClaim.student_id == stu.id)) is None:
            skill = db.scalar(select(Skill).order_by(Skill.slug))
            evidence = db.scalar(
                select(Upload).where(Upload.student_id == stu.id, Upload.kind == UploadKind.CERTIFICATE_PROOF)
            )
            if skill and evidence:
                db.add(
                    SkillClaim(student_id=stu.id, skill_id=skill.id, upload_id=evidence.id, claimed_level=4)
                )
                db.commit()
                print("added skill claim (1, pending)")

        # Idempotently seed two registration rules: a narrow MBA-USN auto-approve
        # rule (priority 10) that assigns the seeded cohort, and a broad
        # college-domain route-to-review rule (priority 100).
        if db.scalar(select(RegistrationRule)) is None:
            cohort = db.scalar(select(Cohort).where(Cohort.code == "MBA-2026-B"))
            db.add_all(
                [
                    RegistrationRule(name="MBA 2024-26 auto-admit", enabled=True, email_domain="bgscet.ac.in", usn_pattern=r"^1BG2[0-9]MBA[0-9]{3}$", degree_level=DegreeLevel.PG, cohort_id=cohort.id if cohort else None, auto_approve=True, priority=10),
                    RegistrationRule(name="College domain — route to review", enabled=True, email_domain="bgscet.ac.in", auto_approve=False, priority=100),
                ]
            )
            db.commit()
            print("added registration rules (2)")

        # Idempotently seed two sample applications: one that the narrow rule
        # auto-approves, one that only the broad rule routes to manual review.
        if db.scalar(select(Registration)) is None:
            rules = {r.name: r for r in db.scalars(select(RegistrationRule)).all()}
            auto = rules.get("MBA 2024-26 auto-admit")
            broad = rules.get("College domain — route to review")
            db.add_all(
                [
                    Registration(name="Asha Rao", email="1bg24mba045@bgscet.ac.in", usn="1BG24MBA045", degree_level=DegreeLevel.PG, status=RegistrationStatus.AUTO_APPROVED, cohort_id=auto.cohort_id if auto else None, matched_rule_id=auto.id if auto else None, decision_reason="Auto-approved by rule 'MBA 2024-26 auto-admit'."),
                    Registration(name="Ravi Kumar", email="ravi.kumar@bgscet.ac.in", degree_level=DegreeLevel.PG, status=RegistrationStatus.PENDING_REVIEW, matched_rule_id=broad.id if broad else None, decision_reason="Routed by rule 'College domain — route to review' — awaiting review."),
                ]
            )
            db.commit()
            print("added registrations (2: 1 auto-approved, 1 pending review)")

        # Idempotently seed a completed job-import run and back-link the seeded
        # jobs to it — the audit row that says "these three came from that sheet".
        if db.scalar(select(JobImportRun)) is None:
            base = datetime(2026, 8, 1, tzinfo=timezone.utc)
            director = db.scalar(select(User).where(User.email == "director@bgscet.ac.in"))
            jobs = db.scalars(select(Job)).all()
            run = JobImportRun(
                file_name="vacancies_2026_aug.csv",
                uploaded_by_id=director.id if director else None,
                started_at=base,
                finished_at=base + timedelta(minutes=1),
                rows_seen=4,
                rows_created=len(jobs),
                rows_updated=0,
                errors=[{"row": 4, "column": "min_cgpa", "message": "not a number: 'N/A'"}],
            )
            db.add(run)
            db.flush()  # get run.id
            for j in jobs:
                if j.import_run_id is None:
                    j.import_run_id = run.id
            db.commit()
            print(f"added job import run (1, linked {len(jobs)} jobs)")

        # Idempotently seed the per-cohort alert thresholds (config in data,
        # never hard-coded). One row per (cohort, rule_key).
        cohort = db.scalar(select(Cohort).where(Cohort.code == "MBA-2026-B"))
        if cohort and db.scalar(select(AlertRuleConfig).where(AlertRuleConfig.cohort_id == cohort.id)) is None:
            db.add_all(
                [
                    AlertRuleConfig(cohort_id=cohort.id, rule_key=AlertRuleKey.NO_CHECKIN_N_DAYS, params={"days": 5}, severity=AlertSeverity.WARNING),
                    AlertRuleConfig(cohort_id=cohort.id, rule_key=AlertRuleKey.ATTENDANCE_BELOW_THRESHOLD, params={"minAttendancePct": 75}, severity=AlertSeverity.CRITICAL),
                    AlertRuleConfig(cohort_id=cohort.id, rule_key=AlertRuleKey.CERT_OVERDUE, params={"graceDays": 3}, severity=AlertSeverity.WARNING),
                ]
            )
            db.commit()
            print("added alert rule configs (3)")

        # Idempotently seed a few mail-log rows via the dedupe-safe mailer, so
        # the ops audit view has sample data. Re-running is a no-op: the unique
        # dedupe_key collapses the second attempt.
        if db.scalar(select(MailLog)) is None:
            deliver_once(db, kind="job-alert", recipient=student_email, dedupe_key=f"job-alert:{student_email}:2026-W33", subject="3 new jobs match your profile")
            deliver_once(db, kind="weekly-digest", recipient=student_email, dedupe_key=f"weekly-digest:{student_email}:2026-W33", subject="Your week in REEP")
            print("added mail logs (2)")
    finally:
        db.close()


if __name__ == "__main__":
    main()
