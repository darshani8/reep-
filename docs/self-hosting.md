# Self-hosting REEP, with the AI left in the cloud

The decision this document records: **every server-shaped part of REEP moves
onto one machine the college owns, and exactly two things stay in the cloud —
the mock interviewer and the assistant's language model.**

It is not a compromise. It is what the bill says to do.

## The arithmetic

From `docs/cost-review-2026-09.md`, measured on the live account rather than a
pricing calculator, after the OpenSearch collection was removed:

| Line | $/month | Moves to the box? |
|---|---:|---|
| NAT Gateway (hours + data) | 43.6 | yes — there is no VPC to leave |
| Fargate vCPU + memory | 38.0 | yes — the `api` service |
| ALB | 17.5 | yes — nginx, and it is idle hours, not traffic |
| RDS `db.t4g.micro`, Multi-AZ | 15.4 | yes — the `db` service |
| Public IPv4 × 3 | 11.0 | yes |
| WAF (web ACL + rules) | 8.1 | yes, in the sense that it goes |
| Backup recovery points + Singapore copy | 7.6 | **no — see "What you give up"** |
| CloudWatch alarms (16) | 5.3 | yes, in the sense that they go |
| RDS storage + backups | 3.4 | yes |
| Secrets Manager | 0.8 | yes — `.env` on the box |
| **Bedrock Nova Sonic** | **1.1** | **STAYS** |
| S3, ECR, EFS, CloudFront, DynamoDB, **SES** | ~0.8 | SES stays; the rest goes |

**$152 of the $153 is infrastructure. $1.10 is the AI.** That is the whole
argument: hosting the infrastructure yourself is the entire saving, and moving
the AI as well would save about a pound a month and cost the product its
interviewer. Note also that the account was running on promotional credits
absorbing ~75% of the bill — the numbers above are gross, which is what you
actually start paying when the credits expire, and is the number this move
removes.

## What stays in the cloud, and why each one cannot move

**The mock interviewer — Amazon Nova 2 Sonic on Bedrock.** It is a
speech-to-speech model reached over a bidirectional HTTP/2 stream. There is no
self-hosted equivalent of it in this repository: `INTERVIEW_ENGINE=local`
(`app/interview_local.py`) exists and shares the engine contract, but it is a
different product — it needs numpy, a local model and a machine with the
headroom to run one while serving the dashboard. Rule 1 is unaffected either
way: the interview session carries no student record, and the module imports no
ORM model.

**The assistant's model.** Any OpenAI-compatible provider through
`app/ai/llm.py`; several have a free tier that covers a college's volume. If the
college later wants this on the box too, a loopback model (Ollama at
`http://host.docker.internal:11434/v1`) is the one case where rule 1 lets
student data reach the model without `LLM_ALLOW_REMOTE_STUDENT_DATA=true` —
`student_data_egress_allowed` always permits loopback.

**SES, for mail.** Not because it is cheap, though it is cents at this volume,
but because it needs *no second credential*: it authenticates with the same AWS
chain Bedrock already uses. Blank `SES_FROM_ADDRESS` is **not "mail off"** — it
is the console transport, which logs every message into a bounded in-memory
outbox and sends nothing. On a deployment that means the onboarding setup link,
the six-digit codes, a rejected applicant's reason and the delete-for-good
second factor all silently go nowhere, and each one reaches the office as "the
student says the form is broken". The college's own SMTP relay instead is one
function — `app/mail_transport.py`'s `send()`, which says so in its own first
paragraph — and is the right change to make if the college wants no AWS
dependency for mail. Until somebody writes it, SES is the transport that exists.

**Optionally S3, for the document archive.** The cheapest line in this whole
migration and the hardest to add after the fact — see below.

## What you give up, stated plainly

A self-hosted box is one machine. The AWS deployment was not, and these are the
promises that do not come with the compose file:

* **Backups become one volume on the same host as the database.** The
  `db-backup` sidecar writes `pg_dump -Fc` nightly, keeps 14 days, and logs one
  OK/FAILED line per attempt. That answers *"we dropped a table"*. It does not
  answer *"the machine died"*, because the dump is on the machine. **Getting
  `reep_backups` off the box is the operator's job and nothing in this
  repository does it for you** — rsync, rclone, a USB disk rotated weekly, or
  the college's existing backup system. A backup that has never been restored is
  a hope, not a backup: rehearse `pg_restore` before you need it.
