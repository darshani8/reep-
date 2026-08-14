# REEP API — Python / FastAPI

The Python backend that replaces the Next.js API routes **and** the NestJS
`apps/api` during the Angular + Python migration. Built alongside the existing
app; nothing is deleted until Angular + this backend reach parity (see
[`docs/python-fastapi-migration.md`](../../docs/python-fastapi-migration.md)).

## Target architecture

```
Angular (Material/Tailwind · Signals · ReactiveForms)
        │  HTTP REST + SSE
        ▼
FastAPI
  ├── /api/resume          → ReportLab PDF engine
  ├── /api/agent/chat      → SSE stream
  └── AI layer: CrewAI on Gemini
        ├── Student Profile Manager (memory & parsing)
        └── Resume Optimizer (tailoring & formatting)
  DB: PostgreSQL via SQLAlchemy (fresh schema) + Alembic
```

## Stack (Phase 1)

FastAPI · SQLAlchemy 2.0 · Alembic · Pydantic v2 · psycopg 3 · PyJWT ·
uvicorn. Python 3.14.

## Run it

```bash
cd apps/api-py
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt   # Windows
# source .venv/bin/activate; pip install -r requirements.txt   # macOS/Linux

cp .env.example .env        # then set AUTH_SECRET to match the Next.js app

# DB (from the repo root): start Postgres and create the fresh database
npm run db:up
docker exec reep-postgres createdb -U reep reep_py

# create the current tables + a demo director (director@bgscet.ac.in / director123)
.venv/Scripts/python.exe -m app.seed

# serve
.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 3300
```

- Health: <http://localhost:3300/health>
- Interactive docs: <http://localhost:3300/docs>

## What works now (Phase 1)

- `GET  /health` — liveness (no DB).
- `POST /auth/login` — `{email, password}` → sets the `reep_session` cookie,
  returns the session user.
- `GET  /auth/me` — current session from the cookie.
- `POST /auth/logout` — clears the cookie.

Auth is **byte-compatible** with the Next.js app: same `scrypt:salt:digest`
password format, same HS256 JWT (shared `AUTH_SECRET`), same cookie — so
sessions interoperate during cutover.

## Non-negotiable: the student-data egress gate carries over

The Next.js app refuses to send student PII (name, USN, marks, attendance) to a
remote model unless explicitly allowed. **The CrewAI/Gemini layer must enforce
the same rule** — free-tier Gemini trains on submissions, so student-data agents
run on a paid Gemini key or a local model, never free. Public/general prompts
may use free Gemini.
