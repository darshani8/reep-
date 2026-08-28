# REEP — the stack

REEP is a college placement-readiness dashboard. It is an **Angular front end** talking to a **Python/FastAPI back end** over HTTP, on **PostgreSQL**. (It used to be a Next.js/React app with a NestJS API and Prisma — that stack has been fully migrated away and deleted. Ignore any lingering references to Next.js, React, Prisma, `server-only`, or `apps/api`; they are gone.)

```
apps/web      Angular 22 SPA (standalone components, signals, ReactiveForms)
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

   **On `ENV=prod` this process now REFUSES TO BOOT on a bad secret, and that is not a bug in your deploy script.** `Settings.production_boot_failures()` (`app/config.py`) is raised from `app/main.py`'s lifespan, so uvicorn never binds a port, and the log names every problem it found. It fires on: an `AUTH_SECRET` that is blank, still the value published in this repo and `.env.example`, an obvious placeholder, or shorter than 32 characters; and a `DATABASE_URL` still carrying this repo's dev password. Set real values — the message includes the command to generate a secret. It is deliberately a refusal and not a warning: `AUTH_SECRET` signs the `reep_session` cookie, so a production host running on the repo default is one forged `{"role":"DIRECTOR"}` cookie away from every student's marks, attendance and USN, with no login and no database row involved. On every development `ENV` the check returns nothing at all, and `tests/test_boot_guard.py` pins that as hard as it pins the refusal — a guard that trips on a laptop gets deleted by whoever is trying to ship that afternoon.
3. **Front end** — from `apps/web`: `npx ng serve` (port 4200). `proxy.conf.json` forwards `/api` → `http://localhost:3300`, so the app is same-origin and the httpOnly session cookie is carried. The whole API surface the client calls lives under `/api`.
4. **Voice worker (optional)** — a **FOURTH process**, from `apps/api-py`, in its **own** venv:
   ```
   py -3.12 -m venv .venv-voice                              # once
   .venv-voice/Scripts/pip install -r requirements-voice.txt # once
   .venv-voice/Scripts/python voice_agent.py dev             # `start` in production
   ```
   Python 3.12, not 3.14: `livekit-agents` declares `Requires-Python: <3.15`. It reads the **same** `apps/api-py/.env` and POSTs to `REEP_API_URL` (default `http://localhost:3300`), so credentials are entered once.

   Without it, `GET /api/voice/status` reports `worker_healthy: false` and `POST /api/voice/token` returns **409** — voice, and only voice, is unavailable. (A missing `LIVEKIT_*`/`GROQ_API_KEY`, or a non-blank `VOICE_MAINTENANCE_MESSAGE`, is a **503** instead.) Everything else works normally, which is why this step is optional — but a student pressing "Start voice" with no worker running is the single most common "why is it broken" report, and nothing in the UI says a fourth process exists.

Seeded logins: `student@bgscet.ac.in` / `student123`, `mentor@bgscet.ac.in` / `mentor123`, `director@bgscet.ac.in` / `director123`, `alumni@bgscet.ac.in` / `alumni123` (no profile row — so the alumni first-login create-profile flow is what you see on a fresh database).

### Two requirements files, two seeds — the split is deliberate

- `requirements.txt` is **runtime only** and pinned `==`; it is what the Dockerfile installs. `requirements-dev.txt` pulls it in and adds pytest. A test runner has no business in a production image, and `>=` bounds meant a rebuild months later resolved a dependency set nobody had run the suite against.
- `python -m app.seed` **refuses to run when `ENV=prod`.** It creates the three logins above — including a DIRECTOR, who by rule 2 below reads every student's marks, attendance and USN — behind passwords published in this file. That account must never exist on a production host, so there is no override flag.
- `python -m app.seed_kb` is the production-safe seed: the grounded assistant's Knowledge Base, no accounts. Production needs it (without it the assistant has nothing to ground against) and never needs the demo users, which is why they no longer travel together.

**Tests:** `cd apps/api-py && .venv/Scripts/python -m pytest` (the backend suite). Front end: `cd apps/web && npx ng build`.

