# Migration: Next.js/React → Angular + Python (FastAPI)

Replace the Next.js full-stack app and the NestJS `apps/api` with an **Angular
frontend + Python/FastAPI backend**. Build the replacement to parity, cut over,
then delete the old stacks. **Nothing is deleted until parity is reached** — the
Next.js app is the only working product and the source of truth throughout.

## Target architecture

```
Angular (latest) — Angular Material / Tailwind · Signals · ReactiveForms
        │  HTTP REST + SSE (Server-Sent Events)
        ▼
Python — FastAPI
  ├── Routers: /api/resume, /api/agent/chat, + the ported REST surface
  ├── Resume generation: ReportLab (PDF engine)
  └── AI agent layer: Google ADK (any provider via LiteLLM)
        ├── Student Profile Manager Agent (memory & parsing)
        └── Resume Optimizer Agent (tailoring & formatting)
  Data: PostgreSQL via SQLAlchemy (fresh schema) + Alembic migrations
```

## Scale (what's being replaced)

| Piece | Size |
|---|---|
| Next.js app (`src/`) | 273 files · ~57,500 lines · 24 route handlers · 12 server actions |
| Prisma models | 39 |
| NestJS `apps/api` | 44 files (also removed — TypeScript) |
| Angular `apps/web` | 13 components today; needs full parity |

## Hard constraints

1. **Build before delete.** Delete Next.js/React and NestJS only in the final
   phase, once Angular + FastAPI cover every screen and endpoint.
2. **Student-data egress gate carries into Python.** The CrewAI/Gemini agents
   process student PII (marks, USN, attendance). Free-tier Gemini trains on
   submissions, so those agents run on a **paid** Gemini key or a **local**
   model — never free. Public/general prompts may use free Gemini. This mirrors
   `studentDataEgressAllowed()` and `AGENTS.md`.
3. **Auth interoperability.** Same `scrypt:salt:digest` passwords, same HS256
   JWT (shared `AUTH_SECRET`), same `reep_session` cookie — so sessions work on
   both stacks during cutover.

## Phases

- [x] **Phase 1 — FastAPI foundation + auth slice.** Scaffold `apps/api-py`
  (config, SQLAlchemy, session, security). `GET /health`,
  `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`. Auth byte-compatible
  with Next.js.
- [ ] **Phase 2 — Migrations + domain schema.** Wire Alembic. Port the 39
  models in slices (users/roster → academics → activity → jobs/offers →
  uploads → AI runs).
- [ ] **Phase 3 — REST surface.** Port the 24 route handlers + 12 server actions
  to FastAPI routers, preserving `mentorScope()`/`menteeWhere()` authorization.
  Repoint Angular at FastAPI, slice by slice.
- [~] **Phase 4 — AI agent layer.** Google ADK (any provider via LiteLLM):
  Student Profile Manager + Resume Optimizer agents. `POST /api/agent/chat` with
  SSE streaming. Enforce the egress gate (paid/local for student PII).
  *Started:* general agent + authenticated `/api/agent/chat` live on Groq;
  SSE + student-data agents next.
- [ ] **Phase 5 — Resume engine.** ReportLab PDF generation behind
  `/api/resume`, driven by the Resume Optimizer agent.
- [ ] **Phase 6 — Angular parity.** Every screen currently only in Next.js
  (director area, AI panels, all student/mentor pages) in Angular
  (Material/Tailwind, Signals, ReactiveForms).
- [ ] **Phase 7 — Cutover + delete.** Point Angular fully at FastAPI, verify
  parity, then delete the Next.js app **and** NestJS `apps/api`. Rename
  `apps/api-py` → `apps/api`.

## Status log

- Phase 1 scaffolded and running (health + auth). Merged to main.
- Docker/Postgres up; `reep_py` created. Alembic wired; auth-slice migration
  `f65867efe738` (users, students, mentors, login_days) applied to `reep_py`.
  End-to-end login verified against real Postgres (200 + session cookie).
- Universal LLM adapter (`app/ai/llm.py`) added — OpenAI-compatible, any
  provider via env, with the student-data egress gate ported from the Next.js
  app. One set of keys drives both stacks.
- AI framework: **Google ADK** (replaces CrewAI), reaching any provider via
  LiteLLM. Universal multi-provider auto-select added and live-tested on Groq.
  `POST /api/agent/chat` (authenticated) runs an ADK agent end to end — verified
  login -> chat -> "Tokyo." on groq/llama-3.3-70b-versatile. SSE streaming and
  the student-data agents (behind the egress gate) are next.
- Unified text + voice assistant: a centralized SQLite memory bank
  (`app/memory.py`, one row-per-turn `chat_history`) is SHARED by
  `POST /api/agent/chat` and the voice worker, keyed by session_id — verified
  live (a fact from turn 1 recalled in turn 2). `POST /api/voice/token` mints
  LiveKit JWTs with identity=session_id (verified). `voice_agent.py` runs
  **Gemini Live** (native speech-to-speech — no OpenAI/Google-Cloud) as a
  separate worker (`requirements-voice.txt`; needs LiveKit + Gemini creds to
  run). Angular `apps/web/src/app/core/chat-voice.service.ts` (signals) drives
  both text and voice; `livekit-client` installed. The spec's deprecated
  `VoicePipelineAgent` API was replaced with the current `AgentSession`.
- **Phase 2/3 domain port — in progress, 22 verified slices on main.** Each
  slice = SQLAlchemy model(s) + Alembic migration + authorized FastAPI
  endpoint(s), verified against Postgres and committed.
  - STUDENT: profile (+ PUT edit), semester results/marks, attendance %,
    combined dashboard, SWOC board, mock assessments, skills (catalogue + join),
    login streak, timesheet (GET + upsert), academic history, jobs board
    (skill-match % + eligibility funnel + apply), placement offers
    (create/list/submit), schedule, resume (AI behind the egress gate — refuses
    remote free models for PII, composes deterministically).
  - MENTOR: scoped mentee list, notes (GET/POST), alert feed + resolve — the
    `mentorScope()` rule enforced (no group => nobody).
  - DIRECTOR: overview aggregates, offer approve/reject (`require_director`).
  - Cross-cutting: the two-approver leave workflow.
  - Enum-column-on-existing-table migrations are hand-fixed to `CREATE TYPE`
    first (Alembic gotcha); shared enums reuse one `Enum` instance.
  - Remaining before Phase 3 cutover: uploads, activity/check-in, registration,
    curriculum (courses/certs/enrollment/lab sessions), cohort, agent-run store,
    then repoint Angular at these endpoints screen by screen.