* **Uploaded files lose every copy but one.** The AWS deployment had EFS behind
  a daily AWS Backup plan. Here, `reep_uploads` is it. This is what
  `DOCUMENT_ARCHIVE_BUCKET` is for, and at a college's volume S3 storage for
  every marksheet, certificate, resume, signature and recording is cents a
  month. It is the one piece of AWS worth keeping that nobody asks for, because
  nothing on any screen reports its absence.
* **No Multi-AZ, no auto-scaling, no ALB health-based replacement.** If the box
  is down, REEP is down, and a person has to notice. `SENTRY_DSN` /
  `SENTRY_JOBS_DSN` are free at this volume and are the only thing that will
  tell you the nightly dump has been failing for three weeks.
* **No WAF.** The edge rule set (and the `SizeRestrictions_BODY` story in
  `AGENTS.md`) is gone with CloudFront. The API still bounds every body itself
  (`document_store.MAX_BYTES`, the per-handler `read(MAX + 1)`), and the
  brute-force limiter is keyed on the account rather than the source address —
  but *spraying* (one guess each against a thousand accounts) was always the
  edge's job, and now nothing does it. If the deployment is reachable from the
  public internet rather than the college network, put something in front of it.
* **The browser half of Sentry is off.** `apps/web/src/environments/environment.ts`
  ships `sentryDsn: ''`, and the only thing that ever rewrote it was
  `deploy.yml`'s "Point the SPA at Sentry" step — which is the AWS pipeline. A
  self-hosted build has API telemetry and no browser telemetry unless somebody
  adds that step to the web image's build.
* **The GitHub ops-task menu is gone**, and with it the typed-sentence
  confirmations it wrapped around the destructors. The modules are unchanged and
  keep their own guards (dry run by default, `--apply` plus
  `--i-understand-this-is-permanent`). See *Operating it* below for the local
  spelling.

None of these is a reason not to do this. Every one of them is a reason to
decide it on purpose rather than discover it in six months.

## The machine

Small. The whole point is that this fits on hardware a department already has.

* 4 CPU cores, 8 GB RAM is comfortable for a college's cohort; the compose file
  reserves 2 CPU / 2 GB for the api and 2 CPU / 2 GB for Postgres. On 4 cores
  set `WEB_CONCURRENCY=2` — four uvicorn workers are four full CPython processes
  with the AI clients resident.
* Disk: the database is small (marks, attendance, transcripts). The space goes
  to uploads and, if recording is ever switched on, interview audio — two WAV
  files per interview.
* Docker Engine with the Compose plugin. Nothing else: the images build from
  this repository.
* **A hostname and a TLS certificate.** `ENV=prod` marks the session cookie
  `Secure`, and a browser silently drops a `Secure` cookie over plain HTTP —
  serving this without TLS breaks authentication in a way that looks like a
  backend bug.

## Bring-up

```bash
git clone <this repository> reep && cd reep
cp .env.selfhost.example .env
$EDITOR .env          # every CHANGE_ME, then sections 2-6
docker compose -f docker-compose.prod.yml up -d --build
```

`.env.selfhost.example` is the contract and carries the reasoning per variable.
Four values have no default and the stack refuses to start without them:
`POSTGRES_USER`, `POSTGRES_PASSWORD`, `DATABASE_URL`, `AUTH_SECRET`,
`WEB_ORIGIN`. On `ENV=prod` the API additionally **refuses to boot** on an
`AUTH_SECRET` that is blank, the value published in this repository, an obvious
placeholder, or shorter than 32 characters — that is `Settings.production_boot_failures()`
doing its job, not a broken deploy, and the log names every problem it found.

What comes up, in order: `db` (healthy) → `migrate` (alembic to head, once, as
its own unit so four api workers never race the version table) →
`interview-audio-init` (a one-shot chown) → `api`, `retention`, `archive`,
`db-backup` → `web` (the only service with a published port).

### TLS

Terminate at the `web` service or in front of it, and pick one:

* **In front** — the college's existing reverse proxy or a Caddy/Traefik
  container. Leave `web` on `80:80` bound to loopback and proxy to it. Make sure
  it forwards the WebSocket upgrade: `/api/interview` is one socket held open for
  the length of an interview.
