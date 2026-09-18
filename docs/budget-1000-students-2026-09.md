# Budget: 1,000 students, two mock interviews a day (2026-09-18, rechecked)

Prepared for the board. Every number here is one of two things: read from the
live AWS account `445363794125` on 2026-09-18 (Cost Explorer with credits
excluded, CloudWatch, Service Quotas, the API's own log, the running ECS/RDS
resources), or computed by `tools/cost/budget_1000_students.py` from unit
prices that account was **actually billed** on 2026-09-16. Rupee figures use
₹96 per US dollar (95.96 on 18 Sep 2026) and include 18% GST. What changed
when this document was rechecked, and the one measurement still worth making
before the budget is approved, are in §7.

## 1. The answer

| | 2 a day on working days (22 a month) | 2 a day, every day (30 a month) |
|---|---:|---:|
| Interviews a month | 44,000 | 60,000 |
| AWS bill before GST | $4,167 | $5,589 |
| With 18% GST | $4,917 | $6,595 |
| **Per month** | **₹4.7 lakh** | **₹6.3 lakh** |
| **Per year** | **₹57 lakh** | **₹76 lakh** |
| Per student, per month | ₹472 | ₹633 |
| Range, low to high case (§5) | ₹3.9 – ₹5.9 lakh a month | ₹5.2 – ₹7.9 lakh a month |

Four things to take away.

1. **The platform is cheap.** Web, API, database, backups, security and
   monitoring bill about **$180 a month** at list price today, and need only
   about **$50 a month** more to carry 1,000 students (a bigger database
   instance and a few extra API tasks during interview hours).
2. **The interviews are the cost.** One 8-minute interview costs about
   **₹8.5** (₹6.9 to ₹10.8 depending on how much each side talks), and 91% of
   that is the Amazon Nova 2 Sonic speech model. The one test session on this
   account that ran the full 8 minutes billed ₹5.5, with the tester speaking
   for only a minute. Two a day for 1,000 students on working days is 44,000
   interviews a month; that is where the ₹4.7 lakh comes from, and the bill
   moves in a straight line with the count.
3. **₹50,000 to ₹70,000 a month is a real budget for a smaller programme, not
   for two a day.** After the fixed platform and GST it buys about **2,000 to
   4,000 interviews a month** — roughly one interview per student every week or
   two (§6 has the table). Two a day for everyone cannot be bought for that at
   any measured price. If the same figure was meant in US dollars a year, both
   scenarios land inside it: $50,000 a year on working days, $67,000 every day,
   before GST.
4. **Money is not the only gate; a quota is.** AWS currently allows this
   account **2 simultaneous Nova 2 Sonic interviews** in Tokyo, where the model
   runs (AWS's own default is 20; this account was issued a reduced
   allocation, re-read on 18 Sep, with no increase request on file). The plan
   needs 60–100 simultaneous interviews at peak. The increase request should go
   in this week, and the ramp it implies is in §8.

## 2. What is deployed today

Angular 22 single-page app, FastAPI back end, PostgreSQL 17 — on AWS in
Mumbai (`ap-south-1`), described by AWS CDK (`infra/cdk/`), deployed from GitHub
Actions. Backup copies go to Singapore (`ap-southeast-1`); the speech model is
reached in Tokyo (`ap-northeast-1`) because it is not offered in Mumbai.

