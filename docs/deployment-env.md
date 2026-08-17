# Environment contract, per image

REEP deploys as **two different images with two different environments**. They
are not interchangeable, and most production incidents in this stack come from
giving a variable to one and not the other.

| Image | Built from | Runs | Reaches |
|---|---|---|---|
| API | `apps/api-py/Dockerfile` (Python 3.14) | `uvicorn app.main:app` on :3300 | Postgres, LLM providers |
| Voice worker | `apps/api-py/Dockerfile.voice` (Python 3.12) | `voice_agent.py start` | LiveKit, Groq, the API over HTTP |

The worker has **no database access and no inbound HTTP port**. It talks to the
API with stdlib `urllib`. Anything it needs from the database, it asks the API
for.

`app/config.py` maps field names to env vars case-insensitively, so
`database_url` reads `DATABASE_URL`. Every field has a default, which is the
hazard this document exists to address: a missing variable does not crash, it
silently selects a development default.

---

## API image

### Required in production

| Variable | Why it cannot be defaulted |
|---|---|
| `DATABASE_URL` | Default points at `localhost:5433` — a container's own loopback, where nothing is listening. |
| `AUTH_SECRET` | Default is a literal string in `config.py`. Sessions are HS256 JWTs signed with it, so shipping the default lets **anyone who has read this repo mint a valid session cookie for any user, including a DIRECTOR**. Use ≥32 random bytes. |
| `WEB_ORIGIN` | CORS + cookie scope. Wrong value ⇒ the browser drops the session cookie and every login appears to work and then behaves as logged-out. |
| `ENV=prod` | Marks the cookie `Secure`, fails `require_voice_worker` closed, and makes `python -m app.seed` refuse. Leaving it `dev` disables all three at once. |
| `VOICE_WORKER_SECRET` | Must be identical in both images. See the shared-secret note below. |

**`ENV=prod` requires TLS in front of the API.** A `Secure` cookie is not sent
over plain HTTP, so serving prod without HTTPS breaks authentication in a way
that looks like a backend bug.

### Optional

| Variable | Default behaviour when unset |
|---|---|
| `UPLOAD_DIR` | The image sets `/var/reep/uploads`. **Mount a volume there.** Unmounted, uploads land in the container layer and every redeploy destroys student files. |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | `/api/voice/*` returns 503. The rest of the app is unaffected. |
| `GROQ_API_KEY` | `voice_model_key_present` is false, so voice reports not-configured. Also serves as an LLM provider for the assistant. |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | Explicit provider. Unset ⇒ auto-select the first per-provider key present (Sakana → Groq → Mistral → OpenRouter → Gemini → Cohere). |
| `LLM_ALLOW_REMOTE_STUDENT_DATA` | Unset ⇒ **student PII never leaves the process** for a non-loopback model. Only the exact string `true` opens the gate. See rule 1 in `AGENTS.md`; setting it means a student's name, USN, marks and attendance go to that provider. |
| `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_API_KEY` | KB retrieval falls back to Postgres full-text. Degrades answer quality; nothing breaks. The KB is public policy text, so it carries no PII to the embedder. |
| `VOICE_MAINTENANCE_MESSAGE` | Non-empty forces voice unavailable and surfaces the text — the incident switch. |
| `PGSSLMODE`, `PGSSLROOTCERT` | Read by libpq directly. Set `require` (or stricter) for a managed database on an untrusted network. |

---

## Voice worker image

### Required — all of them

`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `GROQ_API_KEY`,
`VOICE_WORKER_SECRET`.

The worker is useless without any one of these, so unlike the API there is no
graceful-degradation column here.

| Variable | Note |
|---|---|
| `REEP_API_URL` | **Must be `http://api:3300`, not localhost.** Its default is a localhost URL that was correct when the worker ran beside the API on a laptop and is wrong in every container deployment — the worker's own loopback has nothing listening, so heartbeats and transcripts silently fail while the worker looks healthy. |
| `VOICE_TTS` | `edge-tts` (default) is an **unofficial, no-SLA endpoint with no privacy terms or quota guarantee**. Production should set `groq` or another SLA-backed provider. Note Groq's free TTS tier is 10 req/min and 100/day *org-wide* — shared with the API's LLM calls. |

---

## The shared secret

`VOICE_WORKER_SECRET` must hold the **same value in both images**.

- **Both blank + `ENV=prod`** ⇒ `require_voice_worker` returns 500. Fail-closed
  and deliberate: a blank secret in production would leave the transcript and
  heartbeat endpoints open to anyone who can reach the API.
- **Values disagree** ⇒ the worker's POSTs 401. `/api/voice/status` reports the
  worker offline forever, so tokens are never minted and voice never starts —
  while the worker's own logs show a healthy process connected to LiveKit. This
  is the single most confusing failure mode in the stack; check it first.

---

## Agent dispatch

The worker registers under the agent name **`reep-voice`**, matching
`VOICE_AGENT_NAME` in `app/routers/voice.py`. A *named* agent opts out of
automatic dispatch, so the API attaches an explicit
`RoomConfiguration(agents=[RoomAgentDispatch(agent_name="reep-voice")])` to every
token. Rename it in one place only and the room opens, the student's microphone
publishes, and no agent ever joins.

---

## Startup order

1. `db` — healthy (`pg_isready` against **`reep_py`**, not `reep_dev`).
2. `migrate` — one-shot `alembic upgrade head`, must exit 0.
3. `api` — after migrations complete.
4. `voice-worker` — after the API is up.

**Migrations run once, as their own service.** Running them from the API
entrypoint means every replica races on the Alembic version table on boot, and
the loser can fail in ways that leave the schema half-applied.

Seeding is separate and manual. `python -m app.seed_kb` populates the Knowledge
Base and is safe in production. `python -m app.seed` creates the demo accounts
and **refuses to run when `ENV=prod`** — it would otherwise create
`director@bgscet.ac.in` / `director123`, an account that can read every student's
records, behind a password published in `AGENTS.md`.

---

## Shutdown

| Service | `stop_grace_period` | Why that number |
|---|---|---|
| api | 120s | Above uvicorn's `--timeout-graceful-shutdown 110`, so it drains first. `/api/agent/chat/stream` persists the assistant turn only after the last delta — a hard kill mid-stream loses it. |
| voice-worker | 300s | On SIGTERM the SDK stops accepting new jobs and waits for in-flight ones; the drain must outlast the longest live call or a student is cut off mid-sentence. |

The worker's Dockerfile runs `voice_agent.py start`, **not `dev`**. The SDK only
drains when not in devmode (`cli.py`: `if not devmode:
loop.run_until_complete(server.drain())`), so `dev` in production would kill live
calls on every rolling deploy.

---

## Health endpoints

- `GET /health` — **liveness.** Touches no dependencies. This is what the
  container healthcheck and any restart policy must use.
- `GET /ready` — **readiness.** 503 on hard dependencies only; use it for
  load-balancer membership.

Pointing a restart-triggering healthcheck at `/ready` turns a brief Postgres
wobble into a restart storm across every replica — a recoverable blip becomes an
outage.

---

## Secrets hygiene

Secrets come from the orchestrator's secret store, never from a committed file
and never baked into an image. `docker-compose.prod.yml` declares them as
`${VAR:?message}`, so a missing one fails the deploy loudly instead of starting a
half-configured stack.

`apps/api-py/.env` is gitignored and is for local development only. Anything that
has ever been in a local `.env` and then discussed, pasted, or logged should be
treated as disclosed and rotated at the provider.
