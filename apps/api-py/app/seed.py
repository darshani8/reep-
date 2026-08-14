"""Dev bootstrap: create the current tables and a demo director.

    python -m app.seed

Uses Base.metadata.create_all so the app is runnable before Alembic is wired
(Phase 2 replaces this with real migrations). Requires the DB to be reachable
(docker compose up + the reep_py database created — see .env.example).
"""

from sqlalchemy import select

from .db import Base, SessionLocal, engine
from .models.user import Role, User
from .security import hash_password


def main() -> None:
    Base.metadata.create_all(engine)
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
