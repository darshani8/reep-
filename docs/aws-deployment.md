# Hosting REEP on AWS

The stack `infra/aws/` provisions, and the runbook to stand it up, operate it,
and diagnose it — with **Sentry as the one observability + traceability tool**
and **Amazon Nova (Bedrock)** as the in-account model. `terraform validate`
passes against provider `hashicorp/aws ~> 5.70`; nothing here has been applied
to a live account yet — the first apply is yours, section 3.

## 1. What gets built

```
Internet ── WAF ── CloudFront ──┬── S3 (Angular SPA, private, OAC)
                                └── /api/* ── ALB (HTTPS) ── ECS Fargate api ×2–10
                                                                │        │
                                                     RDS Postgres 17    EFS /data
                                                     (pgvector)          uploads +
                                                                         interview-audio
```

| Ask | How it is delivered |
|---|---|
| Autoscaling | ECS target tracking: CPU 60% / memory 75%, `api_min_tasks`(2) → `api_max_tasks`(10); RDS storage autoscaling 20→100 GB |
| Backups | RDS automated snapshots (point-in-time, 14 d) **and** an independent AWS Backup vault (daily, 35 d) covering the DB *and* EFS; deletion protection + final snapshot on the instance |
| Security | Private subnets for everything but the ALB; per-hop security groups; WAF managed rules + rate limit; TLS everywhere incl. CloudFront→ALB; secrets in Secrets Manager (never in task defs); the api task's IAM can invoke Nova and, when an SES identity exists, send sign-in codes from it — *nothing else*; the boot guard still refuses prod on dev credentials |
| Observability | **Sentry** — errors + performance traces from the API (`SENTRY_DSN`) and the SPA (`environment.sentryDsn`), PII off. CloudWatch keeps only what Sentry can't: raw logs, infra metrics/alarms → email, and the dropped-interview-turn tripwire |
| Traceability | One `X-Request-ID` per request: caller-supplied or minted, echoed on the response, tagged on every Sentry event, printed in every `reep.access` log line, with ALB access logs in S3 as the edge record. One id from a click to a log line |
| Claude connectivity | The `reep-claude-observer` IAM role (read-only logs/metrics/ECS/RDS) for AWS-side diagnosis, plus the Sentry MCP connector for issue-level work — see §6 |
| Voice AI on Nova | `BEDROCK_MODEL` (default `apac.amazon.nova-pro-v1:0`) drives the LLM adapter for the resume brief and the grounded assistant. The realtime interviewer runs **Nova 2 Sonic** over the bidirectional stream — §7 is the checklist for turning it on, and it is not one variable |
| Call recording | `INTERVIEW_RECORDING_ENABLED=true` (a stack variable): two WAVs per interview (student and AI tracks, deliberately unmixed) on EFS at `/data/interview-audio`, only for students whose consent grant ticks store-audio, downloadable by DIRECTOR/ADMIN via `/api/interview` records, deleted on the 180-day retention clock |
| Email & password sign-in | Off until `mail_from_domain` + `local_auth_enabled` are set: an SESv2 domain identity with Easy DKIM, a configuration set whose bounces/complaints/rejects land on the alerts topic, a `ses:SendEmail` grant scoped to that identity and one From address, and a CloudWatch tripwire on `auth-otp send failed`. No secret — the task role signs. §8 is the checklist |

## 2. Prerequisites

- An AWS account, `aws` CLI authenticated, Terraform ≥ 1.6.
- **Bedrock model access**: in the console (Bedrock → Model access) enable the
  Amazon Nova family in your region, or pick the inference profile for it
  (`apac.…` in ap-south-1).
- **One ACM certificate, in `var.region`, for the ALB** (`alb_acm_certificate_arn`)
  — this is what keeps the CloudFront→ALB hop encrypted, and it needs a domain
  you control, because no public CA issues for `*.elb.amazonaws.com`. Add a
  second certificate in **us-east-1** if you also want your domain on
  CloudFront itself.
  *Have no domain yet?* Omit `alb_acm_certificate_arn` and the stack builds an
  HTTP origin instead, with the ALB locked to CloudFront's IP ranges so it is
  not publicly reachable. Browsers still get TLS. **That mode is for a
  throwaway environment — never point real student records at it**; every
  apply prints the `origin_encryption` warning while it is in force.
