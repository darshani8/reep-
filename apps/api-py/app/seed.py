"""Dev seed: insert a demo director. Run AFTER migrations:

    python -m alembic upgrade head
    python -m app.seed

Data only — Alembic owns the schema now. Requires the DB reachable and the
reep_py database created (see .env.example).
"""

from sqlalchemy import select

from .db import SessionLocal
from .models.profile import StudentProfile
from .models.user import Role, Student, User
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
    finally:
        db.close()


if __name__ == "__main__":
    main()