* **At `web`** — uncomment, together, the `443:443` mapping in
  `docker-compose.prod.yml`, the `./certs` mount beside it, and the 443 server
  block at the bottom of `apps/web/nginx.conf`. They are commented as a set and
  half of them enabled is an nginx that starts and serves nothing on 443.

`WEB_ORIGIN` and `GOOGLE_REDIRECT_URI` must both name the final `https://`
origin. The SPA and the API are **one origin** by design — the session cookie is
httpOnly `SameSite=Lax`, so a cross-origin API call would simply never carry it,
and every login would "succeed" and then behave as signed-out.

### First accounts and catalogues

None of this is automatic, and `python -m app.seed` deliberately **refuses on
`ENV=prod`** — it creates the demo logins whose passwords are published in
`AGENTS.md`, and there is no override flag.

```bash
C="docker compose -f docker-compose.prod.yml run --rm api python -m"

# The grounded assistant's Knowledge Base. Production-safe, idempotent, no
# accounts. Without it the assistant has nothing to ground against.
$C app.seed_kb

# The institutional spine as code: college, departments, courses,
# specializations, one batch per leaf. DRY RUN BY DEFAULT — read what it says
# about each leaf's interview track before you pass --apply.
$C app.seed_catalogue --college 1MP
$C app.seed_catalogue --college 1MP --apply

# The first Main Admin. The address is POSITIONAL. --department-id is REQUIRED
# to create an account: one filed under no department resolves to no college
# and no batch, so its students get no interview track, meet "General
# interview" — which has no wrap-up phase — and can never be scored.
$C app.grant_access principal@your-college.ac.in \
     --name "A Name" --role ADMIN --department-id <id>

# Students, from the USN roster: production-safe, idempotent, no passwords, and
# under Google-only sign-in it IS the allowlist. --dry-run first, always; the
# domain comes from ROSTER_EMAIL_DOMAIN unless --domain overrides it, and
# --rekey-domain is the recovery path for the day that guess turns out wrong.
$C app.seed_roster --cohort <cohorts.code> --dry-run
$C app.seed_roster --cohort <cohorts.code>
```

Everything else — colleges, departments, courses, batches — is the
**Set up a college** screen at `/admin/setup`, which is additive, re-runnable,
and sends exactly the POSTs it would take to type them one at a time.

### Verify before you hand it over

```bash
curl -fsS https://reep.your-college.ac.in/health          # liveness, no dependencies
curl -fsS https://reep.your-college.ac.in/ready           # readiness, hard dependencies
curl -fsS https://reep.your-college.ac.in/api/interview/status   # the mock interviewer
curl -fsS https://reep.your-college.ac.in/api/auth/sso/status    # the Google door
docker compose -f docker-compose.prod.yml logs db-backup | tail -3   # "db-backup OK: ..."
```

`/health` and `/ready` answer through nginx because this deployment added two
exact-match proxy blocks for them; they are unprefixed on the api (the whole
client surface is `/api`), so before that they fell through to the SPA fallback
and returned 200 with `index.html` — an uptime monitor would have read that as
a healthy API forever. If you put a load balancer in front of `web`, point it
at `/ready` and never at `/health`.

`/api/interview/status` reporting unavailable means the Bedrock region or the
credentials did not resolve; it is the *only* thing that breaks, so check it
explicitly rather than assuming a green dashboard covers it. Then sign in, open
`/student/assistant`, and run one interview end to end — the failure mode this
stack has that no health check sees is a call that sounds fine in the room and
saves nothing:

```sql
select channel, count(*), max(created_at) from messages group by channel;
```

No `interview` rows, or a stale `max(created_at)`, means turns are being
dropped; the cause is logged as `Dropped interview turn`.

## Moving the existing deployment's data

Do this **before** deleting anything in AWS, and in this order — the order is
the point.

1. **Take a logical dump of RDS.** `pg_dump -Fc` from a host that can reach the
   instance. It must be PostgreSQL 17's client: `pg_dump` refuses a server newer
   than itself. `python -m app.backup_database` does exactly this on the AWS
   side if you would rather use the path that is already tested.
