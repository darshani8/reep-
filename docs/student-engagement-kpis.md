# Student engagement KPIs — what REEP records, what it can report, and the workbook that reports it

**Status: shipped 2026-10-10.** `python -m app.kpi_workbook` writes the workbook
described here from a real database; `tests/test_kpi_workbook.py` pins its
shape. Nothing in this document or in that module is an estimate: a number
that cannot be read from a table is not reported, and the one KPI the office
asked for that has no table behind it (most visited pages) is said to be
missing rather than approximated.

The office asked four questions, plus one about the record itself:

| Question | Can REEP answer it today? | From where |
|---|---|---|
| What does the registration form capture about a student? | Yes | `registrations`, `registration_documents` |
| How often do students sign in? | Yes | `login_days`, `login_events`, `users.last_login_at` |
| Which pages do they visit most? | **No — not recorded anywhere** | nothing; see [The page-view gap](#the-page-view-gap) |
| Which functionality do they use most? | Yes, for everything that writes a row | nine tables, one per action (below) |
| What does the student record hold, and is a LinkedIn profile on file? | Yes | `students`, `student_profiles`, the spine |

## Running it — where the data is

```
cd apps/api-py
python -m app.kpi_workbook --out reep-kpis.xlsx            # aggregates only: students are numbered
python -m app.kpi_workbook --out reep-kpis.xlsx --roster   # plus name, USN, college email, LinkedIn URL
python -m app.kpi_workbook --days 90 --out quarter.xlsx    # "recent" = the last 90 days (default 30)
```

It reads `DATABASE_URL` like every other script in `app/` and writes one file.
It is SELECTs only: no row is written, no account is touched, nothing is
deleted, and it is safe on `ENV=prod`. Two things about *where* to run it:

* **Run it against the deployment's data, by somebody who may hold that
  data.** The production database is private to the VPC; the two ways in are
  the ones every other `app.*` script uses — an operator's shell with
  `DATABASE_URL` pointed at it, or a restore of the nightly `pg_dump`
  (`app.backup_database`), which is exactly the artefact that exists so
  questions can be asked of the data without touching the live instance.
* **Never from an agent's session.** Rule 1 applies to agents: a spreadsheet
  of every student's sign-in history and LinkedIn URL is student data, and an
  agent pulling it into its own container to "have a look" is the egress the
  rule exists to stop. The agent's job is the generator and this document;
  the file is the office's to make. (The configured `postgres` MCP server is
  the DEV database on `localhost:5433` and nothing else.)

`--roster` is the only way a name reaches the file. Without it the data
sheets carry a student number, and the KPIs are exactly as true — none of them
needs a name. With it the file is personal data and the log line says so.
Keep it inside the office, like the Exports screen's CSVs.

## What the workbook contains

Ten sheets, Summary first. Every number on a KPI sheet is a formula
(`COUNTIF`, `SUMIF`, `MEDIAN`, `AVERAGE`) over one of the three data sheets, so
filtering or correcting a row on a data sheet moves the KPIs and the charts
with it. Every part-to-whole table has a pie beside it; a table with more than
six categories gets a bar chart instead (a pie past six slices is unreadable,
and a feature share folds the long tail into "Other"). Colours follow the
*position* of a category in its table, never its size, so the same bucket is
the same colour in next month's file.

| Sheet | What is on it |
|---|---|
| **Summary** | The headline numbers, each a link into its sheet; the file's provenance (when, which database, which window); whether it names people. |
| **Sign-ins** | Active today / this week / in the window; active share; stickiness; never-signed-in; sign-in days per active student; frequency buckets (pie); recency buckets (pie); streaks; door (pie); device (pie); weekday and hour-of-day bars. |
| **Registration** | Applications all time and in the window; approval rate; rule-approved share; queue depth and oldest waiting; median hours to a decision; dual specialization; repeat applications; status (pie); per month (bar); what each application came with (bar); department mix (pie, top five + Other). |
| **Functionality** | Per feature: uses in the window and all time, students using it, adoption, uses per user, the screen; share of use (pie, top five + Other); engaged students and features per engaged student; mock-interview completion. |
| **Profile & LinkedIn** | LinkedIn box status (pie): personal profile / other LinkedIn page / short link / not a LinkedIn link / missing; usable-link and personal-profile shares; completeness bands (pie); the twelve fields on file (bar); stage (pie); seated, mentored, Google linked, password set, placement eligible, interests, marks and attendance imported, disabled; graduates and removed accounts left out of the denominators. |
| **Page views (not recorded)** | Why there is no page-view KPI and what it would take to have one. |
| **Definitions** | Every KPI's definition, source table and caveat. |
| **Data - Students** | One row per current student (`students.status = ACTIVE`, account not removed): stage, batch, spine, roster flags, sign-in counts and buckets, streaks, profile fields, LinkedIn status, per-feature counts. |
| **Data - Registrations** | One row per application: submitted, month, status, decided at, hours to decision, days waiting, spine, which boxes and files were present, repeat, became a student. |
| **Data - Sign-ins** | One row per successful sign-in inside the window: when (programme time), weekday, hour, door, device family. |