- **`alb_origin_domain`** — a hostname you own that CNAMEs to the load
  balancer (e.g. `origin.reep.example.com`), set whenever the ALB certificate
  is set. CloudFront verifies the origin's certificate against the *origin
  domain name*, and no public CA issues for `*.elb.amazonaws.com`, so the
  origin needs a name your certificate can actually cover.

  **It is a SECOND hostname, not the one people type.** `domain_name` is the
  public name and CNAMEs to CloudFront; `alb_origin_domain` CNAMEs to the ALB.
  Setting them to the same value reads sensible and routes `/api/*` from
  CloudFront back into CloudFront: the edge answers `403 "Bad request"` without
  ever reaching the ALB, while the S3 behaviour is untouched, so **the
  dashboard loads perfectly and nothing inside it works** — no login, no data,
  and no error anywhere that names a cause. `cdn.tf` now refuses that
  configuration at plan time rather than letting you find out from the edge.
- A Sentry org with two projects (api → Python/FastAPI, web → Angular); note
  both DSNs.
- **If you will turn on email & password sign-in (§8)**: SES in a fresh account
  is **sandboxed** per region — it sends only to verified identities, 200 a day,
  1 a second — and leaving the sandbox is a request AWS answers in about a day.
  The three DKIM CNAMEs go in the *sending* domain's zone, which may be the
  college's rather than yours, and they are grey-cloud too.

### If your DNS is at Cloudflare

Three records, and **every one of them must be "DNS only" (grey cloud)**:
the ACM validation CNAMEs, the `alb_origin_domain` record, and the app record
pointing at CloudFront. An orange-cloud record breaks ACM validation and puts a
second CDN in front of a CDN. Cloudflare appends the zone to whatever you type
in *Name*, so paste `_abc123.reep` — not the full `_abc123.reep.example.com` —
or you will create `_abc123.reep.example.com.example.com` and wonder why
validation never completes.

## 3. First deployment

State lives in S3, not in the shell that happened to run the first apply — a
CloudShell session gets reclaimed, and a local `terraform.tfstate` reclaimed
with it leaves Terraform unable to manage the stack it just built. The bucket
and the DynamoDB lock table cannot be resources in this stack (a state store
cannot be described by the state it stores), so one script creates them first.
It is idempotent, so re-running it on an existing setup changes nothing.

```bash
cd infra/aws
./bootstrap-state.sh                      # writes backend.hcl
terraform init -backend-config=backend.hcl
terraform apply \
  -var alb_acm_certificate_arn=arn:aws:acm:ap-south-1:...:certificate/... \
  -var alert_email=you@bgscet.ac.in
# with a domain, add:
#  -var domain_name=reep.bgscet.ac.in
#  -var cloudfront_acm_certificate_arn=arn:aws:acm:us-east-1:...
```

Then, in order:

```bash
# 1. Fill the operator-owned secret (Terraform never overwrites it). SES needs
#    NO entry here — the task role signs the send — so §8 never touches it:
aws secretsmanager put-secret-value \
  --secret-id "$(terraform output -raw external_secret_arn)" \
  --secret-string '{"GOOGLE_CLIENT_ID":"…","GOOGLE_CLIENT_SECRET":"…","SENTRY_DSN":"https://…ingest.sentry.io/…","VOICE_WORKER_SECRET":""}'

# 2. Build & push the api image:
aws ecr get-login-password | docker login --username AWS --password-stdin "$(terraform output -raw api_ecr_repository | cut -d/ -f1)"
docker build -t "$(terraform output -raw api_ecr_repository):latest" apps/api-py
docker push "$(terraform output -raw api_ecr_repository):latest"

# 3. pgvector, once, as the master user (password: app secret's DATABASE_URL):
psql "postgresql://reep:…@$(terraform output -raw db_endpoint)/reep_py" \
  -c 'CREATE EXTENSION IF NOT EXISTS vector;'
# RDS is private — run this from a one-off ECS task (`aws ecs run-task` with a
# psql-capable image) or a temporary bastion; never open 5432 to the internet.

# 4. Migrate + production-safe seeds, as one-off tasks on the SAME image:
aws ecs run-task --cluster "$(terraform output -raw ecs_cluster)" \
  --launch-type FARGATE --task-definition reep-api \
  --network-configuration "awsvpcConfiguration={subnets=[…private…],securityGroups=[…api sg…]}" \
  --overrides '{"containerOverrides":[{"name":"api","command":["python","-m","alembic","upgrade","head"]}]}'
# repeat with: ["python","-m","app.seed_kb"]  and  ["python","-m","app.seed_roster","roster.csv",…]
# NEVER app.seed — it refuses on ENV=prod, and that refusal is load-bearing.

# 5. Build & publish the SPA (set the web Sentry DSN first in
#    apps/web/src/environments/environment.ts → sentryDsn):
cd apps/web && npx ng build
aws s3 sync dist/web/browser "s3://$(terraform -chdir=../../infra/aws output -raw web_bucket)" --delete

# 6. Force a fresh service deployment so tasks pick up the pushed image:
aws ecs update-service --cluster reep --service api --force-new-deployment
```

