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
   .venv/Scripts/pip install -r requirements-dev.txt  # runtime + pytest
   .venv/Scripts/python -m alembic upgrade head      # apply migrations
   .venv/Scripts/python -m app.seed                  # idempotent dev seed
   .venv/Scripts/python -m uvicorn app.main:app --port 3300
   ```
   Docs at http://127.0.0.1:3300/docs. **Windows note:** `uvicorn --reload` has wedged a stale worker here — after editing backend files, kill port 3300 and restart rather than relying on `--reload`.
3. **Front end** — from `apps/web`: `npx ng serve` (port 4200). `proxy.conf.json` forwards `/api` → `http://localhost:3300`, so the app is same-origin and the httpOnly session cookie is carried. The whole API surface the client calls lives under `/api`.
4. **Voice worker (optional)** — a **FOURTH process**, from `apps/api-py`, in its **own** venv:
   ```
   py -3.12 -m venv .venv-voice                              # once
   .venv-voice/Scripts/pip install -r requirements-voice.txt # once
   .venv-voice/Scripts/python voice_agent.py dev             # `start` in production
   ```
   Python 3.12, not 3.14: `livekit-agents` declares `Requires-Python: <3.15`. It reads the **same** `apps/api-py/.env` and POSTs to `REEP_API_URL` (default `http://localhost:3300`), so credentials are entered once.

   Without it, `GET /api/voice/status` reports `worker_healthy: false` and `POST /api/voice/token` returns **409** — voice, and only voice, is unavailable. (A missing `LIVEKIT_*`/`GROQ_API_KEY`, or a non-blank `VOICE_MAINTENANCE_MESSAGE`, is a **503** instead.) Everything else works normally, which is why this step is optional — but a student pressing "Start voice" with no worker running is the single most common "why is it broken" report, and nothing in the UI says a fourth process exists.

Seeded logins: `student@bgscet.ac.in` / `student123`, `mentor@bgscet.ac.in` / `mentor123`, `director@bgscet.ac.in` / `director123`.

### Two requirements files, two seeds — the split is deliberate

- `requirements.txt` is **runtime only** and pinned `==`; it is what the Dockerfile installs. `requirements-dev.txt` pulls it in and adds pytest. A test runner has no business in a production image, and `>=` bounds meant a rebuild months later resolved a dependency set nobody had run the suite against.
- `python -m app.seed` **refuses to run when `ENV=prod`.** It creates the three logins above — including a DIRECTOR, who by rule 2 below reads every student's marks, attendance and USN — behind passwords published in this file. That account must never exist on a production host, so there is no override flag.
- `python -m app.seed_kb` is the production-safe seed: the grounded assistant's Knowledge Base, no accounts. Production needs it (without it the assistant has nothing to ground against) and never needs the demo users, which is why they no longer travel together.

**Tests:** `cd apps/api-py && .venv/Scripts/python -m pytest` (the backend suite). Front end: `cd apps/web && npx ng build`.

**Routes are lazy.** `app.routes.ts` uses `loadComponent`, never a static `component:` reference. Every route was once eagerly imported, which put the whole app — mentor and director screens, the resume builder, the LiveKit-backed assistant — into a single 1.23 MB `main` chunk that a student on a phone downloaded before the login form could paint. It is ~142 kB initial now, and the production bundle budget is set close enough to that number that one re-eager-ed route fails `ng build` in CI.

## Auth — Google-only sign-in over the session retained from the migration

**Sign-in is Google, for every role, and the roster is the access control.** `app/google_auth.py` verifies the Google ID token properly — RS256 signature against Google's JWKS, `aud` = our client id, `iss` = accounts.google.com, unexpired, `email_verified` true, plus a single-use `state` cookie and a `nonce` — and then looks the verified email up in `users`. **A Google account with no matching row is refused** (`302 /login?error=sso_not_enrolled`); nothing self-provisions, and no role is ever guessed. Students come from `python -m app.seed_roster` — production-safe and idempotent like `app.seed_kb`, no passwords — which derives the email from the USN (`1MP25MDM01` → `1mp25mdm01@bgscet.ac.in`, domain from `ROSTER_EMAIL_DOMAIN`, alias `COLLEGE_EMAIL_DOMAIN`; `--rekey-domain` moves an already-seeded batch if that guess was wrong), so a student's USN is already filled in on their profile and they never type it.