| Layer | Service (as deployed) | What it does | Measured cost today, $/month |
|---|---|---|---:|
| Edge | **CloudFront** distribution `reep.sast-skills.com` (price class 200) + **AWS WAF** web ACL `reep-edge` (managed rule sets) | Serves the app, proxies `/api/*` to the load balancer, filters attacks | 0 (free tier) + 8.2 |
| Web | **S3** bucket for the built app; S3 bucket for load-balancer logs | Static hosting | < 0.5 |
| Ingress | **Application Load Balancer** `reep-alb` | Routes to the API tasks; carries the interview WebSockets | 17.5 |
| Compute | **ECS Fargate** cluster `reep`, service `api`: 2 tasks × (0.5 vCPU, 1 GB), **ARM64 Graviton**, autoscaling 2–10 on CPU/memory | The FastAPI application, including the in-process interview relay | 21.5 |
| Network | 1 **NAT gateway** + 3 public IPv4 addresses | Egress for the private subnets (Bedrock, Google sign-in, SES) | 40.9 + 13.6 data + 10.9 |
| Database | **RDS PostgreSQL 17.9** `reep-postgres`, `db.t4g.micro`, **Multi-AZ**, 20 GB gp3 (autogrows to 100 GB), 35-day automated backups, Performance Insights | The system of record: 111 tables | 30.7 + 5.3 storage + 4.4 backups |
| Files | **EFS** (uploads, signatures, interview audio; 20 MB today; moves to Infrequent Access after 30 days) | Student documents and any recordings | ≈ 0 |
| Backup | **AWS Backup**: daily plan (database + EFS) with a copy to the Singapore vault, monthly archive plan (365 days), weekly restore test | Disaster recovery | 3.6 + 6.4 copy transfer |
| Archives | **S3**: `reep-db-dumps` (90-day `pg_dump`), `reep-db-archive` (monthly, Object Lock), `reep-documents-archive` (every uploaded file, Object Lock, never deleted), `reep-identity-ledger` (daily account ledger, Object Lock) | Portable copies that outlive the schema | < 0.5 |
| AI, interviews | **Amazon Bedrock — Nova 2 Sonic** (`amazon.nova-2-sonic-v1:0`, Tokyo) | The speech-to-speech mock interviewer | usage: $1.05 so far in September |
| AI, text | **Amazon Bedrock — Nova Pro** (APAC inference profile, Mumbai) | The REEP Agent chat and the resume builder | usage: $0.005 so far |
| Mail | **Amazon SES**, `no-reply@sast-skills.com`, configuration set `reep-transactional`, production access | Onboarding, reset, leave, badge mail | $0.16 per 1,000 messages |
| Secrets & config | **Secrets Manager** (2 secrets), **SSM Parameter Store** | Credentials, platform parameters | 0.85 |
| Monitoring | **CloudWatch**: 16 alarms, custom metrics, 4 log groups at 30-day retention; **Sentry** (3 projects, external; plan not verified — Developer is $0, Team $26/month) | Alerts and error tracking | 12.0 + Sentry |
| Scheduled jobs | ECS scheduled tasks: identity ledger 23:30, database dump 01:00, document archive 02:00, retention sweep 03:00 IST | Nightly hygiene and backups | inside the Fargate line |
| Voice platform | CDK stack `reep-voice-platform`: 2 **DynamoDB** tables, 4 **SQS** queues, 2 **Lambda** functions, 2 S3 buckets | The dual-path platform ingest; idle today (the OpenSearch collection was removed on 15 Sep) | ≈ 0 |
| Identity | **Google Sign-In** (Google Cloud OAuth client) | Login for every role | 0 |
| Delivery | **GitHub** (repository, Actions: 5 CI jobs, deploy, daily infra-drift check) | Build and deploy | within the free allowance |

DNS for `sast-skills.com` is hosted outside AWS (no Route 53 charge). There is
no AWS Support plan on the account.

## 3. What it bills today

Read from Cost Explorer with `RECORD_TYPE=Usage`, so the promotional credits do
not hide anything.

| | Gross usage | Credits applied | GST | Paid |
|---|---:|---:|---:|---:|
| August 2026 (first days live) | $21.07 | −$21.07 | $0 | $0 |
| 1–17 September 2026 | $204.37 | −$138.94 | $11.78 | $77.21 |

Of September's $204, **$118 was the OpenSearch collection** that nothing read; it
was removed on 15 September (`docs/cost-review-2026-09.md`). The run rate since
is what matters:

| Day | Gross usage |
|---|---:|
| 14 Sep (OpenSearch still up, backup charge day) | $18.73 |
| 15 Sep (removed 16:12 UTC) | $14.24 |
| **16 Sep — first clean day** | **$6.20** |

The 16 September day, item by item, is the basis of the fixed-platform line in
every scenario below: **$5.91/day ≈ $180/month** at list price, plus that
day's interview testing ($0.26) and Cost Explorer queries ($0.17). Credits
covered 68% of September; the budget assumes they are gone, because the expiry
date is not readable through the API and must be checked under Billing → Credits.