**CI has four jobs**, and two of them exist because a manifest shipped
incomplete. `worker-imports` proves `requirements-voice.txt` covers everything
`voice_agent.py` imports; `api-imports` does the same for `app/` against
`requirements.txt` ALONE (`tools/ci/check_api_imports.py`). The API one was added
after `app/interview_local.py` reached main importing numpy undeclared — the
import is lazy, inside a request handler, so the API still booted and every test
still passed, and the break surfaced only as a pytest COLLECTION failure on a
clean machine. A lazy import does not make an undeclared dependency acceptable;
it only moves the crash from boot to the first student who reaches that path.

**Routes are lazy.** `app.routes.ts` uses `loadComponent`, never a static `component:` reference. Every route was once eagerly imported, which put the whole app — mentor and director screens, the resume builder, the LiveKit-backed assistant — into a single 1.23 MB `main` chunk that a student on a phone downloaded before the login form could paint. It is ~142 kB initial now, and the production bundle budget is set close enough to that number that one re-eager-ed route fails `ng build` in CI.

## Auth — Google-only sign-in over the session retained from the migration

**Sign-in is Google, for every role, and the roster is the access control.** `app/google_auth.py` verifies the Google ID token properly — RS256 signature against Google's JWKS, `aud` = our client id, `iss` = accounts.google.com, unexpired, `email_verified` true, plus a single-use `state` cookie and a `nonce` — and then looks the verified email up in `users`. **A Google account with no matching row is refused** (`302 /login?error=sso_not_enrolled`); nothing self-provisions, and no role is ever guessed. Students come from `python -m app.seed_roster` — production-safe and idempotent like `app.seed_kb`, no passwords — which derives the email from the USN (`1MP25MDM01` → `1mp25mdm01@bgscet.ac.in`, domain from `ROSTER_EMAIL_DOMAIN`, alias `COLLEGE_EMAIL_DOMAIN`; `--rekey-domain` moves an already-seeded batch if that guess was wrong), so a student's USN is already filled in on their profile and they never type it.

What Google issues is **the same session as before, byte for byte**: passwords are `scrypt:salt:digest` (Node `scryptSync`-compatible: N=16384, r=8, p=1, dklen=64, salt as a hex string), sessions are HS256 JWTs signed with a shared `AUTH_SECRET` carrying the same claims (`userId, email, name, role, studentId?, mentorId?`), in the httpOnly `reep_session` cookie. `require_*` dependencies in `apps/api-py/app/identity.py` / the routers read the session and were **not changed** — they cannot tell the two paths apart.

`POST /api/auth/login` (password) is **kept and refused when `ENV=prod`**, the same guard shape `app/seed.py` uses: the `login` fixture in `tests/conftest.py` and the six test modules that use it authenticate through it, so deleting it would take the DB-backed suite and CI with it. The guard is `settings.password_login_allowed` — an allowlist of dev/CI environment names, not `not is_prod`, so an unrecognised `ENV` shuts the password door rather than opening it. Production answers 403 and names Google instead. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `apps/api-py/.env`; blank means `GET /api/auth/sso/status` reports unavailable and the login screen's Google button renders disabled with the reason — nothing else is affected. Full notes, including the exact authorised redirect URI and a troubleshooting section: `docs/google-sign-in.md`.

**The login screen shows a password form on development servers, and only there.** With no `GOOGLE_CLIENT_ID` set, the disabled Google button was the *only* control on the screen, so a fresh clone could not reach the dashboard in a browser at all — the API was reachable by `curl` and the UI was not reachable by anyone. The form renders off `password_login_available` on the same `/sso/status` probe, i.e. off `settings.password_login_allowed`, so it is the allowlist above that decides — `prod`, `production`, `staging`, `uat`, `demo`, a blank `ENV` and a typo'd one all render nothing, and `POST /api/auth/login` answers 403 there regardless. Two independent locks, and the client half **fails closed** where the Google probe fails open: a 404, a timeout or an unexpected payload leaves the form hidden, because a broken probe must never draw a second door on a production login screen. It carries quick-fill buttons for the three seeded logins and lands each role on `HOME_FOR_ROLE` — which mirrors `_HOME_FOR_ROLE` in `app/routers/auth.py`, because the SPA's own `''` route redirects to `/student` unconditionally and a DIRECTOR sent to `/` bounces off a student-only screen.

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