Finally: register `https://<domain>/api/auth/sso/google/callback` as the
authorised redirect URI on the Google OAuth client (docs/google-sign-in.md),
and confirm the SNS subscription email that lands in `alert_email`'s inbox.

## 3a. Doing all of this from a browser

`docs/deploy-from-chrome.md` is the same sequence written as a playbook for the
Claude Chrome extension, using AWS CloudShell as the terminal — including the
human checkpoints (read the plan before apply) and the list of things a browser
agent must never do to this account.

## 3b. Deploying from the browser (no terminal)

Once §3 has run once, every later deploy is a button in GitHub — useful when
you are not at a dev machine, and safer than pasting keys anywhere:

1. **Grant the door, once.** `infra/aws/github_oidc.tf` creates an IAM role
   GitHub Actions assumes over **OIDC** — no access key is ever stored in
   GitHub. Its trust policy is pinned to `darshani8/reep-` on `main`, so a
   fork or a stranger's pull request cannot deploy the account, and its
   permissions stop at: push this ECR repository, roll this ECS service, run a
   task in this family, write this web bucket, invalidate this distribution.
   It can read no secret and no database row.
2. **Wire the workflow, once.** Terraform prints the exact commands:
   ```bash
   terraform -chdir=infra/aws output -raw github_actions_setup   # then paste them
   ```
   (Optionally add a `WEB_SENTRY_DSN` repository *secret* to build the SPA with
   client telemetry.)
3. **Deploy.** In Chrome: **Actions → Deploy → Run workflow**, choose what to
   ship (`api-and-web` / `api-only` / `web-only`), leave migrations ticked, and
   type `deploy` in the confirm box.

What the run does, in order: build and push the image tagged with the commit
*and* `latest` → run `alembic upgrade head` as a one-off Fargate task on that
new image, **failing the deploy before rolling anything if the migration
fails** → force a new service deployment and wait for the tasks to be healthy →
build the SPA, sync it to S3 (hashed assets immutable, `index.html`
never cached) and invalidate the CloudFront entry point.

**It deploys code, never infrastructure.** `terraform apply` stays a human
action at a terminal where the plan can be read first — a button that can
silently recreate a database is not a button worth having.

## 4. Deploying updates

API: build + push the image, then `aws ecs update-service … --force-new-deployment`
(the circuit breaker rolls back a bad image on its own). Run the alembic
one-off task first whenever a release carries a migration. SPA: `ng build` +
`aws s3 sync` (CloudFront picks up hashed filenames immediately; after an
`index.html`-only change, `aws cloudfront create-invalidation --paths "/index.html"`).

## 5. Observability + traceability, in practice

- **Sentry is the pane of glass.** API exceptions, slow transactions, and SPA
  errors/route traces all land there, PII off (`send_default_pii=False`; the
  session cookie never leaves the process). Every API event carries the
  `request_id` tag.
- **The trace thread**: any response's `X-Request-ID` header → Sentry search
  `request_id:<id>` → CloudWatch Logs Insights over `/reep/api` filtering
  `rid=<id>` → the ALB access log line in S3. Same id at every hop; students'
  bug reports become greppable.
- **CloudWatch keeps the infra floor**: alarms → email for no-healthy-tasks,
  ALB 5xx, RDS storage/CPU, CPU-pegged-at-max-tasks, and the one AI tripwire —
  `Dropped interview turn` in the logs, the silent save-nothing failure the
  voice runbook in AGENTS.md documents, which no exception tracker can see.

