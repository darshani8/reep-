"""Shared fixtures.

The pure-logic tests (egress gate, rule engine, resume PDF) need no database and
always run. The integration tests hit the seeded dev DB (`reep_py`) through a
TestClient; they are skipped with `@requires_db` when Postgres is not reachable,
so the suite still passes on a machine without Docker up.
"""

import pytest
from sqlalchemy import text

from app.db import SessionLocal


def _db_reachable() -> bool:
    try:
        with SessionLocal() as db:
            db.execute(text("select 1"))
        return True
    except Exception:
        return False


DB_UP = _db_reachable()

# Decorator for tests that require the seeded Postgres dev DB.
requires_db = pytest.mark.skipif(not DB_UP, reason="Postgres reep_py not reachable")


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def login(client):
    """Return a helper that logs in and yields the auth-cookie header dict."""

    def _login(email: str, password: str) -> dict:
        r = client.post("/api/auth/login", json={"email": email, "password": password})
        assert r.status_code == 200, r.text
        return {"Cookie": r.headers.get("set-cookie", "")}

    return _login