The load this carries today: 11,814 requests to the load balancer in 14 days,
API CPU under 2%, database CPU under 5%, and — from the API's own log — 28
interview sessions between 15 and 17 September, all of them tests or the Main
Admin's rehearsals, one of which ran to the 8-minute cap.

## 4. The load

| | |
|---|---:|
| Students | 1,000 |
| Interviews per student per day | 2 |
| Length of an interview | 8 minutes (Bedrock closes the stream at 8:00; the engine forces the wrap-up 90 s before) |
| Interview-minutes per day | 16,000 |
| Interviews per month | 44,000 on 22 working days; 60,000 every day |
| Average simultaneous interviews, 12-hour window | 22 |
| Peak simultaneous interviews (3× average) | 60–80 |

"Two a day for every student" is a ceiling, not a forecast: it assumes every
student uses both slots every day. The product already caps a student at 8
completed interviews and 20 attempts in a rolling 24 hours
(`interview_max_per_student_per_day`,
`interview_max_attempts_per_student_per_day`), and a college can set its own
`daily_cap` per course on the Interview records screen. Setting that to the
number the board approves is how a budget becomes a ceiling the software
enforces rather than a hope; §6 prices the levels between one a week and two a
day.

## 5. What one interview costs

Unit prices are the ones billed to this account on 16 September (Tokyo prices
for Nova 2 Sonic: $3.63 per million speech-input tokens, $14.52 per million
speech-output tokens, $0.396 / $3.311 per million text tokens — 21% above the
US list of $3 / $12). AWS tokenises audio at **25 tokens per second**, bills
input speech only while the student is actually speaking, and counts the prompt
once per session — all three read off this account's own sessions (§7). The
central case is a real interview: the student speaks for about 50% of the
8 minutes (240 s) and the interviewer's generated speech is billed for 30%
(144 s; Nova generates ahead of playback, so a student who interrupts is billed
for a little audio never heard).

| Item | Basis | USD | INR |
|---|---|---:|---:|
| Nova speech output | 144 s × 25 = 3,600 tokens × $14.52/M | 0.0523 | 5.02 |
| Nova speech input | 240 s × 25 = 6,000 tokens × $3.63/M | 0.0218 | 2.09 |
| Nova text input (the prompt, transcripts, control notes) | 4,000 tokens × $0.396/M | 0.0016 | 0.15 |
| Nova text output (speech transcripts, the scorecard) | 1,600 tokens × $3.311/M | 0.0053 | 0.51 |
| Mic audio through CloudFront to the API | 23 MB × $0.16/GB (India, viewer to origin) | 0.0037 | 0.35 |
| Audio to and from Tokyo through the NAT gateway | 30 MB × $0.056/GB + 20.5 MB × $0.086/GB inter-region | 0.0034 | 0.33 |
| Load balancer capacity units, CloudWatch logs | | 0.0006 | 0.06 |
| **Per interview, central case** | | **0.0886** | **8.5** |

| Case | What it assumes | Per interview |
|---|---|---:|
| Measured | The 17 Sep session that ran to the cap: tester spoke 60 s, interviewer 130 s, 2,979 / 1,025 text tokens | $0.057 · ₹5.5 |
| Low | Short answers: student 35%, interviewer 25% | $0.072 · ₹6.9 |
| **Central** | **Student 50%, interviewer 30%** | **$0.089 · ₹8.5** |
| High | Both sides talkative: student 60%, interviewer 40% | $0.112 · ₹10.8 |

The interviewer's audio back to the browser stays inside CloudFront's free 1 TB
a month even at 60,000 interviews, so it is not a line.

## 6. The budget

Output of `python tools/cost/budget_1000_students.py`, central case, before
GST, per month.