## 6. Connecting Claude to monitor and fix

- **Sentry MCP connector** (claude.ai → Settings → Connectors → Sentry):
  authorize it once and Claude Code sessions can list issues, read events and
  traces, and go from a Sentry issue to a code fix in the same conversation.
  (It is attached to this repo's sessions already but unauthorized until you
  complete that OAuth step.)
- **AWS side**: `terraform output claude_observer_role_arn` is a read-only role
  (CloudWatch, Logs Insights, ECS, RDS, ALB describes). Give a session
  credentials that can assume it — via `aws sts assume-role` in the session, or
  an AWS MCP server configured with that role — and Claude can pull the exact
  log lines and metrics behind an alarm without any write access. Fixes ship
  through git and the deploy pipeline, never through a console session.

## 7. Voice on Nova — what is true today

Two different voices exist in this codebase:

1. **The adapter-driven text paths** (resume brief, grounded assistant,
   evaluations) run on **Amazon Nova today** via `BEDROCK_MODEL` — implemented
   in `app/ai/llm.py` as a first-class Bedrock transport with rule 1's egress
   gate still in force (`LLM_ALLOW_REMOTE_STUDENT_DATA=true` is the stack
   default, a defensible call for in-account Bedrock, which does not train on
   your traffic).
2. **The realtime speech-to-speech interviewer** (`/api/interview`) runs
   **Amazon Nova 2 Sonic** (`amazon.nova-2-sonic-v1:0`) over Bedrock's
   bidirectional stream, signed by this stack's task role with no key anywhere.
   `INTERVIEW_ENGINE` chooses between it and the on-machine engine, and it is
   the default. See `docs/interview-assistant.md` § *Engines* for what that
   means behind the socket (Nova owns the turn, the engine owns the phase; the
   scorecard is a tool call; the 8-minute stream limit caps the session).

   The OpenAI relay that served this until 2026-09 has been deleted, so there
   is no longer a second hosted engine to fall back to. **Nova has not spoken to
   a real student yet.** Everything below is what turning it on requires; none
   of it happens by deploying code.

### Turning the Nova interviewer on

The Deploy workflow ships code and never infrastructure, so steps 1–2 are a
`terraform apply` at a terminal and step 3 is a console visit.

1. **Bedrock model access** for `amazon.nova-2-sonic-v1:0`, in the account, in a
   region that serves it. As of this writing that is **us-east-1, us-west-2 and
   ap-northeast-1** — and pointedly **not ap-south-1**, where the rest of this
   stack lives. `var.nova_sonic_region` therefore defaults to Tokyo rather than
   inheriting `var.region`; the extra round trip is tens of milliseconds against
   a conversation, and the alternative is a socket that dies at the handshake.
   Re-check the model card before assuming the list has not moved.
2. **`terraform apply`.** `interview_engine` already defaults to `"nova"`; the
   task role already
   carries `bedrock:InvokeModelWithBidirectionalStream` (`infra/aws/ecs.tf`) —
   a **third, distinct** IAM action that `InvokeModel` and
   `InvokeModelWithResponseStream` do not imply. An earlier version of this page
   claimed the IAM "already permits it"; it did not, and the symptom of that
   mistake is close 4002 with an AccessDeniedException in the API log.
3. **Bump `INTERVIEW_CONSENT_VERSION`.** The consent panel names who receives
   the student's voice, and the server now supplies that label from the running
   engine (`GET /api/interview/consent` → `provider`). Changing engines changes
   the recipient, so the students who agreed to the old wording have not agreed
   to this one. `interview_consents` exists to answer *what did they agree to*;
   leaving the version alone makes it answer wrongly.
4. **Make one call yourself before a student does**, and check three things in
   the same session: that the interviewer greets you unprompted (the kick-off
   control note landed), that it does not ask two questions in a row at a phase
   boundary (`docs/interview-assistant.md` explains why that is the line to
   watch), and that a row lands in `interview_evaluations` with
   `report_status = 'ok'` — the scorecard arrives as a tool call, and a model
   that talks instead of calling the tool is the failure mode to catch here
   rather than in front of a cohort.
