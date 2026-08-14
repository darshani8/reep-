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
  └── AI agent layer: CrewAI on Gemini
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
- [ ] **Phase 4 — AI agent layer.** CrewAI workflow on Gemini: Student Profile
  Manager + Resume Optimizer agents. `POST /api/agent/chat` with SSE streaming.
  Enforce the egress gate (paid/local for student PII).
- [ ] **Phase 5 — Resume engine.** ReportLab PDF generation behind
  `/api/resume`, driven by the Resume Optimizer agent.
- [ ] **Phase 6 — Angular parity.** Every screen currently only in Next.js
  (director area, AI panels, all student/mentor pages) in Angular
  (Material/Tailwind, Signals, ReactiveForms).
- [ ] **Phase 7 — Cutover + delete.** Point Angular fully at FastAPI, verify
  parity, then delete the Next.js app **and** NestJS `apps/api`. Rename
  `apps/api-py` → `apps/api`.

## Status log

- Phase 1 scaffolded and running (health + auth). Data-backed endpoints need
  Postgres up (`npm run db:up`) and the `reep_py` database created.
