# Environment contract, per image

REEP deploys as **three different images with three different environments**.
They are not interchangeable, and most production incidents in this stack come
from giving a variable to one and not the other.

| Image | Built from | Runs | Reaches |
|---|---|---|---|
| API | `apps/api-py/Dockerfile` (Python 3.14) | `uvicorn app.main:app` on :3300 | Postgres, LLM providers |
| Voice worker | `apps/api-py/Dockerfile.voice` (Python 3.12) | `voice_agent.py start` | LiveKit, Groq, the API over HTTP |
| Web | `apps/web/Dockerfile` (node build → nginx) | nginx on :80 — the **only published port** in the stack | the API over the compose network |

The API image also runs as two sidecars in `docker-compose.prod.yml`: `migrate`
(one-shot `alembic upgrade head`) and `retention` (`python -m app.retention_job`, daily —
see "Backups and retention" below). Both read the same variables the `api`
service does.

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
| `WEB_CONCURRENCY` | One uvicorn worker. The Dockerfile CMD deliberately omits `--workers`, and uvicorn (0.52.3, pinned) reads `$WEB_CONCURRENCY` as that flag's default — so the same image is single-worker on a laptop and a fleet in production with no rebuild. **Every per-worker limit in `config.py` multiplies by this number.** The prod compose sets 4. |
| `INTERVIEW_MAX_SESSIONS` | 100 — and it is **per worker**, so fleet interview capacity = `WEB_CONCURRENCY × INTERVIEW_MAX_SESSIONS`. The prod compose pairs 4 workers with `50` for the 200-interview target; leaving the default there would quietly advertise 400, twice the upstream audio-token budget. |
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` / `DB_POOL_TIMEOUT_S` | Per-worker SQLAlchemy pool. The budget that matters: `workers × (pool + overflow)` must stay under Postgres `max_connections` with headroom for the sidecars, migrations and a human's psql — prod is 4 × (10 + 10) = 80 against `max_connections=200`. |
| `OPENAI_API_KEY` | `GET /api/interview/status` reports unavailable and the interview socket closes 4001. The mock interviewer, and only it, is off. |
| `UPLOAD_DIR` | The image sets `/var/reep/uploads`. **Mount a volume there.** Unmounted, uploads land in the container layer and every redeploy destroys student files. |
| `INTERVIEW_AUDIO_DIR` | The audio store resolves to a **sibling of `UPLOAD_DIR`** (`/var/reep/interview-audio` in the image) — a path no volume covers by default, so recordings would die with the container. The prod compose sets it explicitly and mounts `reep_interview_audio` there, plus a one-shot `interview-audio-init` chown (a named volume's mountpoint is created root-owned; the API runs as uid 10001). Capture itself still requires `INTERVIEW_RECORDING_ENABLED=true` **and** the student's `scope_store_audio` grant. |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | `/api/voice/*` returns 503. The rest of the app is unaffected. |
| `GROQ_API_KEY` | `voice_model_key_present` is false, so voice reports not-configured. Also serves as an LLM provider for the assistant. |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | Explicit provider. Unset ⇒ auto-select the first per-provider key present (Sakana → Groq → Mistral → OpenRouter → Gemini → Cohere). |
| `LLM_ALLOW_REMOTE_STUDENT_DATA` | Unset ⇒ **student PII never leaves the process** for a non-loopback model. Only the exact string `true` opens the gate. See rule 1 in `AGENTS.md`; setting it means a student's name, USN, marks and attendance go to that provider. |
| `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_API_KEY` | KB retrieval falls back to Postgres full-text. Degrades answer quality; nothing breaks. The KB is public policy text, so it carries no PII to the embedder. |
| `VOICE_MAINTENANCE_MESSAGE` | Non-empty forces voice unavailable and surfaces the text — the incident switch. |
| `PGSSLMODE`, `PGSSLROOTCERT` | Read by libpq directly. Set `require` (or stricter) for a managed database on an untrusted network. |
| `LOCAL_AUTH_ENABLED` | `false`: the email & password door stays shut — `POST /api/auth/login` answers 403 outside dev/CI, the two `/api/auth/password/*` endpoints answer 503 with the reason, and the login screen renders the form disabled with that reason. `true` opens it **only together with a ready transport below**; the flag alone opens nothing. Never a boot failure. `docs/email-password-sign-in.md`. |
| `EMAIL_TRANSPORT` | Blank = no outbound email — except on a dev `ENV`, where blank means `log`. `ses` (AWS SESv2, signed by the task role — no key, no secret), `smtp` (any relay), or `log` (the message goes into the API log and is NOT sent; **refused as ready on every non-dev `ENV`**, because a sign-in code in a log is a sign-in code). An unknown value is kept so `password_reason` can name it. |
| `EMAIL_FROM` | Required by `ses` and `smtp`: `REEP <no-reply@bgscet.ac.in>` or a bare address. On AWS it must be the address the IAM grant is conditioned on (`mail_from_address`). |
| `EMAIL_REPLY_TO` | Blank = no Reply-To. Set it to the placement office so a student who answers the code email reaches a person. |
| `SES_REGION` | Blank ⇒ `AWS_REGION` / `AWS_DEFAULT_REGION` (boto3's chain). Terraform sets it explicitly. |
| `SES_CONFIGURATION_SET` | Blank = no configuration set on the send (no bounce/complaint events). Terraform passes the stack's. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_STARTTLS` | `smtp` only. Port defaults to `587` and STARTTLS to `true`; port `465` uses implicit TLS. `SMTP_USERNAME` set with `SMTP_STARTTLS=false` on a port other than 465 is **refused as ready** — credentials would cross the wire in the clear. A local Mailpit/MailHog (`localhost:1025`, no username, `SMTP_STARTTLS=false`) is fine. |

---

## Web image

nginx serving the compiled Angular SPA, and the stack's **single front door**:
it proxies everything under `/api` (including the `/api/interview` WebSocket
upgrade) to the api service. This is not a convenience — the session is an
httpOnly `SameSite=Lax` cookie, so the SPA and the API **must be one origin**,
and in production this image is that origin. It takes no environment variables;
its behaviour lives in `apps/web/nginx.conf`.

**TLS terminates here.** `ENV=prod` marks the cookie `Secure`, and a `Secure`
cookie is silently dropped over plain HTTP. The 443 server block in
`nginx.conf` and the 443 port + certificate mount on the `web` service are
committed as comments; enable the three together.

---

## Voice worker image

**Behind the `voice` compose profile.** The worker is the LiveKit rollback
path with no UI caller (AGENTS.md), so `docker compose -f
docker-compose.prod.yml up -d` no longer starts it — that reclaims its 1–3 GB.
On rollback, start it explicitly:

    docker compose -f docker-compose.prod.yml --profile voice up -d

One consequence of the profile: compose interpolates variables **before**
applying profiles, so the worker's secrets can no longer be `${VAR:?}`
hard-fails without breaking the default stack. A missing value now surfaces as
`worker_healthy: false` in `GET /api/voice/status` instead of a compose
refusal — which is why the list below still says *required*.

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

## Backups and retention

Two sidecars in `docker-compose.prod.yml` keep the data honest. Before them
there were **no backups of any kind**, and the 180-day retention promise
stamped on every interview row executed never.

- **`db-backup`** — nightly `pg_dump -Fc` of `reep_py` into the `reep_backups`
  volume, 14-day rotation, and the **first dump runs at container start** so a
  fresh deploy proves the path before anyone trusts it. One `db-backup OK:` /
  `db-backup FAILED:` line per attempt, shaped to survive a log aggregator.
  The volume lives on the **same host as the database**, so it answers "we
  dropped a table", not "the machine died": replicate it off-box
  (rsync/rclone/object storage) as the immediate next step, and **rehearse a
  restore** before one is needed —

      pg_restore -d reep_py <file>

  A backup that has never been restored is a hope, not a backup.

- **`retention`** — the API image running `python -m app.retention_job` once a day
  (first run at start): `retention.purge_expired` walks conversations and
  interview records through soft-delete, PII-scrub and hard-delete on their
  90/180-day clocks, and `retention.redact_expired_runs` strips aged `AgentRun`
  free text while keeping the metrics. The trigger lives in the compose file on
  purpose — `app/retention.py` refuses to run these from API boot, because that
  would make the amount of data destroyed a function of how often someone
  restarts the API. The sidecar mounts the interview-audio volume because
  expiring recordings are deleted **through the filesystem**: unmounted, every
  missing file reads as "already deleted" while the bytes survive on the api's
  volume.

---

## Startup order

1. `db` — healthy (`pg_isready` against **`reep_py`**, not `reep_dev`).
2. `migrate` — one-shot `alembic upgrade head`, must exit 0.
3. `interview-audio-init` — one-shot `chown` of the interview-audio volume
   (docker creates a fresh named volume's mountpoint root-owned; the API runs
   as uid 10001 and could otherwise never write a recording).
4. `api` — after migrations and the chown complete.
5. `web` — nginx, after the API starts. The only published port.
6. `db-backup`, `retention` — after `db` (and `migrate`, for retention); each
   runs immediately, then daily.
7. `voice-worker` — only with `--profile voice`, after the API is up.

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
| voice-worker | 960s | On SIGTERM the SDK stops accepting new jobs and waits for in-flight ones; the drain must outlast the longest live call or a student is cut off mid-sentence. Derived in the compose file: `drain_timeout=900` + two rounds of `shutdown_process_timeout` (20s each) + slack. |

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

`SMTP_PASSWORD` is a secret and belongs with the others (an app password on a
Workspace relay account sends mail as that account). The SES transport has **no
secret at all** — the task role signs the request — which is why nothing about
email is added to the operator-owned secret on AWS.
