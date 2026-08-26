# REEP Dashboard

A college **placement-readiness** platform for students, mentors and the placement office.

- **Front end** — Angular 22 SPA (`apps/web`): warm "REEP v2" desktop UI, standalone components + signals.
- **Back end** — Python / FastAPI (`apps/api-py`): SQLAlchemy 2.0 + Alembic + Pydantic v2 on PostgreSQL, with a universal OpenAI-compatible LLM adapter behind a student-data egress gate.
- **Database** — PostgreSQL 17 via `docker-compose.yml`.

> This repo was migrated from a Next.js/React + NestJS + Prisma stack to Angular + FastAPI. The old stack has been removed.

## Quick start

```bash
# 1. Postgres (host port 5433, container "reep-postgres")
docker compose up -d

# 2. API  (from apps/api-py; venv at .venv, Python 3.14)
cd apps/api-py
.venv/Scripts/python -m alembic upgrade head     # migrations
.venv/Scripts/python -m app.seed                 # idempotent dev seed
.venv/Scripts/python -m uvicorn app.main:app --port 3300
#   → http://127.0.0.1:3300/docs

# 3. Web  (from apps/web)
cd apps/web
npx ng serve                                     # → http://localhost:4200
```

The dev server proxies `/api` → `http://localhost:3300`, so the app is same-origin.

**Seeded logins**

| Role     | Email                    | Password    |
|----------|--------------------------|-------------|
| Student  | student@bgscet.ac.in     | student123  |
| Mentor   | mentor@bgscet.ac.in      | mentor123   |
| Director | director@bgscet.ac.in    | director123 |

## AI features (optional)

Text chat + AI resume polish run through the universal LLM adapter — paste any one provider key into `apps/api-py/.env` (`GROQ_API_KEY`, `MISTRAL_API_KEY`, a local Ollama URL, …) and it works with no code change. **Student PII never goes to a remote free model** unless `LLM_ALLOW_REMOTE_STUDENT_DATA=true`; otherwise the resume composes deterministically. Voice needs a LiveKit project plus `GROQ_API_KEY` — it runs as a cascade (Silero VAD → Groq Whisper → Groq Llama → TTS) in a separate worker process, not as a native speech-to-speech model.

## Tests

```bash
cd apps/api-py && .venv/Scripts/python -m pytest   # backend suite
cd apps/web && npx ng build                         # frontend compile
```

See [AGENTS.md](AGENTS.md) for architecture rules (the egress gate, mentor-scope authorization, Alembic enum gotchas) and [docs/](docs/) for the migration log and design references.