What Google issues is **the same session as before, byte for byte**: passwords are `scrypt:salt:digest` (Node `scryptSync`-compatible: N=16384, r=8, p=1, dklen=64, salt as a hex string), sessions are HS256 JWTs signed with a shared `AUTH_SECRET` carrying the same claims (`userId, email, name, role, studentId?, mentorId?`), in the httpOnly `reep_session` cookie. `require_*` dependencies in `apps/api-py/app/deps.py` / the routers read the session and were **not changed** — they cannot tell the two paths apart.

`POST /api/auth/login` (password) is **kept and refused when `ENV=prod`**, the same guard shape `app/seed.py` uses: the `login` fixture in `tests/conftest.py` and the six test modules that use it authenticate through it, so deleting it would take the DB-backed suite and CI with it. The guard is `settings.password_login_allowed` — an allowlist of dev/CI environment names, not `not is_prod`, so an unrecognised `ENV` shuts the password door rather than opening it. Production answers 403 and names Google instead. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `apps/api-py/.env`; blank means `GET /api/auth/sso/status` reports unavailable and the login screen's Google button renders disabled with the reason — nothing else is affected. Full notes, including the exact authorised redirect URI and a troubleshooting section: `docs/google-sign-in.md`.

### Voice runbook: the call sounded fine but saved nothing

The worst failure mode in this stack is silent — the conversation is perfect in the room and empty in the database, because transcript POSTs are deliberately fire-and-forget so a bad write can never kill a live call. After a test call:

```sql
select channel, count(*), max(created_at) from messages group by channel;
```

No `voice` rows, or a stale `max(created_at)`, means turns are being dropped. Two causes, in order of likelihood:

1. **`VOICE_WORKER_SECRET` differs between the API and the worker** → every POST 401s. The worker still connects to LiveKit and answers normally, so nothing looks wrong from the outside.
2. **`REEP_API_URL` is wrong** (usually `localhost` from inside a container) → the POSTs never arrive.

Both now appear as `ERROR POST /api/voice/transcript -> HTTP 401: …` in the worker's log, with the status code. They used to be a WARNING that folded every cause into one line.

### The assistant screen is the mock interviewer (2026-08)

`/student/assistant` is the realtime mock interviewer: a WebSocket to `/api/interview` relaying 24 kHz PCM to the OpenAI Realtime API and back. It runs **inside the API process** — it is not a fifth process, and it needs no extra venv. Set `OPENAI_API_KEY` in `apps/api-py/.env`; blank means `GET /api/interview/status` reports unavailable and the socket closes 4001, and nothing else in the dashboard is affected. Full notes: `docs/interview-assistant.md`.

Turns are persisted through `app/conversations.py` with `channel='interview'`, so the runbook query above still answers "did it save anything" — group by `channel` and look for `interview`. The writes are fire-and-forget for the same reason the voice ones are, so the same silent failure applies; the cause is logged as `Dropped interview turn`.

**The Specialization Matrix** (`app/interview_matrix.py`): the student picks HR, Digital Marketing, Business Analytics or Financial Analytics on the assistant screen, the client sends it as `?specialization=` on the socket, and an `InterviewStateMachine` advances the interview through `opening → probing → deep_dive → wrap_up` on each completed student answer, steering the model with an instructions-only `session.update` per phase change. Instructions are always the base persona **verbatim** plus a fixed specialization block and phase directive — no student record enters them, so rule 1 is unaffected. No param runs the generic interview; an unknown key is refused with close 4010.

The LiveKit voice stack (step 4 above, `voice_agent.py`, `/api/voice/*`) and the text orchestrator (`POST /api/agent/ask`) are **retained and mounted but have no UI caller.** They are the rollback path, not dead code — do not run the voice worker expecting a button, and do not delete them until the interviewer has held up in front of real students. Two knock-on effects, both silent: `POST /api/agent/feedback` 404s on every request because no `AgentRun` rows are written any more, and the `AgentRun`-derived counters in `GET /api/agent/metrics` read 0. `voice_turns` (off `Message.channel`) keeps working.

`apps/interview-realtime/` is the superseded standalone prototype of this relay. It has no authentication and no database — **do not deploy it**; see the banner at the top of its `app/server.py`.

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
