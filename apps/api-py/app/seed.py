"""Dev seed: insert a demo director. Run AFTER migrations:

    python -m alembic upgrade head
    python -m app.seed

Data only — Alembic owns the schema now. Requires the DB reachable and the
reep_py database created (see .env.example).
"""

from sqlalchemy import select

from .db import SessionLocal
from .models.user import Role, User
from .security import hash_password


def main() -> None:
    db = SessionLocal()
    try:
        email = "director@bgscet.ac.in"
        if db.scalar(select(User).where(User.email == email)) is None:
            db.add(
                User(
                    email=email,
                    name="Director (seed)",
                    role=Role.DIRECTOR,
                    password_hash=hash_password("director123"),
                )
            )
            db.commit()
            print(f"created {email} / director123")
        else:
            print(f"{email} already exists")
    finally:
        db.close()


if __name__ == "__main__":
    main()