| Line | A. 2 a day, working days | B. 2 a day, every day |
|---|---:|---:|
| Today's platform (measured) | $180 | $180 |
| Database step-up to `db.t4g.small` Multi-AZ | $31 | $31 |
| API scale-out in interview hours (avg +3 tasks × 12 h) | $12 | $16 |
| Database storage growth | $5 | $5 |
| **Nova 2 Sonic interviews** | **$3,561** | **$4,856** |
| Network and logs for interviews | $338 | $461 |
| REEP Agent (Nova Pro, 10 questions per student a month) | $39 | $39 |
| Mail | $2 | $2 |
| **Total before GST** | **$4,167** | **$5,589** |
| GST 18% | $750 | $1,006 |
| **Per month, INR** | **₹4.72 lakh** | **₹6.33 lakh** |
| **Per year, INR** | **₹57 lakh** | **₹76 lakh** |

Where the money goes in scenario A: Nova 85%, network 8%, the platform 6%.

The bill scales with the interview count, not the student count:

| Interviews a month | What it corresponds to | Before GST | Per month incl. GST | Per year, USD |
|---:|---|---:|---:|---:|
| 2,000 | a pilot: 100 students, 1 a day | $445 | ₹0.50 lakh | $5.3k |
| 4,300 | 1,000 students, 1 a week | $649 | ₹0.74 lakh | $7.8k |
| 8,600 | 1,000 students, 2 a week | $1,030 | ₹1.17 lakh | $12.4k |
| 22,000 | 1,000 students, 1 a day on working days | $2,218 | ₹2.51 lakh | $26.6k |
| 44,000 | 1,000 students, 2 a day on working days | $4,167 | ₹4.72 lakh | $50.0k |
| 60,000 | 1,000 students, 2 a day, every day | $5,589 | ₹6.33 lakh | $67.1k |

Read the other way, what a monthly budget buys (central case, after the
$268/month of fixed platform, agent and mail, and after GST):

| Budget a month | Before GST | Interviews a month | Per student |
|---:|---:|---:|---|
| ₹50,000 | $441 | 2,000 | 0.5 a week |
| ₹70,000 | $618 | 3,950 | 0.9 a week |
| ₹1 lakh | $883 | 6,900 | 1.6 a week |
| ₹2 lakh | $1,766 | 16,900 | 3.9 a week |
| ₹5 lakh | $4,414 | 46,800 | 2 a day on working days |

Variants, before GST:

| Variant | Total | Change |
|---|---:|---:|
| A, low case | $3,416 | −$751 |
| A, high case | $5,210 | +$1,043 |
| B, low case | $4,566 | −$1,023 |
| B, high case | $7,011 | +$1,422 |
| B with **voice recording switched on** (see §8) | $9,558 | +$3,969, and growing every month |
| A with Nova billed at US-region prices (run the model in N. Virginia) | $3,602 | −$565, at ~120 ms more latency |
| A with 6-minute interviews instead of 8 | $3,272 | −$895 |

## 7. How this reconciles with the real bill

**The unit prices are the account's own.** Every price in the model's first
block is the `cost ÷ quantity` of a usage line on the 16 September bill:
`APS3-NatGateway-Hours` $0.056, `APS3-Multi-AZUsage:db.t4g.micro` $0.042,
`APS3-Fargate-ARM-vCPU-Hours` $0.02383, `APS3-LoadBalancerUsage` $0.0239,
`APN1-NovaSonic2.0-speech-output-tokens` $0.01452 per thousand, and so on.
Items the deployment does not buy yet (the bigger database, EFS at scale, backup
storage for recordings) come from the AWS price list for Mumbai and Singapore and
are marked "list" in the script.

**The fixed platform reproduces the bill.** The model's $5.91/day against the
real $6.20 clean day; the difference is the day's interview testing and the
Cost Explorer calls made for this document. (17 September, the next day, closed
at $3.39 in Cost Explorer because the day was still settling when it was read.)

**A full-length session has been billed, and the model is built on it.** The
API log (`/reep/api`) records every interview's close with its turn count and
the bytes of microphone audio it received. Between 15 and 17 September it
holds 28 sessions — tests and the Main Admin's rehearsals, most abandoned in
the opening phase — and one, on 17 September at 08:40 UTC, that ran to the
8-minute cap. CloudWatch's one-minute Bedrock metrics show that session's bill
by itself: **1,509 input speech tokens (60 s of speech), 3,252 output speech
tokens (130 s), 2,979 text-input and 1,025 text-output tokens — $0.057, ₹5.5.**
Three facts follow. Silence is not billed: the session streamed 343 s of
microphone audio and paid for 60 s of speech. The prompt is counted once per
session, not once per turn, so text is ₹0.7 of an interview and not more. And
the interviewer took 27% of the session, which is where the central case's 30%
comes from; the tester's one minute of talking is what a real student's four
minutes replaces.

