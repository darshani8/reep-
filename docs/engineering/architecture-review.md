# Architecture review — REEP as it stands (2026-10-08)

A standing review of the system against the questions an architecture review
asks. Every answer points at the file or document that is the evidence. Where
the repository does not answer a question, the area ends with **Open questions**
rather than a guess: no number on this page was invented, and a gap written down
is worth more than a plausible figure.

The short shape, from [`AGENTS.md`](../../AGENTS.md) and
[`../architecture.md`](../architecture.md): an **Angular 22 SPA** served from S3
behind CloudFront, talking to **one FastAPI process** (`apps/api-py`) on ECS
Fargate behind an ALB, on **PostgreSQL 17** (RDS, pgvector), with files on EFS,
mail through SES, and the mock interviewer speaking to **Amazon Nova 2 Sonic**
on Bedrock from inside the API process. Infrastructure is AWS CDK
(`infra/cdk/`), and CloudFormation owns `reep-core` since the Terraform cutover
([`../cdk-cutover.md`](../cdk-cutover.md)).

---

## 1. Requirements

**Expected users.** One college deployment (BGSCET) with four roles: STUDENT,
MENTOR (faculty), ALUMNI and exactly one ADMIN, the Main Admin (`AGENTS.md`,
"One Main Admin"). The planning figure in
[`../budget-1000-students-2026-09.md`](../budget-1000-students-2026-09.md) is
**1,000 students taking 7 mock interviews a month each**; the cost review records
a decision taken "before 3,000 students join"
([`../cost-review-2026-09.md`](../cost-review-2026-09.md) §3c).

**Traffic.** The budget document's load model: 7,000 interviews a month, about
318 a working day, **3–4 concurrent on average and bursts of 15–20** in a busy
evening hour (§1, §4). The account's Bedrock quota allowed **2 concurrent Nova 2
Sonic streams** when that was written — the binding constraint, not the API.

**Data size.** Not measured in the repository.

**What must never fail.**
- **Rule 1** — a student's records never reach a remote model unbidden
  (`student_data_egress_allowed`, `app/ai/llm.py`), and the same holds for
  telemetry (`app/telemetry_scrub.py`).
- **Rule 2** — a MENTOR sees only their own group, and a mentor with no group
  sees nobody (`_assert_can_access_student`, `app/routers/mentor.py`).
- **A forged session** — the production boot guard refuses a repo-default
  `AUTH_SECRET` (`Settings.production_boot_failures`, `app/config.py`).
- **Interview transcripts are saved** — the "call sounded fine but saved nothing"
  runbook in `AGENTS.md`; `turns_emitted` vs `turns_persisted`.
- **The consent record stays answerable** — `interview_consents` and the pinned
  `interview_sessions.consent_id`.
- **Backups exist and restore** — see Data.

**Open questions.** Database size and growth rate; the peak number of signed-in
users (results day is the documented worst case, with the WAF's per-IP rate rule
left for the owner to decide, `AGENTS.md`); an availability target. No SLA or SLO
is written anywhere in the repository.

## 2. Boundaries

**Monolith first — yes, and deliberately.** One deployable API process. Even the
realtime interviewer runs in-process (`app/interview_nova.py`): the LiveKit voice
stack that was a fourth process with its own venv was removed in 2026-09, and the
standalone interview prototype was deleted (`AGENTS.md`, "The LiveKit voice stack
was REMOVED"). The scheduled jobs (`app/retention_job.py`, `app/backup_database.py`,
`app/export_identity.py`, `app/archive_documents.py`, `app/leave_today_job.py`)
are the same image run as ECS scheduled tasks, not separate services.

**Where it would split, if it ever had to.**
- **The interviewer** — CPU-bound 24 kHz PCM relay with its own concurrency caps
  and the longest-lived connections (8 minutes); the reason `apiCpu` stays at 512
  (`cost-review-2026-09.md` §4). Its contract is already isolated in
  `app/interview_core.py`, and the voice platform reuses it rather than forking it
  (`docs/voice-platform.md`).
- **The voice platform** (`app/voice_platform/`) — already has its own CDK stack,
  SQS ingest and Lambda.
- **Scheduled destructors and backups** — already separate tasks.

Module ownership inside the monolith is by router and by `app/` module; the
places where one rule must have one owner are named in `AGENTS.md` (for example
`app/mentor_history.py` is the only writer of mentor history,
`document_manifest.save_and_record` the only spelling routers use to store a file).