**The v3 engine: the relay owns the turn.** The session runs `turn_detection.create_response: false`, so upstream no longer asks the next question by itself the moment the student stops speaking — it did, and that is why the phase directive was structurally one response late and why a cough could create a question. Now the relay waits for the transcript (on a deadline, because a wait nobody bounds is an interview that never continues), judges it with a deterministic word-count gate rather than a hot-path model call, ticks the phase machine, and only then issues **one** `response.create` from **one** call site — which is what makes "one open question at a time" a property of the call graph instead of a sentence in the persona. If a second `response.create` site ever appears after the handshake, that invariant is gone and no test will notice. The arc is still `opening → probing → deep_dive → wrap_up` on each *accepted* answer, steered by an instructions-only `session.update` per phase change; the student picks HR, Digital Marketing, Business Analytics or Financial Analytics and the client sends it as `?specialization=` (no param runs the generic interview, which never reaches wrap-up and so never produces a report; an unknown key is refused with close 4010). At wrap-up the model speaks its verdict, and then one further **text-only** `response.create` in the same session produces a strict-JSON scorecard — parsed defensively, never spoken, never written into the chat history, and persisted whatever happens to it. The arc now opens and closes like a real interview: OPENING is a greet/self-introduction beat (the hard scenario question moved to PROBING), and the tick into WRAP_UP first asks "any questions for us?" — the student's reply, never word-gated, earns the verdict, and only the verdict's `response.done` (gated on `_verdict_requested`) requests the scorecard. Voices are per-specialization on the matrix row (HR `coral`, DM `marin`, BA `cedar`, FA `ash`), set in the single startup `session.update`, with `OPENAI_REALTIME_VOICE` as the generic fallback (validated against the known set, logged fallback to `alloy`); `_advance_turn` remains the single post-handshake create site, the invite/verdict beats included. Instructions are still the base persona **verbatim** plus a fixed specialization block, a phase directive and a fixed clarification override; **no student transcript is ever composed into them**, which is a guardrail of shape rather than of necessity — the moment student text goes into an instruction string, the next editor puts a resume there. Rule 1 is unaffected.

The interview now leaves a **record of its own**, in four tables (`app/models/interview.py`) that are *in addition* to `messages`, never instead: `interview_sessions` (one per interview — the terminal status, the phase it reached, `turns_emitted` vs `turns_persisted`, and the consent grant), `interview_turns` (the phase a turn happened in, whether the transcriber actually heard it, whether it advanced the arc — an empty `content` is legal and means exactly that), `interview_evaluations` (the scorecard, with **nullable** scores, because a missing score and a zero mean opposite things to a mentor), and `interview_consents`. The student reads their own at `/student/interviews`; staff read them through rule 2's gate. A `running` row that is never closed is a record that lies, so three layers close it — the relay's finalizer, the router's `finally` backstop, and retention's orphan sweeper for the process that was killed — all idempotent against each other by one `AND status = 'running'` predicate. The whole record is deleted after `INTERVIEW_RETENTION_DAYS` (180).

**Consent is a row and the socket enforces it.** No live `interview_consents` grant for the current `INTERVIEW_CONSENT_VERSION` and the interview never opens — close **4013**, refused before anything is written; revoked while it runs and the heartbeat notices within a minute — close **4014**. Three separate booleans (live AI, store transcript, store audio), because they are three different disclosures and one boolean makes "they consented" unfalsifiable. `interview_sessions.consent_id` pins the exact grant, so *"was this student consented, to what wording, at the time of interview X"* stays answerable after it has been revoked. Opening fails **closed** and the mid-interview check fails **open**, deliberately: "we could not check whether they agreed" must never start an interview, and a database hiccup must never end one that a real grant authorised.

