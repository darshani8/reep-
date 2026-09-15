# Cost review, 2026-09-15

Account `445363794125`, region `ap-south-1` (Mumbai), with the backup vault in
`ap-southeast-1` (Singapore) and Nova Sonic reached in `ap-northeast-1` (Tokyo).
Every number here came from Cost Explorer and the live AWS APIs on 2026-09-15,
not from a pricing calculator.

## The headline

**The bill is ~$514/month at list price. $361 of it — 70% — is an OpenSearch
Serverless collection that nothing reads, whose removal was merged to `main` on
2026-09-08 and never deployed.**

Commit `ecdb37b` ("infra: remove OpenSearch — $361/month for two indexes nothing
read") deleted the collection from `reep_voice_platform/stack.py`, deleted
`storage/opensearch.py`, and dropped `platform_call_sessions.opensearch_synced`.
It was reviewed and merged the same day. As of this review the collection
`reep-voice` is still `ACTIVE`, still in the deployed `reep-voice-platform`
stack's 34 resources, and still billing **$11.87/day**.

The evidence that it does nothing, gathered independently of the commit message:

* `grep -ri opensearch apps/api-py/` returns four hits, all of them prose — two
  docstrings, a migration and its predecessor. **Zero call sites.**
* CloudWatch `AWS/AOSS` has published no `SearchRequestRate`, no
  `IngestionRequestRate`, no `SearchableDocuments` and no `StorageUsedInS3` for
  the collection, ever.
* `standbyReplicas: ENABLED`, which is what makes it 2 OCU (1 indexing +
  1 search, each with a standby) rather than the 0.5 OCU floor.

It went live on 2026-09-05 and has cost about **$120 gross** since, of which
roughly **$83 was spent after the fix was already merged.**

### Why nobody noticed

Two reasons, and both are worth fixing rather than remembering.

**The credits hid it.** This account is running on promotional credits that are
absorbing about 75% of the bill. Grouped by service the way the console shows it
by default, OpenSearch reads **$0.00** — the credit exactly cancels the charge.
It only appears when you filter `RECORD_TYPE=Usage`:

| | 14 days |
|---|---:|
| Gross usage | $180.52 |
| Credits applied | −$136.24 |
| Tax (18% GST) | $8.05 |
| **Actually paid** | **$52.34** |

Credits are being consumed at roughly **$296/month**. When they run out the bill
does not rise gently — it lands at the gross number, which today is **$514/month
before tax, $606 after**. *Check Billing → Credits for the expiry date; the
urgency of everything below depends on it.*

**The drift check asked the wrong question.** `docs/cdk-cutover.md` step 5 runs
`detect-stack-drift`, and on 2026-09-15 that returns clean — correctly. The
deployed template still declares the collection and AWS still has it; nothing has
drifted. These are two different questions:

| Check | Asks | Would it have caught this? |
|---|---|---|
| `detect-stack-drift` | does AWS match the deployed template? | **No** — they matched |
| `cdk diff` vs `main` | does the deployed template match the repo? | **Yes**, on 2026-09-09 |

Only the first was ever run, and only by hand, once, during the cutover.
`.github/workflows/infra-drift.yml` now runs both on a schedule — see
*Automation* below.

## Where the rest of the money goes

Gross, per month, at list price. Measured over 14 days and scaled; OpenSearch is
shown at its full-month rate since it only ran 10 of those days.

| Line | $/month | Notes |
|---|---:|---|
| OpenSearch Serverless (2 OCU) | **361.0** | reads nothing |
| NAT Gateway (hours + data) | 43.6 | |
| Fargate vCPU + memory | 38.0 | 2 × (0.5 vCPU, 1 GB) |
| ALB | 17.5 | LCU charges are ~$0.001 — pure idle hours |
| RDS `db.t4g.micro`, Multi-AZ | 15.4 | |
| Public IPv4 × 3 | 11.0 | 1 NAT EIP + 2 ALB nodes |
| WAF (web ACL + rules) | 8.1 | |
| Backup recovery points + Singapore copy | 7.6 | |
| CloudWatch alarms | 5.3 | 16 alarms |
| RDS storage (gp3 40 GB billed) + backups | 3.4 | |
| Secrets Manager | 0.8 | |
| **Bedrock Nova Sonic** | **1.1** | see below |
| Everything else (S3, ECR, EFS, CloudFront, DynamoDB, SES) | ~0.8 | |
| **Total** | **~513.6** | +18% GST = **~$606** |

### The load this is carrying

| Signal | Value |
|---|---|
| ALB requests/day | 1 – 1,851 |
| Fargate CPU | **1.7%** |
| Fargate memory | 16% → 32% over 14 days |
| RDS CPU | 4.5% |
| RDS connections | 3.5 – 7.6 |
| AOSS / DynamoDB / SQS | zero |

This is an enterprise HA topology — Multi-AZ database, two tasks across two AZs,
NAT gateway, WAF, cross-region DR vault, 35-day backups with a 365-day archive —
carrying a workload that peaks at under two thousand requests a day. That is not
an argument for tearing the resilience out; it is the reason the *fixed* costs
dominate and the variable ones are invisible.

### Nova Sonic is not the problem, and it is worth saying so

The instinct is that the speech-to-speech interviewer is the thing that will
bankrupt this. Measured, it is the cheapest meaningful line on the bill.

| | 30 days | implied rate |
|---|---:|---|
| speech input | 11,222 tokens | $3.63 / M |
| speech output | 30,299 tokens | $14.52 / M |
| text input | 15,533 tokens | $0.40 / M |
| text output | 8,925 tokens | $3.32 / M |

That works out to roughly **$0.06 per completed 8-minute interview**. A thousand
students doing four rounds each is about **$240** — a one-off, not a run rate,
and less than eight months of the collection that reads nothing. The cap at
`nova_sonic_connection_seconds` (480) is what keeps it bounded, and it is doing
its job.

## What to do, in order

### 1. Deploy `ecdb37b` — $361/month, no risk

The code is already on `main`. The collection has no readers, no writers and no
documents. Run the **CDK deploy** workflow:

> stack: `voice-platform` · action: `diff` — read it, confirm the only removals
> are `AWS::OpenSearchServerless::{Collection,AccessPolicy,SecurityPolicy}`
> then re-run with action: `deploy`, confirm `deploy`.

`deletionProtection` on the collection is `DISABLED`, so nothing blocks it. This
is the single highest-value action available and it takes about four minutes.

This review also removed two stale `OpenSearch` mentions in `infra/cdk/app.py`,
one of which is the `description=` passed to `VoicePlatformStack` — that string
is deployed CloudFormation metadata, so it was itself a live repo-vs-AWS diff.

### 2. Put a guardrail under it — before the credits expire

The only budget on this account is AWS's default **"My Zero-Spend Budget" at
$1.00/month**, which tracks *net* spend. It could not have seen a fully credited
$361/month resource and it will not see the next one. Replace it with a budget on
gross spend:

```sh
# A real ceiling, on gross usage, alerting before it is hit rather than after.
aws budgets create-budget --account-id 445363794125 --region us-east-1 \
  --budget '{"BudgetName":"reep-gross-monthly","BudgetLimit":{"Amount":"250","Unit":"USD"},
             "TimeUnit":"MONTHLY","BudgetType":"COST",
             "CostTypes":{"IncludeCredit":false,"IncludeDiscount":true,"UseAmortized":true}}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"FORECASTED",
      "ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},
      "Subscribers":[{"SubscriptionType":"EMAIL","Address":"bdarshan5@bgscet.ac.in"}]}]'
```

`IncludeCredit: false` is the whole point of the command.

### 3. The menu, after OpenSearch is gone

Remaining gross is about **$153/month**. Everything below is optional and each
line is a real trade, not free money.

| Action | Saves/mo | What it costs you |
|---|---:|---|
| **NAT gateway → tasks in public subnets, ALB-only ingress SG** | **~$40** | Tasks hold public IPs. Ingress stays SG-locked to the ALB; you lose a layer of defence in depth. |
| NAT gateway → NAT instance on `t4g.nano` | ~$40 | Same saving, keeps the private subnets, but it is now an EC2 box you patch. |
| **Fargate → ARM64 / Graviton** | **~$7.6** | Needs a `buildx --platform linux/arm64` image and `runtime_platform` on the task def. **No capacity change at all** — same vCPU, 20% cheaper. |
| RDS Multi-AZ → Single-AZ | ~$9 | AZ failure becomes a ~20–30 min restore instead of a failover. A business decision, and one step 9b deliberately made in the other direction. |
| Consolidate CloudWatch alarms | ~$2 | Four of the sixteen are autoscaling's own. Low value. |
| Weekly rather than daily Singapore copy | ~$2.5 | A worse recovery point for very little. Not recommended. |

**VPC interface endpoints are not the answer to the NAT bill.** Replacing NAT
needs ECR (×2), Secrets Manager, CloudWatch Logs, SSM, Bedrock and SES — roughly
six interface endpoints at ~$7.30/month each, which is the NAT cost back again —
and Google's JWKS endpoint and the LLM providers are not AWS services, so they
would still need a route to the internet. Public subnets or a NAT instance are
the only two real options.

Taking the NAT and ARM64 rows gets to **~$105/month gross (~$124 with GST)**.
Taking Single-AZ as well gets to **~$96**. Against $606 today, that is an
**80–84% reduction**, and the only thing given up is the NAT layer and
(optionally) database failover.

### 4. Two things I declined to change

**`apiCpu` stays at 512.** Dropping to 256 would save about $16/month and it is
the obvious call from the CPU graph — 1.7% average. It is the wrong call. The
interview relay carries 24 kHz PCM in both directions inside the API process
(`interview_max_sessions: 100` per worker, and `config.py` is explicit that "one
CPython process cannot carry 1000 sessions (~96 MB/s of PCM)"). CPU starvation on
a real-time audio path is not a slower page, it is choppy audio in a student's
mock interview — which is the product. Autoscaling reacts on a 60-second
cooldown, far too slow to rescue a call already in progress. $16/month is a
cheap price for headroom on the one path where latency is the feature. If you
want it anyway the knob is `apiCpu` in `infra/cdk/cdk.json`; it is a one-line
context change and a task-definition roll.

**`apiMinTasks` stays at 2.** One task would save ~$19/month and would put the
whole API in a single AZ, with every deploy a single-task event.

## Automation

`.github/workflows/infra-drift.yml` — daily at 08:00 IST, and on demand.

1. **`cdk diff` every stack against `main`.** Each stack separately, so a noisy
   core diff cannot hide a quiet platform one. `reep-core` is diffed both bare
   and with `-c hardenEcs=false`, because those render different task
   definitions and diffing only one form would report the other as drift on
   every run — a check that cries wolf daily is a check nobody reads.
2. **`detect-stack-drift`** on `reep-core` and `reep-voice-platform` — the
   cutover runbook's manual step, on a timer. Reported separately from the diff
   because they fail for opposite reasons: a diff means *deploy it*, drift means
   *reconcile it*.
3. **Gross spend by service, credits excluded** — so a credited resource is
   visible while it is still cheap to remove.

It opens one labelled issue, comments on it while the condition persists, and
closes it when everything is clean. It **never deploys**: `core-9b`'s
precondition cannot be read from this repository at all, so an auto-deploy here
could run exactly the update `cdk-deploy.yml`'s 9a/9b split exists to prevent.

The gross-spend step needs `ce:GetCostAndUsage` on `reep-github-deploy`, which
that role does not currently hold. Until it is added the step says so loudly and
reports **blank, not clean** — a cost check that silently passes because it has
no permission is worse than no cost check.

### Smaller things found on the way

* **`/aws/rds/instance/reep-postgres/postgresql` has no retention set** — it
  never expires. RDS creates this log group, not CDK, so it is an API call:
  `aws logs put-retention-policy --log-group-name /aws/rds/instance/reep-postgres/postgresql --retention-in-days 30`.
  The same is true of the Lambda log group the voice platform's bucket
  notification handler creates.
* **Fargate memory climbed 16% → 32% over 14 days** on a service with almost no
  traffic. It may be nothing more than caches warming. It is worth one look at
  the next restart; at 1 GB there is plenty of room before it matters.
* **ECR holds 23 images, 4.7 GB**, under a working "keep the last 20" lifecycle
  rule. Fine, and left alone.
* **The archive bucket has no lifecycle rule and `dbDumpArchiveYears` is still a
  placeholder**, exactly as `infra/cdk/reep_core/stack.py` says. Storage is
  negligible today and unbounded by construction; it becomes a real number once
  the college answers the retention question.
