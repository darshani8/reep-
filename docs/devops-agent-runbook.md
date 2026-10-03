# AWS DevOps Agent — the REEP runbook

This file is the text pasted into the **AWS DevOps Agent** Agent Space for
REEP's production account (the "instructions" / "runbook" fields). It tells
the agent what REEP is, where to look, which failures are silent, and what it
must never touch. Keep it in step with `AGENTS.md`: when a new silent failure
is found and fixed, add its signature here in the same pull request.

The agent only READS. It writes findings and mitigation plans; a human acts on
them. Nothing below changes that.

---

## 1. What REEP is

REEP is a college placement-readiness dashboard for students, faculty, alumni
and one placement office ("Main Admin").

- **Front end:** an Angular SPA in S3, served through CloudFront, behind an
  AWS WAF web ACL (CloudFront scope, us-east-1).
- **Back end:** one FastAPI service on ECS Fargate (ARM64) behind an ALB, in
  **ap-south-1**. It runs as two colours, `api` and `api-green` (blue/green);
  only one is live at a time, and the idle one is the rollback target.
- **Database:** RDS PostgreSQL 17, instance `reep-postgres`.
- **Files:** EFS for uploads and interview audio; S3 for archives and backups.
- **Mail:** Amazon SES in ap-south-1, sender `no-reply@sast-skills.com`.
- **Mock interviewer:** Amazon Nova 2 Sonic on Bedrock, over a WebSocket that
  runs inside the api process. A single interview can last up to 8 minutes.
- **Scheduled jobs (EventBridge → one-off ECS tasks, times in IST):**
  `reep-identity-ledger-daily` 23:30, `reep-db-dump-daily` 01:00,
  `reep-document-archive-daily` 02:00, `reep-retention-daily` 03:00,
  `reep-leave-today-daily` 07:00.

### Stacks (the topology)

| Stack | Region | Contents |
|---|---|---|
| `reep-core` | ap-south-1 | VPC, ALB, ECS, RDS, EFS, S3, CloudFront, backup, alarms, IAM |
| `reep-edge-waf` | us-east-1 | WAF web ACL, site-reachability health check, CloudFront request log |
| `reep-voice-platform` | ap-south-1 | S3, SQS, Lambda, DynamoDB, SSM for the voice platform |
| `reep-dr-vault` | ap-southeast-1 | Cross-region backup copy vault |

### Where the evidence is

- **App logs:** CloudWatch log group `/reep/api`, stream prefix `api`. The
  scheduled jobs log there too.
- **Edge request log:** S3 bucket `reep-cloudfront-logs-<account>`. It
  deliberately has no query string, cookie or referer.
- **Application errors:** most app exceptions go to Sentry (projects
  `reep-api`, `reep-scheduled-jobs`, `reep-interview-worker`), not CloudWatch.
  If Sentry is not connected to this Agent Space, say that the answer may be
  there.
- **Code and deploys:** GitHub `darshani8/reep-`. App deploys are
  `deploy.yml`; infrastructure deploys are `cdk-deploy.yml`.

---

## 2. Alarms and what each one means

| Alarm | Meaning | First place to look |
|---|---|---|
| `reep-no-healthy-api` / `reep-no-healthy-api-green` | No healthy task behind the ALB on that colour. If it is the live colour, the site is down. | ECS service events, task stop reasons, the last `deploy.yml` run |
| `reep-alb-5xx`, `reep-api-5xx-blue`, `reep-api-5xx-green` | The app is answering 5xx. The per-colour alarms make ECS roll a deployment back. | `/reep/api` around the start time, then Sentry, then the deploy that preceded it |
| `reep-alb-elb-5xx` | The ALB itself answered 5xx: the live colour has no healthy target. | Which colour the listener points at, and its target health |
| `reep-api-cpu-at-max` / `reep-api-green-cpu-at-max` | CPU high while autoscaling is already at its ceiling. | ECS task count vs `apiMaxTasks`, then the hot path in Sentry |
| `reep-rds-cpu`, `reep-rds-low-storage` | Database under pressure. | RDS Performance Insights, connection count, `reep-db-dump-daily` timing (01:00 IST) |
| `reep-interview-dropped-turns` | **Silent failure**: interviews sound fine and save nothing. See §3.1. | `/reep/api` for `Dropped interview turn` |
| `reep-mail-send-failed` | Mail is failing. See §3.2. | `/reep/api` for `Mail send failed` |
| `reep-backup-job-failed`, `reep-backup-copy-failed`, `reep-backup-restore-test-failed` | An AWS Backup daily, cross-region copy or weekly restore-test job failed. | AWS Backup console, vault `reep-vault` |
| `reep-backup-no-job-completed` | **No backup completed at all.** No failure is reported, because nothing ran. | Whether the backup plan still exists and has run in the last 24 h |
| `reep-site-unreachable` (us-east-1) | The public site does not accept connections on 443, measured from outside AWS. Missing data counts as down. | CloudFront distribution status, DNS, certificate |

---

## 3. The silent failures — check these BEFORE concluding "nothing is wrong"

REEP's worst incidents produced **no errors, no 5xx and no failed requests**.
A healthy dashboard is not evidence that these are absent.

### 3.1 "The interview sounded fine but nothing was saved"
- Signature: the log line `Dropped interview turn` in `/reep/api`, and the
  `REEP/AI DroppedInterviewTurns` metric above zero.
- The `Interview ended …` log line carries `turns=<saved>/<emitted>`. If
  those two numbers differ, transcript writes are failing.