**Audio: off, and "off" is two independent switches.** Nothing is captured unless `INTERVIEW_RECORDING_ENABLED=true` *and* the student holds a live grant whose `scope_store_audio` is true — a separate, unticked checkbox whose copy says plainly that staff can listen. Neither is true in a default deployment. When both are, `app/interview_audio.py` writes two WAV files per interview (one per speaker, never mixed — the two directions are not time-aligned), capped by `INTERVIEW_RECORDING_MAX_BYTES` with a truncation flag rather than a silent cut, retrievable only by DIRECTOR/ADMIN and deleted on the same 180-day clock. Branch on `interview_sessions.audio_recorded`, **never** on `audio_path IS NOT NULL` — a NULL path collapses four different facts into one. This overrides `docs/interview-engine-v3.md` §8.4, which argued against capture; read that section anyway, because it is why every guard above exists.

The LiveKit voice stack (step 4 above, `voice_agent.py`, `/api/voice/*`) and the text orchestrator (`POST /api/agent/ask`) are **retained and mounted but have no UI caller.** They are the rollback path, not dead code — do not run the voice worker expecting a button, and do not delete them until the interviewer has held up in front of real students. Two knock-on effects, and they are no longer silent: `POST /api/agent/feedback` 404s on every request because no `AgentRun` rows are written any more, and the `AgentRun`-derived counters in `GET /api/agent/metrics` read 0. Both now **say so** — `AGENT_RUNS_COLLECTED = False` in `app/routers/agent.py` gates a 404 detail naming the supersession and a `collected: false` on the metrics payload, so a frozen history is not read as a live zero. Flip that one constant back to `True` on rollback and both revert with no second edit. `voice_turns` (off `Message.channel`) keeps working.

`apps/interview-realtime/` is the superseded standalone prototype of this relay. It has no authentication and no database — **do not deploy it**; see the banner at the top of its `app/server.py`.

## The two rules that must not be broken

### 1. Student data must not leave the machine unbidden

`LLM_BASE_URL` is a URL, not a promise — it may point at a free model that trains on submissions. A resume brief carries a student's name, USN, marks and attendance.

`student_data_egress_allowed(base_url)` in **`apps/api-py/app/ai/llm.py`** is the gate: **loopback is always allowed; anything else requires `LLM_ALLOW_REMOTE_STUDENT_DATA=true`.** Call the model through `complete_chat(messages, carries_student_data=True, ...)` (or `stream_chat(...)`) on any path that sends a student's private records, and it is refused before leaving the process unless the gate permits it. When it refuses, `/student/resume/generate` composes the resume **deterministically** and says so (`used_ai=false`). Route any *new* student-PII-to-model path through this gate. Public data (a job posting) does not need it.

### 2. Staff scope is decided by role, not by a missing field

`require_mentor(session)` admits **MENTOR, DIRECTOR and ADMIN**; `require_director` admits DIRECTOR/ADMIN. To narrow to students, use `_assert_can_access_student(...)` in **`apps/api-py/app/routers/mentor.py`**: a MENTOR sees only students in their own `Mentor` group; DIRECTOR/ADMIN see all. **A MENTOR with no `Mentor` group sees NOBODY** — never the whole programme. Never read "no mentor group" as "whole programme".

## The v2 student screens (2026-08)

Three screens the handoff adds, with their own tables and endpoints in
`app/routers/student_programme.py` — its own module so `routers/student.py`
(2 200 lines, and the file every other student change touches) did not grow
another 600. It mounts under the same `/student` prefix, so the client sees one
flat surface.

**Time Allocation Ledger** (`/student/time-log`) — six slots covering a 24-hour
day x five activity heads. **The unit is the half hour, stored as an integer.**
The day must reconcile to exactly 24 h before it may be submitted, and a float
column makes that a game of epsilons: drift across thirty cells leaves a
perfectly filled day sitting at 23.999999 and refusing to submit, with nothing
on screen to explain it. Integers make "does this add to 24" an exact comparison
against 48, and the API converts at the edge so the client still speaks hours.
Every cell is bounded twice, both from `SLOT_CAPACITY_HALVES`: no cell over its
slot's capacity, and no slot's five cells summing past it. `copy-yesterday`
copies only a **SUBMITTED** day — copying a half-finished draft spreads a mistake
forward with nothing saying where the numbers came from. Submitting latches the
day; it is then read-only. It does **not** replace `time_sheet_entries`, which
still answers the weekly SKILLING-hours-vs-target question the dashboard draws.