5. **There is no hosted rollback any more.** `interview_engine = "local"` runs
   the interview on this machine, but this stack has no model weights and no
   GPU, so on AWS that is "no interviews" rather than "different interviews".
   The honest rollback is a revert of the deletion commit — `OPENAI_API_KEY` is
   still in the operator-owned secret, untouched by any apply (`secrets.tf`
   says why). Interviews already conducted keep their rows and transcripts
   whatever you choose.

## 8. Email & password sign-in on SES

The second door beside Google (`docs/email-password-sign-in.md` is the design
record and the runbook; this is the AWS checklist). It ships **dark**: with
`mail_from_domain` blank nothing in `infra/aws/email.tf` exists, the task carries
`EMAIL_TRANSPORT=""` and `LOCAL_AUTH_ENABLED=false`, and the stack behaves
byte-for-byte as before. Like §7, none of this happens by deploying code — the
Deploy workflow's role cannot create IAM or SES — so every step below is a
`terraform apply` at a terminal or a console visit.

**Read step 0 first.** The API answers `202` to every code request whatever the
transport does (that is what stops the endpoint enumerating the roster), so a
door opened before the identity is verified tells every student a code is on
its way and delivers none.

0. **Do not set `local_auth_enabled` before step 6.** Everything before it can
   be done while students still see Google only; identity verification, DNS and
   SES production access all take wall-clock time, and the UI must not
   advertise a door that silently sends nothing.
1. **Choose the sending domain, consciously.** Two honest options:
   - **The roster domain** — `mail_from_domain = "bgscet.ac.in"`,
     `mail_from_address = "REEP <no-reply@bgscet.ac.in>"`, `mail_reply_to` =
     the placement office. Recommended when the college's DNS admin will add
     three CNAMEs: inside the SES sandbox a verified **domain** identity makes
     every `@bgscet.ac.in` recipient deliverable, so a cohort pilot can run
     before production access is granted (only the 200/day and 1/s caps bite).
   - **The app's own subdomain** — `mail_from_domain = var.domain_name` (e.g.
     `reep.bgscet.ac.in`), `mail_from_address = "REEP <no-reply@reep.bgscet.ac.in>"`.
     DNS stays in your hands, but **every student is undeliverable until step 5
     is approved**.

   Either way the college's root-domain SPF and DMARC are never edited (Easy
   DKIM aligns on the From domain under relaxed alignment, the default). Prove
   whichever you chose with one real send (step 7) before rollout day.
2. **`terraform apply`** with the `mail_*` variables set (`prod.tfvars` is
   gitignored; `terraform validate` must pass first):
   ```bash
   cd infra/aws && terraform apply -var-file=prod.tfvars
   ```
   This creates the SESv2 identity with Easy DKIM, the configuration set with
   BOUNCE/COMPLAINT/REJECT events to the alerts topic, the scoped
   `send-sign-in-codes` policy on the api task role, registers a new task
   revision carrying `EMAIL_TRANSPORT=ses` / `EMAIL_FROM` / `EMAIL_REPLY_TO` /
   `SES_REGION` / `SES_CONFIGURATION_SET`, and re-points the service. **The
   operator-owned secret is not touched — do not re-put it.** The apply refuses
   at plan time if `mail_from_address` is not under `mail_from_domain`.
3. **Add the three DKIM CNAMEs** printed by `terraform output dns_records_to_create`
   at the registrar / Cloudflare, **DNS only (grey cloud)** — a proxied CNAME
   breaks DKIM verification exactly as it breaks the ALB origin. Then poll
   ```bash
   terraform refresh && terraform output ses_identity
   # or
   aws sesv2 get-email-identity --email-identity <domain> --region ap-south-1 \
     --query '{sending:VerifiedForSendingStatus,dkim:DkimAttributes.Status}'
   ```
   until `verified = true` (minutes to an hour, up to 72 h). Until then SES
   refuses to send from the domain.
4. **The SES sandbox**, on by default for every new account per region: while
   sandboxed, SES sends **only to recipients that are themselves verified
   identities** (a verified *domain* counts for every address on it), at most
   200 messages a day and 1 per second. Check with
   ```bash
   aws sesv2 get-account --region ap-south-1 \
     --query '{prod:ProductionAccessEnabled,quota:SendQuota}'
   ```
   If your sending domain is not the roster domain, verify your own address for
   the end-to-end test — `aws sesv2 create-email-identity --email-identity
   you@bgscet.ac.in --region ap-south-1` and click the link. Any unverified
   student would get nothing while the API answers 202; the witnesses are the
   ERROR line `auth-otp send failed` (SES code `MessageRejected`, *Email
   address is not verified*), the FAILED row in
   `GET /api/director/mail?kind=auth-otp`, and the `reep-auth-otp-send-failures`
   alarm.