**The token rate reproduces September as a whole.** At 25 tokens a second, the
24,999 speech-input and 59,860 speech-output tokens billed from 1 to 17
September are 17 minutes of student speech and 40 minutes of interviewer speech
across the test sessions — consistent with the per-day audio the log shows
(14 minutes of microphone stream on 16 September against 4 minutes of billed
input speech). The earlier note in `docs/cost-review-2026-09.md` ("$0.06 per
interview") was the cost of a test session in which the tester barely spoke;
that figure is real, and it is the floor, not the expectation, for a student who
actually answers.

**What changed on recheck.** The first version of this document put the
interviewer at 50% of the session and derived text tokens from a ratio measured
on the short test sessions; the second version counted the prompt once per
turn. The measured full-length session corrected both: interviewer 30%, prompt
once per session. The per-interview figure moved from ₹12.7 to ₹8.5 (range
₹6.9–10.8), the working-day scenario from ₹6.9 lakh to ₹4.7 lakh a month, and
the every-day scenario from ₹9.3 lakh to ₹6.3 lakh. The unit prices, the quota
finding and the recording arithmetic did not change. One label was also
corrected: one interview a day on working days is 22,000 a month, not 20,000.

**What is still worth measuring: a student who talks.** The remaining
assumption is how long a real student speaks. Run 20–30 students through full
interviews on one day; the next day Cost Explorer shows that day's four
`APN1-NovaSonic2.0-*` lines; divide by the count. Put the measured split into
`CASES["central"]` in the script and re-run. If the measured cost lands between
₹6.9 and ₹10.8 an interview, this document stands as written.

## 8. What gates the plan

1. **The Nova 2 Sonic concurrency quota — the real blocker.** Service Quotas
   shows this account's applied value for "On-demand InvokeModel concurrent
   requests for Amazon Nova 2 Sonic" as **2** in Tokyo, N. Virginia and Oregon,
   against an AWS default of **20**; Stockholm shows 20, and the older Nova
   Sonic (v1) shows 20 in Tokyo. No increase request is on file. Two
   simultaneous streams is about 15 interviews an hour, roughly 180 a day in a
   12-hour window; the plan needs 60–100 at peak. The quota is marked "not
   adjustable" in the console but AWS's documentation says a request can still
   be made through the limit-increase form, that on-demand model quotas go
   through the account manager, and that **priority is given to accounts
   already consuming their allocation**. So the ramp is: file the request now
   for 100; run the pilot at full utilisation of whatever is granted; ask again
   with the usage graph attached. Interim capacity if the request stalls:
   `NOVA_SONIC_MODEL=amazon.nova-sonic-v1:0` (quota 20 in Tokyo today, same
   API, same price class) or `NOVA_SONIC_REGION=eu-north-1` (quota 20, roughly
   150 ms more round trip).
2. **The credits.** 68% of September's usage was paid by promotional credits
   whose balance and expiry the API does not expose. Read them in the console
   before the meeting; the day they run out the bill lands at gross.
3. **Recording stays off.** The operator switch is on
   (`INTERVIEW_RECORDING_ENABLED=true` in the task definition) and no college
   policy row has "Allow voice recording" ticked, so nothing is recorded today.
   Ticking it at 60,000 interviews a month writes 2.8 TB of WAV a month: 180
   days on EFS, backed up daily to Mumbai and copied to Singapore, and archived
   to an Object-Locked S3 bucket that never deletes. That is the recording
   variant in §6: **+₹4.5 lakh a month in year one and rising** by about
   ₹7,000 a month every month after. It is a policy decision with a price, and
   the price should be in front of whoever makes it.
4. **A budget alarm that can see gross spend.** The only budget on the account
   is AWS's default $1 zero-spend budget, which tracks net-of-credits and could
   not see the $361-a-month collection. `docs/cost-review-2026-09.md` §2 has the
   one command that creates a gross budget with a forecast alert; set it to the
   scenario the board approves.
5. **A load test before the first cohort.** The API relays 24 kHz audio in
   process; 100 sessions per worker is a cap in `config.py`, not a measured
   capacity. Autoscaling to 10 tasks (`apiMaxTasks`) is budgeted; whether 60
   concurrent interviews fit in fewer tasks is a test, not an assumption.
6. **The cap in policy.** Set `daily_cap` on the college's interview policy to
   the approved number so it is enforced. The attempt cap (20) still counts
   every session that opened a Bedrock stream, which is what bounds spend from a
   student who keeps reconnecting.

## 9. Levers the board can pull

| Lever | Effect on scenario A (₹4.7 lakh/month) | Cost of pulling it |
|---|---:|---|
| Two interviews a **week** instead of a day | ₹1.2 lakh/month | Less practice per student |
| One interview a week | ₹0.75 lakh/month | Roughly the ₹70,000 budget, platform included |
| 6-minute interviews | −21% | A shorter arc; the wrap-up still needs 90 s |
| Run Nova at US-region prices | −14% | ~120 ms more latency on every turn; the quota is 2 there too |
| Negotiate with the AWS account team | unknown | Nova 2 Sonic has no reserved tier; at ~$43k a year of Bedrock spend a private pricing conversation is normal |
| Trim the fixed platform (NAT instance, Single-AZ database) | −₹4,000/month at most | Not worth it at this scale; the `t4g.nano` NAT instance in the cost review cannot carry 60 concurrent streams (32 Mbps baseline against ~50 Mbps needed) |

## 10. Assumptions and sources

Assumptions, all named in `tools/cost/budget_1000_students.py`: 8-minute
sessions; a central case of student 50% / interviewer 30% with 4,000 / 1,600
text tokens a session, a low case (35% / 25%) and a high case (60% / 40%);
25 audio tokens a second; 3 extra API tasks for 12 hours a day; 0.5 MB of logs
per interview; 10 REEP Agent questions per student a month; recordings of 46 MB
per interview (two 24 kHz 16-bit tracks padded to 480 s), 180-day retention,
EFS Infrequent Access after 30 days; ₹96 per dollar; 18% GST.

Sources read on 2026-09-18: AWS Cost Explorer (`GetCostAndUsage`, RECORD_TYPE
Usage/Credit/Tax, by service and by usage type); CloudWatch `AWS/Bedrock`
metrics for `amazon.nova-2-sonic-v1:0` in `ap-northeast-1` at one-minute
resolution; the API log group `/reep/api` (CloudWatch Logs Insights, the
"Interview ended" lines of 15–17 September); Service Quotas
(`GetServiceQuota`, `GetAWSDefaultServiceQuota`,
`ListRequestedServiceQuotaChangeHistory`) in five regions; ECS, RDS, EC2, EFS,
S3, CloudFront, WAF, Budgets and Backup describe calls; the AWS Price List API
for Mumbai and Singapore; the
[Amazon Nova quotas page](https://docs.aws.amazon.com/nova/latest/nova2-userguide/quotas.html);
the [Nova 2 Sonic model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-sonic.html)
(regions, no reserved tier); the [Nova 2 Sonic output-events page](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-output-events.html)
(usage events, faster-than-real-time generation); the 25-tokens-per-second rate
from the AWS Builders community's
[published Nova Sonic cost arithmetic](https://dev.to/aws-builders/bi-directional-voice-controlled-recipe-assistant-with-nova-sonic-v2-4p59);
US list prices for Nova 2 Sonic from [llm-stats](https://llm-stats.com/models/nova-2-sonic);
the exchange rate from [open.er-api.com](https://open.er-api.com/v6/latest/USD)
(95.96 on 18 Sep 2026) and [exchangerates.org.uk](https://www.exchangerates.org.uk/USD-INR-spot-exchange-rates-history-2026.html);
and `docs/cost-review-2026-09.md` for the September clean-up.
