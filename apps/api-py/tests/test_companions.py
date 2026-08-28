"""Phase 1 companion registry and memory boundary tests."""

from sqlalchemy import delete

from app.models.companion import Companion, CompanionMemory
from app.models.user import Role
from app.db import SessionLocal

from conftest import requires_db


@requires_db
def test_registry_is_admin_only(client, make_user):
    student = make_user("companion-registry-student", Role.STUDENT)
    admin = make_user("companion-registry-admin", Role.ADMIN)

    assert client.get("/api/companions", headers=student.headers).status_code == 403
    response = client.post(
        "/api/companions",
        headers=admin.headers,
        json={
            "slug": "interview-coach-test",
            "name": "Interview Coach",
            "role_key": "INTERVIEW_TRAINER",
            "capabilities": ["voice", "interview"],
            "allowed_roles": ["STUDENT"],
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["role_key"] == "INTERVIEW_TRAINER"
    assert response.json()["allowed_roles"] == ["STUDENT"]
    active = client.get("/api/companions/active", headers=student.headers)
    assert [row["slug"] for row in active.json()] == ["interview-coach-test"]

    with SessionLocal() as db:
        db.execute(delete(CompanionMemory).where(CompanionMemory.companion_id == response.json()["id"]))
        db.execute(delete(Companion).where(Companion.id == response.json()["id"]))
        db.commit()


@requires_db
def test_private_memory_is_owner_scoped(client, make_user):
    owner = make_user("private-memory-owner", Role.STUDENT)
    other = make_user("private-memory-other", Role.STUDENT)
    admin = make_user("private-memory-admin", Role.ADMIN)

    companion = client.post(
        "/api/companions",
        headers=admin.headers,
        json={"slug": "private-memory-test", "name": "Private Test", "role_key": "TEST"},
    )
    assert companion.status_code == 201, companion.text
    companion_id = companion.json()["id"]

    created = client.post(
        f"/api/companions/{companion_id}/memory",
        headers=owner.headers,
        json={"title": "Owner preference", "content": "Use concise interview feedback."},
    )
    assert created.status_code == 201, created.text

    owner_context = client.get(f"/api/companions/{companion_id}/context", headers=owner.headers)
    other_context = client.get(f"/api/companions/{companion_id}/context", headers=other.headers)
    assert owner_context.status_code == 200
    assert [m["title"] for m in owner_context.json()["memories"]] == ["Owner preference"]
    assert other_context.json()["memories"] == []

    with SessionLocal() as db:
        db.execute(delete(CompanionMemory).where(CompanionMemory.companion_id == companion_id))
        db.execute(delete(Companion).where(Companion.id == companion_id))
        db.commit()


@requires_db
def test_shared_memory_requires_admin_approval_before_context(client, make_user):
    admin = make_user("shared-memory-admin", Role.ADMIN)
    student = make_user("shared-memory-student", Role.STUDENT)
    companion = client.post(
        "/api/companions",
        headers=admin.headers,
        json={"slug": "shared-memory-test", "name": "Shared Test", "role_key": "TEST"},
    )
    assert companion.status_code == 201, companion.text
    companion_id = companion.json()["id"]

    draft = client.post(
        "/api/companions/shared-memory",
        headers=admin.headers,
        json={"title": "Programme rule", "content": "All companions use the approved REEP policy."},
    )
    assert draft.status_code == 201, draft.text
    assert draft.json()["status"] == "DRAFT"
    memory_id = draft.json()["id"]

    assert client.get(f"/api/companions/{companion_id}/context", headers=student.headers).json()["memories"] == []
    approved = client.post(
        f"/api/companions/{companion_id}/memory/{memory_id}/approve",
        headers=admin.headers,
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "APPROVED"
    context = client.get(f"/api/companions/{companion_id}/context", headers=student.headers)
    assert [m["title"] for m in context.json()["memories"]] == ["Programme rule"]

    with SessionLocal() as db:
        db.execute(delete(CompanionMemory).where(CompanionMemory.id == memory_id))
        db.execute(delete(Companion).where(Companion.id == companion_id))
        db.commit()
