"""Dev seed: insert a demo director. Run AFTER migrations:

    python -m alembic upgrade head
    python -m app.seed

Data only — Alembic owns the schema now. Requires the DB reachable and the
reep_py database created (see .env.example).
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from .db import SessionLocal
from .models.academics import SemesterResult, SubjectMark
from .models.attendance import AttendanceRecord
from .models.profile import StudentProfile
from .models.user import Role, Stage, Student, User
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
    finally:
        db.close()


if __name__ == "__main__":
    main()
