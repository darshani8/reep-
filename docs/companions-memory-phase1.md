# Phase 1: Companions and scoped memory

This feature is isolated on `feat/companions-memory` and extends the existing
FastAPI + PostgreSQL/pgvector + Angular stack.

## Model

- `companions` is the admin-managed registry.
- `role_key` identifies the companion’s job (for example `INTERVIEW_TRAINER`).
- `allowed_roles` is the REEP user-role audience (`STUDENT`, `MENTOR`,
  `DIRECTOR`, `ADMIN`, or `ALUMNI`). The API filters active companions and
  rejects context access when the caller’s role is not assigned.
- `companion_memories` stores both private and centralized memory. A `NULL`
  `companion_id` is centralized memory available to every companion after
  approval.
- Private memory is owned by the authenticated user and is never returned to a
  different user. It is not automatically promoted to shared memory.
- Shared memory is created as `DRAFT` and only `ADMIN` can approve it. Only
  approved shared entries enter runtime context.
- `embedding` is a nullable dimensionless pgvector column, matching the existing
  knowledge-base convention and allowing the configured embedding model to
  change without a schema migration. PostgreSQL full-text indexing is also
  included for the next retrieval slice.

## API

All paths are under `/api/companions` and require the existing `reep_session`.

- `GET /active` — active companions assigned to the caller’s role.
- `GET /` — full registry; `ADMIN` only.
- `POST /` — create a companion; `ADMIN` only.
- `PATCH /{companion_id}` — update role assignment, prompt, capabilities, or
  active status; `ADMIN` only.
- `GET /{companion_id}/memory` — caller-visible memory; admin sees shared and
  their own private entries for governance.
- `POST /{companion_id}/memory` — create private memory for the caller.
- `POST /shared-memory` — create centralized draft; `ADMIN` only.
- `POST /{companion_id}/memory/{memory_id}/approve` — approve centralized
  memory; `ADMIN` only.
- `GET /{companion_id}/context` — the exact approved shared plus caller-owned
  private context allowed for the companion.

The Angular admin screen is `/admin/companions`, protected by the existing
`ADMIN` route guard and linked in the admin shell navigation.

## Migration and tests

Apply with the repository’s normal command from `apps/api-py`:

```text
.venv/Scripts/python -m alembic upgrade head
```

The migration is `c7f4a1b2d903_companions_and_memory.py`. API tests cover admin
registry access, private-memory isolation, and shared-memory approval/context
visibility in `tests/test_companions.py`.