2. **Restore into the box**, with the stack up and `migrate` already run:
   ```bash
   docker compose -f docker-compose.prod.yml cp reep.dump db:/tmp/reep.dump
   docker compose -f docker-compose.prod.yml exec db \
     pg_restore -U reep -d reep_py --clean --if-exists /tmp/reep.dump
   ```
3. **Copy the files.** Everything under EFS's uploads root into the
   `reep_uploads` volume, and the interview audio into `reep_interview_audio`,
   preserving the stored names — **the row is the only thing that knows whose
   file a `uuid4().hex` is**, so files and rows must arrive together. `chown` to
   uid 10001 afterwards; the api runs as that and a root-owned tree is an upload
   store it cannot write to.
4. **Check the counts match** before the old deployment is touched: users,
   students, interview_sessions, and the row count of each of the six document
   tables against the file count on disk.
5. **Keep one final dump off the box, permanently.** Whatever `AGENTS.md` says
   about `app.export_identity` applies here too: after the RDS instance is gone
   there is no second copy anywhere.

## Decommissioning AWS, in order

Nothing here is reversible, and the order exists so that no step depends on
something the previous step deleted.

1. Students are signing in to the new box, one interview has run, and step 4
   above checked out.
2. **Keep** the final dump and the file copy, off the box.
3. **Create the IAM user the box will use** and confirm the interview works with
   *its* credentials — not with an administrator's — before you remove anything.
   `bedrock:InvokeModelWithBidirectionalStream`, plus `ses:SendEmail` if mail is
   on and `s3:PutObject` + `s3:ListBucket` if the document archive is on. Never
   `s3:GetObject` on a backup or archive bucket: that is read access to every
   document the college holds, as original bytes rather than a dump needing
   restoration.
4. Delete the CloudFormation stacks. `cdk destroy`, or the console — but
   **every resource in all three stacks is `Retain`**, deliberately, so the
   database, the buckets and the file system SURVIVE the stack deletion and must
   then be deleted by hand. That is a feature on the day somebody destroys the
   wrong stack and a surprise on the bill if nobody finishes the job: check RDS,
   S3, EFS and the Elastic IPs afterwards and delete what is genuinely finished
   with.
5. Delete the NAT gateways and release the Elastic IPs — these are the largest
   line on the table and they bill by the hour whether anything flows or not.
6. Leave the Route 53 zone until DNS points at the new box and has propagated.
7. **Keep**: Bedrock model access, the SES identity and its DKIM records, the
   IAM user from step 3, and the document-archive bucket if you enabled it.
   That is the entire remaining footprint, and it is a couple of dollars a
   month.

Take the AWS Backup vault's retention seriously in step 4: the vault lock is
governance-mode and the monthly archive rule was written to keep the first
successful dump of each month for years. If the college's records policy relies
on that, it is a policy decision to delete it, not a cleanup task.

## Operating it

The ops-task workflow and its typed-sentence confirmations were a GitHub
Actions door onto ECS. Locally the modules are the same and the guards are their
own:

```bash
C="docker compose -f docker-compose.prod.yml run --rm api python -m"

$C app.set_password admin@your-college.ac.in   # prompts; never a --password flag
$C app.grant_access --help
$C app.purge_students                          # DRY RUN by default
$C app.purge_students --apply --i-understand-this-is-permanent
$C app.purge_people                            # the whole deployment's people
$C app.purge_colleges --keep 1MP
```

Read what a dry run prints. `purge_people` refuses unless there is exactly one
admin, and both purges abort on a table nobody has classified — those refusals
are the design and are not to be worked around.

**Upgrades** are `git pull && docker compose -f docker-compose.prod.yml up -d --build`.
`migrate` runs alembic to head as its own unit before the api starts. Take a
dump first; the sidecar's last one may be up to a day old.

**Logs.** `docker compose -f docker-compose.prod.yml logs -f api`. The root
logger is configured in `app/main.py`'s lifespan, so `log.info` lines actually
appear — they were discarded entirely until 2026-09-10, in development and in
production both.

## What this deployment does not change

Everything in `AGENTS.md` still applies, unchanged: rule 1 (student data must
not leave the machine unbidden) is if anything easier to keep here, rule 2's
staff scope is untouched, the single-device session, the consent rows the
interview enforces, the retention sweep, and both destructors. The only thing
that moved is where the processes run.
