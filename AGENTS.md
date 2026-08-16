# REEP — the stack

REEP is a college placement-readiness dashboard. It is an **Angular front end** talking to a **Python/FastAPI back end** over HTTP, on **PostgreSQL**. (It used to be a Next.js/React app with a NestJS API and Prisma — that stack has been fully migrated away and deleted. Ignore any lingering references to Next.js, React, Prisma, `server-only`, or `apps/api`; they are gone.)

```
apps/web      Angular 20 SPA (standalone components, signals, ReactiveForms)
apps/api-py   FastAPI + SQLAlchemy 2.0 + Alembic + Pydantic v2 (psycopg 3, PyJWT)
docker-compose.yml   Postgres 17 (container reep-postgres, host port 5433)
ollama/       optional local model (loopback LLM — see the egress gate below)
```

## Running it

1. **Database** — `docker compose up -d` starts Postgres on `localhost:5433`. The API uses a database named `reep_py` on that server.
2. **Back end** — from `apps/api-py` (venv at `.venv`, Python 3.14):
   ```
   .venv/Scripts/python -m alembic upgrade head      # apply migrations
   .venv/Scripts/python -m app.seed                  # idempotent dev seed
   .venv/Scripts/python -m uvicorn app.main:app --port 3300
   ```
   Docs at http://127.0.0.1:3300/docs. **Windows note:** `uvicorn --reload` has wedged a stale worker here — after editing backend files, kill port 3300 and restart rather than relying on `--reload`.
3. **Front end** — from `apps/web`: `npx ng serve` (port 4200). `proxy.conf.json` forwards `/api` → `http://localhost:3300`, so the app is same-origin and the httpOnly session cookie is carried. The whole API surface the client calls lives under `/api`.

Seeded logins: `student@bgscet.ac.in` / `student123`, `mentor@bgscet.ac.in` / `mentor123`, `director@bgscet.ac.in` / `director123`.

**Tests:** `cd apps/api-py && .venv/Scripts/python -m pytest` (the backend suite). Front end: `cd apps/web && npx ng build`.

## Auth (byte-compatible design, retained from the migration)

Passwords are `scrypt:salt:digest` (Node `scryptSync`-compatible: N=16384, r=8, p=1, dklen=64, salt as a hex string). Sessions are HS256 JWTs signed with a shared `AUTH_SECRET`, carried in the httpOnly `reep_session` cookie. `require_*` dependencies in `apps/api-py/app/deps.py` / the routers read the session.

## The two rules that must not be broken

### 1. Student data must not leave the machine unbidden

`LLM_BASE_URL` is a URL, not a promise — it may point at a free model that trains on submissions. A resume brief carries a student's name, USN, marks and attendance.

`student_data_egress_allowed(base_url)` in **`apps/api-py/app/ai/llm.py`** is the gate: **loopback is always allowed; anything else requires `LLM_ALLOW_REMOTE_STUDENT_DATA=true`.** Call the model through `complete_chat(messages, carries_student_data=True, ...)` (or `stream_chat(...)`) on any path that sends a student's private records, and it is refused before leaving the process unless the gate permits it. When it refuses, `/student/resume/generate` composes the resume **deterministically** and says so (`used_ai=false`). Route any *new* student-PII-to-model path through this gate. Public data (a job posting) does not need it.

### 2. Staff scope is decided by role, not by a missing field

`require_mentor(session)` admits **MENTOR, DIRECTOR and ADMIN**; `require_director` admits DIRECTOR/ADMIN. To narrow to students, use `_assert_can_access_student(...)` in **`apps/api-py/app/routers/mentor.py`**: a MENTOR sees only students in their own `Mentor` group; DIRECTOR/ADMIN see all. **A MENTOR with no `Mentor` group sees NOBODY** — never the whole programme. Never read "no mentor group" as "whole programme".

## Backend conventions

- **Models** live in `apps/api-py/app/models/` and are the schema's source of truth; each new module is imported in `models/__init__.py` so Alembic autogenerate sees it.
- **Alembic enum gotchas** (hit these repeatedly): (a) adding an enum *column* to an existing table does not auto-`CREATE TYPE` — create it first; (b) a *new table* reusing an *existing* enum must use `postgresql.ENUM(..., name='x', create_type=False)` in the migration (autogenerate emits a bare `sa.Enum` that errors "type already exists" — hand-fix it); (c) two columns sharing one enum reuse a single `Enum` instance.
- **Universal LLM adapter** (`app/ai/llm.py`) is OpenAI-compatible and auto-selects the first configured provider (Sakana → Groq → Mistral → OpenRouter → Gemini → Cohere), or an explicit `LLM_BASE_URL`+`LLM_MODEL`+`LLM_API_KEY`. One set of keys, any provider, no code change.
- **Knowledge Base = pgvector.** The docker image is `pgvector/pgvector:pg17` (stock PG17 + `CREATE EXTENSION vector`); `KnowledgeChunk.embedding` is a dimensionless `vector`. Retrieval (`app/knowledge.py`) is HYBRID — Postgres full-text blended with pgvector cosine (`embedding <=> :q`), gated by a distance floor so an off-topic query still hits the honest "no approved answer" fallback. The embedder (`app/ai/embeddings.py`) mirrors the LLM adapter: explicit `EMBEDDING_*`, else auto-select Mistral (`mistral-embed`) — and **no embedder configured ⇒ full-text only** (the KB always works). The KB is APPROVED public policy text, so embedding it is outside the student-data egress gate.

## Frontend conventions

- Standalone components + Angular **signals**; `fetch(\`${environment.apiBase}/...\`, { credentials: 'include' })` for API calls (see `apps/web/src/app/features/student/jobs/jobs.component.ts` for the house pattern).
- The warm "REEP v2" design system is **global CSS classes** in `apps/web/src/styles/reep-v2.scss` (`.card`, `.dt-table`, `.chip good/warn/risk/neutral`, `.dense-*`, …) — reuse them; don't redefine globals in a component. Status is always shown as **text + colour together**, never colour alone.
- The design references are `docs/design-v2/*.html`.