5. **Request production access** (leaves the sandbox; required for a non-roster
   sender, for more than 200 codes a day, or for bursts above 1/s): console →
   Amazon SES → Account dashboard → *Request production access*, or
   ```bash
   aws sesv2 put-account-details --production-access-enabled \
     --mail-type TRANSACTIONAL --website-url https://reep.bgscet.ac.in \
     --use-case-description "One-time sign-in codes for a college placement dashboard; recipients are enrolled students and staff on bgscet.ac.in; ~50/day; bounces and complaints go to an SNS topic and addresses are removed from the roster by the placement office" \
     --additional-contact-email-addresses ops@… --contact-language EN \
     --region ap-south-1
   ```
   AWS answers within about 24 h; confirm `ProductionAccessEnabled: true`.
6. **Turn the door on.** Ship the code (and its `auth_email_otps` migration —
   the Deploy workflow runs `alembic upgrade head` as a one-off task by family)
   **first**, then set `local_auth_enabled = "true"` in `prod.tfvars`,
   `terraform apply` (a new task revision), and run the Deploy workflow or
   `aws ecs update-service --cluster reep --service api --force-new-deployment`
   so every task carries `LOCAL_AUTH_ENABLED=true`. If the roster email
   convention was ever in doubt, run `python -m app.seed_roster --rekey-domain`
   **before** this step: a row that has set a password is no longer movable, by
   design.
7. **Verify.** `curl https://<domain>/api/auth/sso/status` shows
   `password_login_available: true`, `password_setup_available: true`,
   `password_reason: null`; `/ready` shows `email.transport: ses`,
   `configured: true`, `local_auth: true`. Then, with your own roster address,
   use *Create your password* end to end: the code arrives with `DKIM=pass` in
   the Gmail headers (*Show original*), the password signs you in,
   `select status, error, sent_at from mail_logs where kind='auth-otp' order by sent_at desc limit 5;`
   shows `SENT`, and a second browser that held your old session now answers
   401 on `/api/auth/me`. Then sign in with Google on the same account to
   confirm both doors mint a working session, and use the shell's *Change
   password* link once.
8. **Rollback**: `local_auth_enabled = "false"` + apply. The form renders
   disabled with the reason, `/login` and `/password/*` refuse, passwords
   already set stay in the database inert and work again the moment the flag
   returns, Google is unaffected throughout, and no sessions are revoked by the
   flag either way. Setting `mail_from_domain` back to blank additionally
   destroys the identity, the configuration set and the grant.

"I never got a code" has its own runbook table in
`docs/email-password-sign-in.md`; the short version is `GET
/api/director/mail?kind=auth-otp` first, then the alarm, then the bounce
notifications on the alerts topic.

## 9. Interview call recording

Already in the engine (`app/interview_audio.py`), enabled by this stack's
`interview_recording_enabled=true`. What that means, precisely: recording is
**two independent switches** — the deployment flag AND the student's own
consent grant with the store-audio scope ticked (a separate, unticked-by-default
checkbox whose copy says staff can listen). Two WAV files per interview, one
per speaker, never mixed; capped by `INTERVIEW_RECORDING_MAX_BYTES` with a
truncation flag; stored on EFS (`/data/interview-audio`), covered by the AWS
Backup plan, retrievable only by DIRECTOR/ADMIN, and deleted with the rest of
the interview record after `INTERVIEW_RETENTION_DAYS` (180). A student who
never ticks the box is never recorded, whatever the flag says.

## 10. Costs, roughly (ap-south-1, light term-time load)

Fargate 2×(0.5 vCPU/1 GB) ≈ $30/mo · RDS db.t4g.small single-AZ ≈ $25/mo +
storage · NAT ≈ $35/mo · ALB ≈ $20/mo · EFS/S3/CloudFront/logs ≈ $5–15/mo →
**≈ $115–140/mo** before Bedrock/OpenAI token spend; Multi-AZ RDS roughly
doubles the database line. Sentry's developer tier is free and sufficient to
start.