## The KPIs, by question

### 1. What registration captures

`/register` has required every box since 2026-09-16 (USN, phone, personal
email, LinkedIn) and both files since 2026-09-22 (CV, photo), so the
*completeness* KPIs mostly measure the backlog of older applications; the
*throughput* KPIs are the live ones.

| KPI | Definition | Source |
|---|---|---|
| Applications received | rows, all time and inside the window | `registrations.created_at` |
| By status | Waiting for review / On hold / Approved by rule / Approved by the office / Rejected | `registrations.status` (`PENDING_QUEUE_STATUSES` is the queue) |
| Approval rate | approved (rule or office) ÷ decided (approved + rejected) | `status` |
| Rule-approved share | `AUTO_APPROVED` ÷ approved | `status`, `matched_rule_id` |
| Waiting on the office | `PENDING_REVIEW` + `HOLD` | `status` |
| Oldest waiting | days since the oldest pending row was submitted | `created_at` |
| Median hours to a decision | `reviewed_at − created_at`; a rule decision is 0 h | `reviewed_at`, `created_at` |
| Applications per month | the last twelve months, by submit date | `created_at` |
| What each came with | share carrying USN, phone, personal email, LinkedIn, CV, photo | the four columns + `registration_documents.kind` |
| By department / dual / repeat | the mix the applicants named; two specializations; the same address applying again | `department_id`, `second_specialization_id`, `email` |
| Became a student | approved rows that were provisioned | `approved_student_id` |

### 2. How often students sign in

Two tables already record this and nobody was reading them for the office.
`login_days` is one row per student per **local calendar day** (it feeds the
streak on the student's own home screen), `login_events` is one row per
successful sign-in with the door and the browser (it feeds "Recent sign-ins"
on My account). Failed attempts are deliberately not recorded anywhere a
report can read, so there is no "failed logins" KPI and should not be.

| KPI | Definition | Source |
|---|---|---|
| Current students | the denominator everywhere: `status = ACTIVE`, `deleted_at IS NULL` | `students`, `users` |
| Daily / weekly / active | last sign-in day = today / ≤ 7 days ago / ≥ 1 sign-in day inside the window | `login_days` |
| Active share, stickiness | active ÷ current; daily ÷ active | derived |
| Never signed in | no `login_days` row and no `last_login_at` | `login_days`, `users.last_login_at` |
| Sign-in frequency | distinct days in the window, bucketed: none / 1–2 / 3–7 / 8–15 / 16+ | `login_days` |
| Sign-in recency | days since the last sign-in day: today / ≤ 7 / 8–30 / 31–90 (dormant) / 90+ (lost) / never | `login_days` |
| Streaks | consecutive days, counted exactly as `GET /api/student/streak` counts them | `login_days` |
| Door | Password / Emailed code / Google / Activation link | `login_events.door` |
| Device | Android / iPhone-iPad / Windows / Mac / other, coarse, from the User-Agent | `login_events.user_agent` |
| Weekday, hour of day | when students come, in the programme's zone (Asia/Kolkata by default) | `login_events.at` |

### 3. Most visited pages — see the gap below. Not reported.

### 4. Most used functionality

Counted from the rows each action writes, which is the honest substitute for
page views: it says what students *did*, not what they looked at. Each row of
the table is a `Feature` in `app/kpi_workbook.py`, naming its screen (pinned
to `app.routes.ts` by a test, so a KPI cannot name a screen that was deleted)
and its table.

| Feature | Screen | One use is |
|---|---|---|
| Mock interview | `/student/assistant` (and the dock) | an `interview_sessions` row; completion = `status = completed` |
| REEP Agent (typed assistant) | `/student/agent` (and the orb) | an `agent_runs` row with `role = STUDENT` |
| Time allocation ledger | `/student/time-log` | a `time_ledger_days` row (a day saved) |
| Uploads | `/student/uploads` | an `uploads` row |
| Skilling badge claim | `/student/skilling` | a `badge_evidence` row |
| Resume builder | `/student/resume` | a `resumes` row |
| Job application | `/student/jobs` | a `job_applications` row |
| English baseline | `/student/english` | an `english_baselines` row |
| SWOC line acknowledged | `/student/mentor-log` | `swoc_entries.acknowledged_at` stamped |

Per feature: uses in the window and all time, students using it (window and
ever), **adoption** (ever used ÷ current students), uses per user; across
features: students who used anything in the window, and distinct features per
engaged student. Staff-entered records (`mock_attempts`, mentor notes) are not
student usage and are not counted; a student's profile edit is reported as a
flag on the Profile sheet rather than as a feature, because the row keeps only
its latest `updated_at`.

### 5. The student record, and the LinkedIn profile

| KPI | Definition | Source |
|---|---|---|
| LinkedIn status | what the box holds: **personal profile** (`linkedin.com/in/<handle>`), another LinkedIn page (company, school, post), a `lnkd.in` short link, not a LinkedIn link at all, or missing | `student_profiles.linkedin_url` |
| Usable link, personal profile | the first three statuses ÷ current; personal ÷ current | derived |
| Profile completeness | filled ÷ 12: phone, contact email, LinkedIn, GitHub, portfolio, city, career summary, education, experience, projects, skills, photo; bands at 90 / 60 / 30 % | `student_profiles` |
| Fields on file | share of students with each of the twelve | `student_profiles` |
| Stage | Reboot / Excel / Excel Advanced / Elevate | `students.current_stage` |
| Roster facts | seated in a batch, faculty mentor assigned, Google linked, password set, placement eligible, interested in jobs / internships, marks imported, attendance imported, disabled | `students`, `users`, `student_profiles`, `semester_results`, `attendance_records` |

The LinkedIn check is a **format** check. The classifier applies the same host
rule the register form's validator applies (any `linkedin.com` subdomain, or
`lnkd.in`) and then asks whether the path is `/in/<handle>`; it does not open
the link. Opening it would send every student's URL to LinkedIn from the
server, LinkedIn answers automated requests with a 999, and the question the
office actually has — "does this student have a profile we can put in front of
a recruiter" — is answered by the shape. With `--roster` the Data - Students
sheet lists the URL beside the status, which is the office's follow-up list.

