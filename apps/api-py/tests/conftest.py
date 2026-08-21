"""Shared fixtures.

The pure-logic tests (egress gate, rule engine, resume PDF) need no database and
always run. The integration tests hit the seeded dev DB (`reep_py`) through a
TestClient; they are skipped with `@requires_db` when Postgres is not reachable,
so the suite still passes on a developer machine without Docker up.

That convenience is a LIE IN CI. Almost every test that covers conversations,
voice, retention and RBAC is @requires_db, so a pipeline without Postgres prints
a green "N passed" having verified essentially nothing about the product. Set
REEP_REQUIRE_DB=1 (CI does) and an unreachable database becomes a hard collection
error instead of a silent skip.
"""

import os
import types
import uuid

import pytest
from sqlalchemy import delete, text

from app.db import SessionLocal
from app.models.conversation import Conversation
from app.models.user import LoginDay, Role, Student, User
from app.security import hash_password


def _db_reachable() -> bool:
    try:
        with SessionLocal() as db:
            db.execute(text("select 1"))
        return True
    except Exception:
        return False


DB_UP = _db_reachable()
REQUIRE_DB = os.getenv("REEP_REQUIRE_DB", "").strip().lower() in {"1", "true", "yes"}

if REQUIRE_DB and not DB_UP:
    raise pytest.UsageError(
        "REEP_REQUIRE_DB is set but Postgres is not reachable. The DB-backed "
        "tests (conversations, voice, retention, RBAC) would have been SKIPPED "
        "and the suite would have reported success without exercising them. "
        "Start Postgres (docker compose up -d) or unset REEP_REQUIRE_DB."
    )

# Decorator for tests that require the seeded Postgres dev DB.
requires_db = pytest.mark.skipif(not DB_UP, reason="Postgres reep_py not reachable")


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _fresh_per_process_state():
    """Reset the per-process LLM rate limiter and leaderboard cache per test.

    Both are process-lifetime state by design (see app/ratelimit.py and the
    leaderboard cache in app/routers/student.py), and the suite drives one
    seeded student through dozens of /api/agent/chat calls in a single process
    — a limiter that remembered them across tests would fail the suite for
    being thorough, which is how guards get deleted. Reset BEFORE each test so
    every test starts from the documented cold state; nothing is reset after,
    so a test may still assert on the warm state it built itself.
    """
    from app import ratelimit
    from app.routers import student as student_router

    ratelimit.reset()
    with student_router._leaderboard_cache_lock:
        student_router._leaderboard_cache.clear()
    yield


@pytest.fixture
def login(client):
    """Return a helper that logs in and yields the auth-cookie header dict."""

    def _login(email: str, password: str) -> dict:
        r = client.post("/api/auth/login", json={"email": email, "password": password})
        assert r.status_code == 200, r.text
        return {"Cookie": r.headers.get("set-cookie", "")}

    return _login


@pytest.fixture
def make_user(client):
    """Factory that creates a throwaway User (STUDENT gets a Student row too),
    logs it in, and returns email/user_id/headers. All rows are torn down."""
    created: list[str] = []

    def _make(label: str, role: Role = Role.STUDENT):
        email = f"voicetest-{label}-{uuid.uuid4().hex[:8]}@bgscet.ac.in"
        password = "voicepass123"
        with SessionLocal() as db:
            user = User(
                email=email,
                name=f"Voice Test {label}",
                role=role,
                password_hash=hash_password(password),
            )
            db.add(user)
            db.flush()
            if role == Role.STUDENT:
                db.add(Student(user_id=user.id))
            db.commit()
            uid = user.id
        created.append(uid)

        r = client.post("/api/auth/login", json={"email": email, "password": password})
        assert r.status_code == 200, r.text
        headers = {"Cookie": r.headers.get("set-cookie", "")}
        client.cookies.clear()
        return types.SimpleNamespace(email=email, user_id=uid, headers=headers)

    yield _make

    with SessionLocal() as db:
        for uid in created:
            db.execute(delete(Conversation).where(Conversation.owner_user_id == uid))
            db.execute(delete(LoginDay).where(LoginDay.user_id == uid))
            db.execute(delete(Student).where(Student.user_id == uid))
            db.execute(delete(User).where(User.id == uid))
        db.commit()