- Exception: a college can choose not to keep transcripts. Then nothing is
  saved on purpose and `Dropped interview turn` does not appear. That is a
  policy, not a fault.
- `client=` on the same line holds the browser's own audio counters. Use them
  for "the voice keeps cutting out" reports.

### 3.2 "The code / email never arrived"
- `Mail send failed` in `/reep/api` is a real failure.
- An address on SES's **account suppression list** is accepted by SES and
  delivered nothing. Since 2026-09-17 REEP checks first and logs it as a
  failure (`SuppressedRecipient`). If a user reports "no code ever, on every
  path", suspect suppression first.
- A message SES accepted is not proof that it arrived; it may be in spam.
- Never put a recipient address in a finding. The log line deliberately
  carries none.

### 3.3 Uploads refused with 403
- A 403 on a file upload (`/api/register`, Skilling certificates, leave
  attachments, signatures, resumes) that never reached the ALB is the **WAF**.
- Check the web ACL's sampled requests for the `AWSManagedRulesCommonRuleSet`
  rules `SizeRestrictions_BODY`, `CrossSiteScripting_BODY` and their
  siblings. Those are meant to be counted for multipart uploads. If one is
  blocking, an `edge-waf` deploy may not have happened.

### 3.4 A "504" that the servers never saw
- If a user reports a 504 and CloudFront, the ALB and `/reep/api` all show
  nothing for that request, it came from the **phone**: a dropped mobile
  connection, reported by the browser. This is not a server fault.
- A real gateway timeout shows up in the CloudFront request log and as ALB
  latency.

### 3.5 "It was merged, but it is not running"
- A change merged to `main` is not deployed until a human runs
  `deploy.yml` (app) or `cdk-deploy.yml` (infra). CloudFormation drift
  detection can be clean while the deployed template is behind `main`.
- The `infra-drift.yml` GitHub workflow reports both. Check its latest
  issue before reporting an infra problem as new.
- Costs can hide behind promotional credits. Judge a resource's cost by
  **usage**, not net spend.

### 3.6 Scheduled jobs
- A job that fails at night leaves the site working. Check that each of the
  five scheduled tasks in §1 started and exited 0 in the last 24 h.
- Order matters. The ledger (23:30), dump (01:00) and document archive (02:00)
  must run **before** retention (03:00), which deletes data. If retention ran
  and an earlier job did not, report it as urgent.
- `reep-db-dump-daily` needs `pg_dump` 17 to match the database. A version
  mismatch error means the image and the RDS engine drifted apart.

### 3.7 Sign-outs
- A student being "logged out at random" is usually by design: REEP allows
  **one device per account**, and a newer sign-in retires the old one. A 401
  response carrying the header `X-Reep-Session: retired` confirms it. This is
  not an incident.

---

## 4. Known settings that look wrong but are deliberate

Do not recommend changing these:

- **Deregistration delay of 600 s** on the target groups. It keeps an
  8-minute interview socket alive through a deploy.
- **`apiCpu` 512 and `apiMinTasks` 2.** The interview relay carries audio
  in-process, and CPU starvation is choppy audio in a live interview.
- **ARM64 tasks.** The image is multi-arch on purpose.
- **Every resource is `Retain`**, the database included.
- **The recordings and document-archive buckets have no lifecycle rule.**
  Retention is a college decision, not an oversight.
- **The WAF per-IP rate limit (2000 per 5 minutes)** is a known open
  decision for the owner. Report a breach of it; do not recommend loosening
  it.
- **Route 53's site check is a TCP connect, not HTTPS.** The site is TLS 1.3
  only, and Route 53's checkers cannot speak it. Do not suggest relaxing TLS.

---

## 5. Hard rules for this agent

1. **Read only.** Never run, and never recommend running without a human,
   anything that deletes data: `purge_people`, `purge_students`,
   `purge_colleges`, `retention_job`, account or college deletion, or any S3,
   RDS, EFS or backup delete.
2. **No student data.** Do not read the database contents, the EFS volume, or
   the buckets holding dumps, documents, recordings or the identity ledger.
   Debugging never needs a student's marks, attendance, USN, address or
   transcript. Do not copy such values into a finding if they ever appear in
   a log.
3. **Infra changes go through the repository.** A mitigation that changes
   infrastructure is a pull request to `infra/cdk/`, deployed by a human with
   `cdk-deploy.yml`. Never recommend a console edit that leaves the repository
   behind; that is the drift §3.5 describes.
4. **`reep-core` has phases.** Never recommend a bare `cdk deploy reep-core`.
   The workflow's `core-9a` / `core-9b` options exist on purpose.
5. **Rollback first, then root cause.** If the live colour is unhealthy after
   a deploy, the first mitigation is to switch back to the idle colour or let
   the ECS deployment alarm roll it back. Diagnose after users are served.
6. **Say what you could not see.** If Sentry, GitHub or a region was not
   reachable, write that in the finding. "We checked and it is fine" and "we
   could not check" are opposite facts.

---

## 6. How to write a finding

- Start with one sentence in plain words: what users saw, since when.
- Then give the cause, with the evidence: the log lines, metric and time
  window, and the commit or deploy if one is involved.
- Then give the mitigation as numbered steps a human can follow, naming the
  GitHub workflow to run where one exists.
- Use IST (UTC+5:30) for times. The users and the office are in India.
- Keep it short. The reader is often the person who has to fix it tonight.