## The page-view gap

Nothing in REEP records which screens a student opens:

* the sign-in tables say a student came in, not where they went;
* a screen that only reads — Leaderboards, Jobs, Records, Courses, the
  Faculty / TPO Log, Profile — writes no row when it is opened;
* the API's request log is CloudWatch for 30 days with no per-route counter,
  and the browser sends no analytics beacon (rule 1: nothing about a student
  leaves the machine unbidden, and third-party analytics is exactly that).

So "most visited pages" cannot be reported today, and the workbook does not
pretend to. What it would take, if the office wants it, is a product change
and a human-reviewed one (a migration and a deletion verdict are on the
release gate's list):

1. **A `page_views` table**: `user_id` (FK `users`, `ON DELETE CASCADE`),
   `role`, the **route pattern** (`student/jobs`, never the full URL — the
   query string on `/onboard`, `/reset` and `/activate` is a token), and `at`.
   No request body, no referer, no IP.
2. **One endpoint**, `POST /api/usage/page-views`, taking a small batch for
   the signed-in session; the Angular shell posts on each route change with
   `navigator.sendBeacon` so a closing tab still reports. Any signed-in role;
   no capability, because it records only the caller's own screens.
3. **Lifecycle**: the nightly sweep deletes rows older than 180 days
   (`interview_sessions`' clock, and `tests/test_codebase_guards.py` §35 must
   be told about the new table on retention's import surface); `EMPTY` in
   `purge_people.VERDICTS`, by user in `purge_students.STUDENT_VERDICTS`;
   CASCADE carries it through the account walk.
4. **Then the KPI**: views per screen, unique students per screen, screens per
   sign-in — a table and a bar chart, not a pie, because a dozen screens is
   too many slices.

## Deliberately not done

* **No sample data, anywhere.** The generator has no synthetic mode and the
  documentation carries no illustrative numbers. The tests build their rows by
  hand and read the seeded dev database where there is one.
* **No console screen.** The office already has an Analytics screen with its
  own KPI strip (`GET /api/admin/analytics/kpis`: placement rate, CTC,
  readiness, attendance, pending approvals). This workbook answers a different
  set of questions and is a file the office takes away; putting these numbers
  on a screen is a separate decision about what the screen is for.
* **No page-view capture** — see above; it is a migration and a verdict in
  three destructors, and it needs a human to decide whether a college wants
  its students' screen visits recorded at all.
* **No Ops-task menu entry.** The Ops task menu is a fixed list and a task
  needs somewhere to put a file; an S3 prefix for office reports is a decision
  about retention and access that this change does not make. Until then the
  file is made where the data is, by the two routes under "Running it".