**English Baseline** (`/student/english`) — CEFR-aligned, AI-scored, one attempt
per semester. **Every score is nullable and that is load-bearing**: speaking is
scored after the other three, so "3 of 4 sections scored - Speaking pending" is
the healthy state, and a pending section rendering as a confident `0` in a 27px
numeral tells a student they failed something they have not sat. The client
branches on `status`, never on a falsy score. `provisional` is derived from how
many sections are scored, so the word cannot outlive the section that resolves
it.

**Mentor Meeting Log** (`/student/mentor-log`) — the student's own 1:1 history,
read from `mentor_notes` (extended with nullable `title` / `location`; existing
notes are **not** backfilled, because inventing a heading puts words in a
mentor's mouth on a screen the student reads). The mentor's internal vocabulary
is translated server-side — `FLAGGED` reads as "Flagged for follow-up".

**The landing stage cards** (`GET /api/student/programme`) — Reboot / Excel /
Elevate. **The catalogue is code and only the status is a row**
(`app/models/milestone.py`): seeding fourteen rows per student to say "not
started" would put the programme's shape in the database in thousands of places,
where a rename becomes a migration. One item is derived rather than stored —
`english_baseline` reads its status from the attempt, because two sources of
truth for one row is how that row ends up saying "not started" under a finished
report.

`python -m app.seed` seeds all four, including a ledger deliberately 0.5 h short
so the "0.5 h to reconcile" state is the one you see on a fresh database.

**Staff read these through rule 2's gate**, in `app/routers/mentee_records.py`:
`GET /api/mentor/students/{id}/ledger`, `.../ledger/summary` and
`.../english-baseline`. Every one names a student in the PATH, so every one goes
through `_assert_can_access_student` — imported from `routers/mentor.py`, never
reimplemented. The views are the **student's own**: `compose_ledger` and
`compose_english_baseline` are shared builders, so a mentor cannot see a
confident `0` where the student sees a dash. Read-only by design — a mentor's
instrument is the meeting note, which already has a write path.

The write paths behind the screens' buttons: `POST /english-baseline/start`
(idempotent — one attempt per semester is enforced by a unique index, so a
double-tap reads the existing row rather than 409-ing), `GET
/english-baseline/report` (ReportLab, local, so rule 1's gate does not apply —
do not add a remote renderer), and `POST /mentor-meetings/request`, which writes
a **mentor note** rather than inventing a requests table: that is already the
mentor's instrument for this student and already on their screen.

## The Skills & Badge dashboard (2026-08)

Implements the "REEP Student Skills & Badge Dashboard Developer Framework"
document end to end for CURRENT students, structured exactly as its §19 asks:
REEP stage → skill category → skill → evidence → badge → growth.

**The 48-badge catalogue is code** (`BADGES` in `app/models/badge.py` — 12
managerial, 16 sectoral across four tracks, 10 platform/technical, 6 thinking,
4 readiness), the milestone rule again: only student state is rows. The
framework's §18 "admins add/edit badges" is therefore a code change HERE, on
purpose; what admins maintain in the database is the **Approved Certification
Catalogue** (§12, CRUD under `/api/director/approved-certifications`), evidence
verdicts, manual awards/revocations and assessment scores. `test_badges.py`
pins the catalogue's shape against the document.

**Certificate ≠ badge, enforced by the write path**: a student attaches
evidence (`badge_evidence` — several per badge, one per §11 type; the document's
own Negotiation example) and only a staff APPROVE on
`/api/mentor/badge-evidence/{id}/review` mints the `student_badges` EARNED row,
points stamped from the catalogue at that moment. §13 display status is DERIVED
(`compose_badges`), never stored. Readiness badges (§8) refuse evidence — they
arrive only through the manual-award endpoint when assessment thresholds are
met. Revoke is DIRECTOR/ADMIN and deletes the award row, never the evidence
history.

**Growth (§9/§15)** is `capability_assessments` — seven capabilities, 1–10, at
T0–T4, staff-entered and upserted. Every derived score is nullable and a
missing score renders as a dash: growth is claimed only when T0 AND a later
checkpoint both exist, because 0.0 with only a baseline says "has not improved"
when nobody has looked. The §16 **Most Improved** leaderboard ranks that growth,
not points; every leaderboard honours the existing `leaderboard_opt_out`.

Screens: `/student/badges` (journey strip, tiles, §14 detail + claim form,
growth table, leaderboards) and `/mentor/badge-centre` (verification queue
with the scoped certificate stream, assessment entry, §17 skill profile,
director cohort CSV at `/api/director/badges/export.csv`). Staff reads reuse
`compose_badges`/`compose_growth` — the mentor sees exactly the student's own
screen. Rule 1 untouched (nothing here calls a model); rule 2 via
`_assert_can_access_student`, with the pending queue narrowed in SQL.

## The faculty & alumni pages (2026-08)

**Faculty** (any staff role, in the shell's staff nav): **Mentee Log**
(`/mentor/mentees` — mentees + meeting notes, on the existing
`/api/mentor/mentees` and `/notes` endpoints, all behind rule 2's gate),
**Leave Requests** (`/mentor/leave` — submit own + the two-approver queue on
`/api/leaves/*`), and **Upskilling** (`/mentor/upskilling` — the staff member's
OWN completed-course certificates, `app/routers/staff_upskilling.py`). The
upskilling shelf is keyed on `users.id`, not a Student row, goes through the
same hardened document_store as student uploads, applies its own per-user quota
(document_store's contract for any second `save_bytes` writer), and has **no review
workflow** — a staff certificate is a record, not evidence awaiting a verdict.

**Alumni** are a real role: `Role.ALUMNI`, no Student/Mentor row, no staff
scope, session claims carry neither `studentId` nor `mentorId`. Their surface
is `app/routers/alumni.py`: `GET /api/alumni/profile` answers `created: false`
until they save one — that flag (never a falsy company string) is what makes
the client show the FIRST-LOGIN create form (current company + current resume,
resume required on create, kept-if-omitted on update) — plus their resume
download and `GET /api/alumni/jobs`, the postings sheet **without** the student
feed's match % / eligibility verdict (those are computed from a Student's
skills and marks, which an alumnus does not have). The shell's sidebar switches
on role (`navKind` in `layout/app-shell.component.ts`), and the SPA's `''`
route now routes by role through `homeRedirectGuard` instead of sending every
role to `/student`.

## Backend conventions

- **Models** live in `apps/api-py/app/models/` and are the schema's source of truth; each new module is imported in `models/__init__.py` so Alembic autogenerate sees it.
- **Alembic enum gotchas** (hit these repeatedly): (a) adding an enum *column* to an existing table does not auto-`CREATE TYPE` — create it first; (b) a *new table* reusing an *existing* enum must use `postgresql.ENUM(..., name='x', create_type=False)` in the migration (autogenerate emits a bare `sa.Enum` that errors "type already exists" — hand-fix it); (c) two columns sharing one enum reuse a single `Enum` instance.
- **Universal LLM adapter** (`app/ai/llm.py`) is OpenAI-compatible and auto-selects the first configured provider (Sakana → Groq → Mistral → OpenRouter → Gemini → Cohere), or an explicit `LLM_BASE_URL`+`LLM_MODEL`+`LLM_API_KEY`. One set of keys, any provider, no code change.
- **Knowledge Base = pgvector.** The docker image is `pgvector/pgvector:pg17` (stock PG17 + `CREATE EXTENSION vector`); `KnowledgeChunk.embedding` is a dimensionless `vector`. Retrieval (`app/knowledge.py`) is HYBRID — Postgres full-text blended with pgvector cosine (`embedding <=> :q`), gated by a distance floor so an off-topic query still hits the honest "no approved answer" fallback. The embedder (`app/ai/embeddings.py`) mirrors the LLM adapter: explicit `EMBEDDING_*`, else auto-select Mistral (`mistral-embed`) — and **no embedder configured ⇒ full-text only** (the KB always works). The KB is APPROVED public policy text, so embedding it is outside the student-data egress gate.

## Frontend conventions

- Standalone components + Angular **signals**; `fetch(\`${environment.apiBase}/...\`, { credentials: 'include' })` for API calls (see `apps/web/src/app/features/student/jobs/jobs.component.ts` for the house pattern).
- The "REEP v2" design system is **global CSS classes** in `apps/web/src/styles/reep-v2.scss` (`.card`, `.dt-table`, `.chip good/warn/risk/neutral`, `.dense-*`, `.ledger-*`, …) — reuse them; don't redefine globals in a component. Status is always shown as **text + colour together**, never colour alone.
- The design references are `docs/design-v2/*.html`.

### The v2 look, and the token shim under it (2026-08)

The visual language is the **Y2K-chrome / glass** handoff: a lilac-to-pink page
wash, white translucent cards on 1px lavender hairlines, **Orbitron** for
headings/labels and **Chakra Petch** for body, with a purple->magenta gradient
reserved for primary actions and the active nav pill. It is **one committed
theme**, not a light/dark pair — every colour is painted explicitly and there is
no `prefers-color-scheme` block.

`reep-v2.scss` defines the handoff's tokens under honest names
(`--brand-purple`, `--ink`, `--surface`, `--hairline`, ...) and **every consumer
reads those**. The warm-paper aliases that stood there while the two designs
coexisted are gone — 286 references across 26 files were renamed — so a colour is
defined once and called one thing. The MUI-era `--reep-*` names survive for the
login, register and resume-builder surfaces, which sit outside the shell and
never adopted the component classes, but they are **defined in `reep-theme.scss`
with the v2 values** rather than overridden from elsewhere. One token, one place.
`reep-theme.scss`'s dark block is deleted: this is a single committed theme,
nothing calls `ThemeService.toggle()`, and a palette nobody can reach is a second
set of colours to keep correct for no one.

**Two global stylesheets, and they must not claim each other's names.**
`reep-v2-resume.scss` loads after `reep-v2.scss`, so it wins on every property it
sets and *leaks every property it does not*. Adding `display: flex` to
`.step-group`, `.completeness` or `.entry` in `reep-v2.scss` silently reflowed
the resume builder, because that file owns those names for a heading, a card and
a card. Before adding a class to `reep-v2.scss`, check it is not already defined
in `reep-v2-resume.scss`.

**`.icon` is clamped to a 1em box and hidden until the font reports itself
loaded, and both halves matter.** Material Symbols renders from LIGATURES, so
`<span class="icon">leaderboard</span>` is the literal word until the font
arrives. Without the clamp a sidebar item reserves ~90px for its icon and the
label is pushed out of the 220px nav; without the `fonts-ready` gate (set in
`main.ts` from the resolved `FontFace.status`, **not** from
`document.fonts.check()`, which answers yes for a fallback) the stray words show.
**The fonts are self-hosted**, in `apps/web/public/fonts/`, generated by
`tools/fonts/fetch-fonts.sh`. The icon face is SUBSET to the glyphs the app can
actually render (`tools/fonts/icon-names.txt`, regenerated by
`collect-icon-names.py`) — the full Material Symbols face is 5.2 MB against
144 kB subset — which makes adding an icon a two-command step rather than an
optimisation: a glyph missing from the subset renders as nothing at all.

The floating **agent orb** and its voice overlay live in the SHELL
(`layout/agent-orb.component.ts`), not in a route, because they are on every
screen. Drag and tap are one gesture separated by a 4px threshold; the pointer
listeners go on `document` (a pointer leaving the 58px box mid-drag stops
delivering events to it) and are removed on pointerup **and** in `ngOnDestroy`.