**Open questions.** No written rule says which module owns a new cross-cutting
concern; today the answer is "an `app/` module, never copied between routers"
([`api-checklist.md`](api-checklist.md)).

## 3. Data

**Right database.** PostgreSQL 17 on RDS, with pgvector for the Knowledge Base's
hybrid retrieval (`app/knowledge.py`). JSON columns are `JSONB` throughout.

**Schema owners.** The models in `apps/api-py/app/models/` are the source of
truth; Alembic migrations in `apps/api-py/migrations/versions/` (one head). The
`new-migration` skill (`.claude/skills/new-migration/`) and the enum gotchas in
`AGENTS.md` are the conventions; migration reversibility is gated
([ADR 0004](../adr/0004-reversible-migrations-to-a-declared-floor.md)).

**Backup and restore.** Physical: RDS automated backups and a daily AWS Backup
rule, both `backupRetentionDays` = 35 (RDS's ceiling), a cross-region copy to
`reep-vault-dr` in ap-southeast-1, a monthly archive plan (`archiveRetentionDays`
365), and a **weekly restore test** (`CfnRestoreTestingPlan`,
`infra/cdk/reep_core/stack.py`). Logical: `pg_dump -Fc` nightly at 01:00 IST
(`app/backup_database.py`) into Object-Locked buckets, verified with
`pg_restore --list` before upload. The identity ledger (`app/export_identity.py`)
and the document archive (`app/document_archive.py`) carry what outlives the
schema. `AGENTS.md` records why each exists.

**Retention.** Interview records 180 days (`interview_retention_days`,
`app/config.py`), swept nightly by `app/retention.py`; the recordings bucket and
the document archive deliberately never expire (`AGENTS.md`); purge tools exist
for people and colleges (`app/purge_people.py`, `app/purge_students.py`,
`app/purge_colleges.py`).

**Open questions.** Whether a *logical* restore (`pg_restore` of the nightly
dump into a fresh database) has been rehearsed end to end — the weekly test
covers the physical recovery points. `AGENTS.md` flags that the consent panel
still tells students recordings are destroyed after `retention_days`, which the
recordings bucket no longer does; that copy needs rewriting.

## 4. Scaling

**Stateless?** Mostly. The API keeps several things **per process** on purpose:
the LLM rate limiter (`app/ratelimit.py`, "N workers relax the ceiling to N x"),
the login limiter, the session-revocation cache, the interview concurrency
limiter, and the leaderboard cache. Files live on EFS, not on the task. A second
task therefore relaxes per-process limits rather than breaking them.

**Capacity.** `apiMinTasks` 2, `apiMaxTasks` 10, 0.5 vCPU / 1 GB ARM64 each
(`infra/cdk/cdk.context.json`, `infra/cdk/cdk.json` `apiArm64`). Database
`db.t4g.micro` live, `db.t4g.small` targeted by harden (`dbInstanceClassTarget`),
with the pool set to 10 + 10 per task so ten tasks cannot exhaust it (`AGENTS.md`,
"the headroom for a results day").

**Cache.** No shared cache (no Redis/ElastiCache). CloudFront caches the SPA's
hashed assets; the service worker deliberately caches **no API response**
(`ngsw-config.json` has no `dataGroups` — rule 1, `AGENTS.md`).

**Queue for slow jobs.** SQS for the voice platform's candidate ingest
(`docs/voice-platform.md`); EventBridge-scheduled ECS tasks for nightly work;
FastAPI `BackgroundTasks` for mail after a commit. There is no general job queue.

**Open questions.** The Bedrock concurrency quota (2 when last checked) against
a 15–20 burst (`budget-1000-students-2026-09.md` §8); whether autoscaling has
been load-tested to `apiMaxTasks` (the `testing/jmeter/` plans exist; results for
that scale are not referenced from here).

## 5. Security

**Auth model.** Google sign-in for every role with the roster as the access
control (nothing self-provisions), plus passwords where an operator has issued a
key; one live session per account (`users.token_version`); HS256 session JWT in
an httpOnly cookie. See [ADR 0005](../adr/0005-one-live-session-per-account.md)
and [ADR 0006](../adr/0006-google-sign-in-roster-is-access-control.md).
Authorisation is role gates plus spine-scoped capabilities (`app/governance.py`),
checked separately from rule 2 on purpose. The route audit
([`quality-gates.md`](quality-gates.md) §3) proves every operation needs a
session or is declared public, and reaches a gate or is declared self-scoped.

**Secrets management.** AWS Secrets Manager into the task definition; nothing
pasted for Bedrock or SES (task role). The boot guard refuses known-bad values;
the **Secrets (gitleaks)** check refuses them in code.

**Least privilege.** Written into the grants and pinned by synth guards: backup
tasks may write and never read their buckets, the ledger task holds
`s3:PutObject` only, `ses:ListSuppressedDestinations` is deliberately not
granted, the GitHub deploy role holds ECR/ECS/S3/CloudFront only (`AGENTS.md`;
`infra/cdk/tests/test_core_synth.py`). No agent holds AWS credentials
([`../agentic-sdlc.md`](../agentic-sdlc.md)).

**PII handling.** Rule 1 ([ADR 0007](../adr/0007-student-data-egress-gate.md)),
Sentry scrubbers, an access log with no body or query string, purge and deletion
walks that refuse an unclassified table.

**Open questions.** The WAF per-IP rate limit for a campus behind one NAT
(left to the owner). No penetration test is referenced beyond the
`testing/` security suites.

## 6. Reliability

**Timeouts.** Database pool wait 5 s (`db_pool_timeout_s`); LLM calls
`llm_timeout_ms`; SSM reads 2 s connect / 5 s read
(`app/voice_platform/ssm_config.py`); Bedrock closes a Nova stream at 8 minutes
and the engine caps the session to fit (`NOVA_SONIC_CONNECTION_SECONDS`);
CloudFront's 60 s origin timeout is why blocking work must never sit in an
`async def` handler.

**Retries.** botocore's defaults on AWS calls; client-side retry made safe for
registration by the submission key; mail is keyed so a rerun sends nothing twice
and retries nothing (`mailer.deliver_once`).

**Circuit breakers.** The ECS deployment circuit breaker (and per-colour
`ROLLBACK_ON_ALARM` deployment alarms when `blueGreen` is on, which it is not by
default). No application-level circuit breaker; the SES suppression check and
several optional AWS projections **fail open** by documented choice.

**Health checks.** `/health` (liveness, dependency-free) and `/ready` (per
dependency, 503 on a hard one) in `app/routers/health.py`; an external Route 53
TCP check through the public name (`infra/cdk/reep_core/edge.py`).

**Graceful shutdown.** Fargate's `stopTimeout` cap of 120 s plus a 600 s target
group deregistration delay so an 8-minute interview survives a deploy, pinned
against `nova_sonic_connection_seconds` by `tests/test_codebase_guards.py`. Three
layers close an interview record that a dying process left running.

**Open questions.** No written timeout for a whole request; no bulkhead between
the interviewer and ordinary requests inside one task beyond the concurrency
caps.

## 7. Observability

**Logs.** CloudWatch, one `reep.access` line per request carrying `rid=` (the
`X-Request-ID`, `app/traceability.py`); `logging.basicConfig` configured in the
lifespan since 2026-09-10. Only the access line carries the request id
([`api-checklist.md`](api-checklist.md)).

**Metrics and alarms.** Metric filters for dropped interview turns and failed
mail; alarms on ALB 5xx, no healthy API task, RDS storage and CPU, API CPU at
max, four backup alarms including "no job completed", and the public
site-unreachable alarm (`infra/cdk/reep_core/stack.py`, `edge.py`), all to the
`reep-alerts` SNS topic.

**Traces and errors.** Sentry, one project per process (`reep-api`,
`reep-scheduled-jobs`, `reep-interview-worker`), scrubbed for rule 1
([`../sentry-playbook.md`](../sentry-playbook.md)).

**On-call runbook.** The "call sounded fine but saved nothing" runbook in
`AGENTS.md`; [`../deployment-process.md`](../deployment-process.md) §8
(post-deploy verification) and §9 (rollback); the `ops-triage` skill and
`agent-ops.yml` / `agent-triage.yml` route drift, failed deploys and `incident`
issues to an agent that diagnoses and never deploys.

**Open questions.** Who is paged, and when — the SNS email subscription must be
confirmed from the inbox before it delivers anything (`AGENTS.md`), and no
rotation or escalation policy is written down.

## 8. Deployment

**CI/CD.** `ci.yml` (five jobs, the required checks), `deploy.yml` (`main` only,
OIDC role pinned to `refs/heads/main`), `cdk-deploy.yml` (named stack options,
`core-9a`/`core-9b` split), `infra-drift.yml` daily (`cdk diff` against `main`
AND CloudFormation drift, reported separately), and the agent workflows
([`../agentic-sdlc.md`](../agentic-sdlc.md)). The release gate
`tools/ci/release_gate.py` decides what an agent may ship without a human.

**Environments.** Production only. `dev` and `stage` are branches, not
environments: "`stage` is a gate branch: no staging environment deploys from it"
([`../branching-strategy.md`](../branching-strategy.md)).

**Zero-downtime deploys.** A rolling ECS update over at least two tasks, with the
600 s drain for live interviews. Blue/green exists behind `blueGreen` and is off.

**Rollback plan.** [`../deployment-process.md`](../deployment-process.md) §9 is
the plan and is honest that it is weak: `deploy.yml` takes no image tag, so code
is rolled back by reverting on `main` and redeploying; a dropped column is not
undone by an old image; restore and PITR create a new endpoint. (That document
predates the CDK cutover in places — it cites `infra/aws/ecs.tf` — but the
mutable `:latest` family it describes is still how `reep-api` is defined.)

**Open questions.** A staging environment; a one-step rollback to a named image.

## 9. Cost

**Monthly estimate.** About **$153/month at list price** after the OpenSearch
removal on 2026-09-15 (`cost-review-2026-09.md`, headline); about $180 for the
platform in the later budget document, before GST.

**Biggest driver.** Today, fixed infrastructure — the NAT gateway was the largest
remaining line (§"Where the rest of the money goes"), with an instance-swap
option built behind flags (§3b). At the planned scale, **Nova 2 Sonic speech** —
$567 of an $879 month for 7,000 interviews (`budget-1000-students-2026-09.md` §1).

**Budget alarms.** The cost review recommends replacing AWS's default net-spend
"My Zero-Spend Budget" with a **gross**-spend budget (`IncludeCredit: false`),
because promotional credits hid a $361/month resource as $0.00 (§2), and
`infra-drift.yml` reports usage-type cost daily.

**Open questions.** Whether the gross budget was created — it is a CLI command in
a document, not code, so the repository cannot say. No budget is defined in CDK.

## 10. Change

**API versioning.** The live surface is `/api`. `app/main.py` also mounts the
auth router and the mentor-notebook redesign router under `/api/v1` ("the legacy
/api surface remains during the expand/contract window") — 23 operations. Note
that [`../api-v1-redesign.md`](../api-v1-redesign.md)'s banner says "there is no
`/api/v1` prefix", which the running app contradicts; the route audit's inventory
lists them.

**Backward compatibility.** The SPA and the API ship from one `main` but in two
deploy halves, and an installed PWA picks up a new SPA only on its next load, so
an API change must keep serving the previous client. Status codes, response
shapes and parameters of existing routes are treated as a contract — the route
audit records deviations rather than "fixing" them for that reason.

**Migration plan.** One concern per revision, no long locks on tables students
read, indexes `CONCURRENTLY` in their own revision, migrations run once as their
own task (`deployment-process.md` §6). Expand/contract for anything a running
client reads.

**Open questions.** No versioning policy says when `/api/v1` replaces `/api` or
when the duplicate auth mounts retire; `alembic check` is still run by hand
(`deployment-process.md` §6).

## 11. People

**ADRs.** [`../adr/`](../adr/README.md), from 2026-10-08. Before that, decisions
were recorded in `AGENTS.md`'s prose and in commit bodies, and the early ADRs
here record decisions already made there, citing the section.

**Coding standards.** `AGENTS.md` (Backend and Frontend conventions), enforced
where a machine can by the gates in [`quality-gates.md`](quality-gates.md) and
the codebase guards; the commit body is the house four beats (Symptom /
Mechanism / Why this and not the obvious alternative / Deliberately not done),
which the PR template asks for too.

**Review rules.** Required checks on `main` and `stage`
(`.github/rulesets/`), the promotion path enforced by
`tools/ci/branch_policy.py`, `claude-review.yml` on every non-draft PR, the PR
template's "Design and approach" section for a human reviewer, and the release
gate's list of paths that always need a human.

`.github/CODEOWNERS` names one owner (`@darshani8`) for everything, with the
security-relevant paths (rule 1 and rule 2 modules, config, auth, models,
migrations, workflows, rulesets) listed explicitly.

**Open questions.** A second reviewer: with one code owner, "who must review"
in the PR template is answered by that person or by nobody, and the template
asks the author to say which.
