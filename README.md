# REEP Dashboard

A college **placement-readiness** platform for students, mentors and the placement office.

- **Front end** — Angular 22 SPA (`apps/web`): the "REEP v2" desktop UI — a lilac Y2K-chrome / glass design system in global CSS classes — standalone components + signals, every route lazy.
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

**Seeded logins.** `python -m app.seed` creates these and **refuses to run on
`ENV=prod`** — the passwords are published here, so the accounts must never exist
on a production host. In production the door is Google sign-in and the roster is
the access control; `POST /api/auth/login` answers 403 unless `PASSWORD_LOGIN=true`
or an operator has issued a real password with `python -m app.set_password`.

| Role       | Email                 | Password   |
|------------|-----------------------|------------|
| Student    | student@bgscet.ac.in  | student123 |
| Mentor     | mentor@bgscet.ac.in   | mentor123  |
| Alumni     | alumni@bgscet.ac.in   | alumni123  |
| Main Admin | admin@bgscet.ac.in    | admin123   |

There is **no DIRECTOR role** — it was removed in 2026-09-10 along with
`director@bgscet.ac.in`, which this table listed for months afterwards. ADMIN is
the placement office and there is exactly one of it; faculty are MENTOR and reach
a console screen only as a grant the Main Admin makes in Governance.

## AI features (optional)

Text chat + AI resume polish run through the universal LLM adapter — paste any one provider key into `apps/api-py/.env` (`GROQ_API_KEY`, `MISTRAL_API_KEY`, a local Ollama URL, …) and it works with no code change. **Student PII never goes to a remote free model** unless `LLM_ALLOW_REMOTE_STUDENT_DATA=true`; otherwise the resume composes deterministically.

**Voice is the mock interviewer at `/student/assistant`**, and it takes no API key. It is genuinely speech-to-speech — Amazon Nova 2 Sonic on Bedrock, over a WebSocket **inside the API process**, signed with SigV4 from the standard AWS chain; what must resolve is a region (`NOVA_SONIC_REGION`, falling back to `BEDROCK_REGION`, then `AWS_REGION`), not a secret. Blank means `GET /api/interview/status` reports unavailable and nothing else in the dashboard is affected.

> The LiveKit cascade (Silero VAD → Groq Whisper → Groq Llama → TTS, in a fourth process on its own Python 3.12 venv) was **removed in 2026-09** and this paragraph described it until Phase 5. There is no separate worker, no `voice_agent.py`, no `requirements-voice.txt` and no `/api/voice/*`.

## Tests

```bash
cd apps/api-py && .venv/Scripts/python -m pytest   # backend suite
cd apps/web && npx ng build                         # frontend compile
```

`main` is gated by **five** required status checks, and `./tools/ci/preflight.sh`
runs all five locally in the order that fails fastest — read its exit code, not
its last line: `2` means nothing failed but something did not *run*, which is not
the same as passing. See [tools/ci/README.md](tools/ci/README.md).

See [AGENTS.md](AGENTS.md) for architecture rules (the egress gate, mentor-scope authorization, Alembic enum gotchas) and [docs/](docs/) for the migration log and design references.
