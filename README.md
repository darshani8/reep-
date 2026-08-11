# REEP Tracking Dashboard

Student journey, time usage, faculty-mentor focus tracking, cohort analytics and
an evidence-grounded AI resume builder for the **BGSCET MBA — Reboot, Excel,
Elevate Programme**.

Built from `REEP Dashboard Mockups.pdf` (wireframes v1), implementing all seven
sections of that document plus two additions requested afterwards: an AI resume
builder, and analytics over the time-filled data.

---

## Quick start

```bash
# 1. Postgres (Docker Desktop must be running)
npm run db:up

# 2. Install + generate the Prisma client
npm install

# 3. Schema + seed data
npx prisma migrate deploy
npm run db:seed

# 4. Run
npm run dev        # http://localhost:3100
```

The database container binds host port **5433**, not 5432, so it never collides
with a PostgreSQL service already installed on the machine.

### Sign in

Password for every seeded account is `reep2026`.

| Role | Email | What it shows |
|---|---|---|
| Student (on track) | `ananya.r@bgscet.ac.in` | A healthy journey — ~7 completed certifications |
| Student (at risk) | `aditi.k@bgscet.ac.in` | Disengagement: short abandoned lab sessions, overdue certs |
| Faculty Mentor | `rakesh.iyer@bgscet.ac.in` | 12 mentees in group MBA-2026-B |
| Program Director | `s.manjunath@bgscet.ac.in` | 3 cohorts, 46 students, cross-cohort analytics |

---

## Screens

| # | Route | Screen |
|---|---|---|
| 1 | `/student` | REEP Journey Home — stage rail, dimensions, current courses, upcoming |
| 2 | `/student/certifications` | Certification Tracker with stage filters and pace status |
| 3 | `/student/time-log` | Time Usage Log, lab check-in/out, and the time analytics |
| — | `/student/courses` | Per-course detail grouped by stage |
| — | `/student/profile` | Account + the profile data that feeds the resume builder |
| ★ | `/student/uploads` | **Uploads** — certificate proof, CV, photo, documents |
| ★ | `/student/resume` | **AI Resume Builder** |
| ★ | `/student/assistant` | **REEP Agent** — own record only |
| 4 | `/mentor` | Cohort Overview — roster, at-risk flags, alert strip |
| 5 | `/mentor/student/[id]` | Student Detail & Focus Tracking |
| — | `/mentor/alerts` | Alert queue with rule context and resolution |
| ★ | `/mentor/uploads` | **Verification queue** for uploaded certificate proof |
| — | `/mentor/reports` | Printable cohort report + CSV export |
| — | `/mentor/settings` | **Admin-configurable alert thresholds**, per cohort |
| ★ | `/mentor/assistant` | **REEP Agent** — any student, plus mentor notes |
| 6 | `/director` | Cohort Analytics — bottlenecks, at-risk trend |
| — | `/director/courses` | Course-level completion across the programme |
| — | `/director/certifications` | Certification completion rates |
| — | `/director/placement` | **Configurable placement-readiness composite** |
| — | `/director/mentors` | Mentor assignment — filter, pick (or pick at random), assign or split evenly |
| ★ | `/director/assistant` | **REEP Agent** — any student, plus programme analytics |
| — | `/director/exports` | Every table as .xlsx / .json / per-table .csv, scoped to a cohort |
| — | `/director/student/[id]` | One student's full record — printable, and downloadable in all four formats |

---

## Architecture

The UI is **Material UI v9** with **MUI X DataGrid** and **MUI X Charts** — one
community library rather than hand-rolled components, so the grid gets sorting,
filtering, pagination and CSV export for free and every screen looks the same.

```
src/
├─ theme.ts                  the whole visual language: palette, type, component defaults
├─ app/                      routes (App Router, server components by default)
│  ├─ login/                 credential sign-in
│  ├─ student/ mentor/ director/
│  └─ api/                   uploads, check-in, provider sync, alert scan, resume
├─ components/
│  ├─ kit.tsx                PageIntro, SectionCard, StatCard, ProgressMeter,
│  │                         MeterRow, StatusChip, EmptyState, TechNote, Fact
│  ├─ reep-grid.tsx          ReepGrid — the one data grid, used by every table
│  ├─ reep-charts.tsx        every chart, with mark specs fixed in one place
│  ├─ app-shell.tsx          responsive drawer, top bar, theme toggle
│  └─ link-behaviour.tsx     wires MUI buttons to the Next router
└─ lib/
   ├─ db.ts                  Prisma singleton
   ├─ auth.ts                scrypt passwords, JWT session, role guards
   ├─ progress.ts            THE PROGRESS FORMULAS  (stage %, dimensions, pace)
   ├─ analytics.ts           THE TIME ANALYTICS     (focus, streaks, forecast)
   ├─ rules.ts               THE ALERT ENGINE       (evaluate + scan + reconcile)
   ├─ activity-rules.ts      THE TIME-ENTRY RULES   (window, standing, backdating)
   ├─ activity-log.ts        the write those rules guard — student and mentor alike
   ├─ queries.ts             one function per screen; pages stay presentational
   ├─ uploads.ts             file storage, validation, path safety
   ├─ upload-access.ts       who may read/delete/verify a file
   ├─ providers.ts           Coursera adapter + simulated fallback
   ├─ export/                one gatherer → .xlsx, .csv and .json, at any scope
   └─ ai/                    resume generation
      ├─ llm.ts              any OpenAI-compatible server; format ladder, fit check
      ├─ llm-parse.ts        THE REPLY PARSER (pure: fences, preambles, braces)
      └─ resume.ts           local → Anthropic → deterministic, one trust boundary
```

### Working on the UI? Read this first

MUI v9 differs from older MUI in ways that cost real time:

- **`Stack` has no system props.** `alignItems` / `justifyContent` / `flexWrap`
  must go inside `sx`. (`Box` still takes them.)
- **Never pass a function from a Server Component to a MUI component** — an `sx`
  callback, `component={NextLink}`, a `renderCell`, a `valueFormatter`. It throws
  *"Functions cannot be passed directly to Client Components"*. Put that JSX in a
  `'use client'` file instead. This is why every DataGrid lives in a client
  wrapper that receives plain rows.
- **Links just take `href`.** `LinkBehaviour` is registered on the theme as
  `MuiButtonBase.defaultProps.LinkComponent`, so `<Button href="/x">` does
  client-side navigation without `component={Link}`.
- **`slotProps` replaced the `*TypographyProps` props** on `ListItemText`,
  `CardHeader` and friends.
- **Chart `barLabel` sits on the series**, not on `<BarChart>`.

**The load-bearing idea:** formulas live in `lib/`, never in a page. `progress.ts`
and `analytics.ts` take plain rows and return plain objects, so they run
identically in a server component, an API route, or a test — and there is exactly
one definition of "stage %" in the codebase.

### Where the wireframe's "Notes for tech team" landed

| Note | Implementation |
|---|---|
| stage % = weighted avg of teaching-hours + certification-hours | `progress.ts` → `stageProgress()`, weighted by each course's total hours |
| dimension scores roll up from each course's tagged dimension | `progress.ts` → `dimensionScores()` |
| 'Overdue' = pace below the expected completion curve | `progress.ts` → `certificationStatus()` — a date passing is *not* sufficient |
| 'Cert. Pace' from actual-vs-expected curve | `progress.ts` → `certificationPace()`, hour-weighted per certification |
| progress from provider APIs, else self-reported | `providers.ts`; `CertificationProgress.selfReported` / `lastSyncedAt` record which |
| check-in via badge tap or lab-PC login, manual fallback | `LabSession.source` enum: `BADGE` / `LAB_PC` / `MANUAL` / `SELF_REPORTED` |
| alert thresholds admin-configurable per cohort, not hard-coded | `AlertRuleConfig` rows + `/mentor/settings`; `DEFAULT_RULE_PARAMS` only fills gaps |
| placement-readiness composite configurable by the director | `PlacementCriteria` row + `/director/placement` |

### Focus tracking, and what it deliberately is not

The wireframes are explicit that engagement tracking must not become
surveillance, and the implementation holds that line. Every signal is one of:

- **attendance** — lecture registers and lab check-in/check-out
- **provider-reported progress deltas** — did the logged hour move the needle
- **mentor observations** — notes recorded by a human

There is no keystroke logging, no webcam, no browser-activity monitoring, and no
schema field that could carry one. `focusQuality()` in `analytics.ts` measures
*conversion* — progress-points gained per logged hour — which is why a student
who sits in the lab for three hours and gains nothing is visible, without anyone
watching their screen.

---

## The analytics layer

Beyond the wireframes, the time data is analysed for:

| Signal | Meaning |
|---|---|
| `focusScore` | 0–100, blending progress-per-hour yield with session-length discipline |
| `progressPerHour` | provider progress-points gained per logged hour — the headline learning metric |
| session quality | `PRODUCTIVE` / `SHALLOW` / `ABANDONED` / `UNVERIFIED` per check-in |
| `consistency` | active-day rate, current streak, longest gap over a 30-day window |
| `timeOfDayProfile` | which part of the day actually yields progress for this student |
| `courseAllocation` | hours per course vs required, and share of total time |
| `forecastCompletion` | velocity, projected finish date, and *extra hours/week needed* — priced in that student's own observed yield |
| `paceCurve` | week-by-week actual completion rebuilt from session snapshots, not a straight line |
| `atRiskTrend` | cohort at-risk count per week, from alert open/close history |

---

## Recording time

Two paths write a session, and a third reads them.

**Check-in** (`/api/checkin`) records time that is happening now — badge tap, lab-PC
login, or the manual fallback.

**The entry grid** on `/student/time-log` records days that have already gone. It
is a spreadsheet, not a form: a row per session — day, activity, course, minutes,
note — filled in place, duplicated, and saved as a batch to `/api/activity/bulk`.
The single form it replaced was built for the daily case and was the wrong shape
for the one that actually loses data: a student back from a fortnight away with
eleven rows to enter, facing eleven trips through a date picker.

Rows **succeed and fail independently**. The endpoint answers `207` with a verdict
per row, the grid clears the ones that landed and leaves the rest on screen with
their reasons in the last column. A transaction would be the wrong shape —
rejecting nine good rows over a tenth naming a dropped course would make the grid
worse than the form.

The student never picks a learning mode — `ACTIVITY_MODE` derives it from the
activity — and a mentor can enter the same thing on a student's behalf from
`/mentor/student/[id]`. Every path, single or bulk, goes through the same
`recordActivity()`, so no route skips a rule.

Every rule those two share lives in `lib/activity-rules.ts` (pure: no database, no
request) and the write in `lib/activity-log.ts`, so the student's form and the
mentor's cannot validate a date differently or credit an enrolment differently.

| Rule | Where |
|---|---|
| how far back you may log — earlier of enrolment and cohort start | `earliestLoggableDay()` |
| what a hand-entered row is worth, by who wrote it | `standingFor()` |
| when an entry stops counting as contemporaneous | `isBackdated()`, `LATE_ENTRY_DAYS` |
| a plain `YYYY-MM-DD` staying on its own day in any timezone | `parseDay()` |

Three things this deliberately does:

- **No flat cut-off.** There used to be a 30-day floor. A student back from an
  off-campus block with six weeks of unlogged evenings simply lost them, which
  cost accuracy rather than protecting it. The floor is now the one fact that
  cannot be argued with — nobody studied for this programme before they were on
  it — and a late entry is *marked*, not refused.
- **`LabSession.createdAt` records when the row was written**, next to
  `checkInAt` for when the studying happened. Anything more than two days apart
  shows as "entered N days later" on the student's own log and as a `Backdated`
  column in the export, so a contemporaneous record is distinguishable from a
  fortnight backfilled in one sitting.
- **A mentor's entry has different standing, not more power.** It is `MANUAL`
  and already `mentorConfirmed`, and carries a line naming who entered it. It
  still writes no `progressDeltaPct` — typing a row is not evidence that a
  provider recorded any completion — so no focus or velocity figure moves.

## Uploads

Students upload from `/student/uploads`: **certificate proof** (per certification),
a **resume/CV**, a **profile photo**, and general **documents** such as the
organizational-study report.

This closes the loop the wireframes describe as *"self-reported by the student and
periodically spot-checked by the mentor"*. Where the Coursera API cannot be
reached, the student self-reports and uploads the certificate; a mentor verifies
it at `/mentor/uploads`, and that flips the certification off `selfReported`.

Bytes live on disk under `storage/uploads/<studentId>/`; only metadata is in
Postgres, so moving to S3 means reimplementing three functions in `lib/uploads.ts`.

Two things that are deliberate rather than incidental:

- **Nothing is served from `/public`.** Every read goes through
  `/api/uploads/[id]`, which re-checks ownership: a student sees only their own
  files, a mentor only their mentees', a director everything.
- **Stored filenames are generated, never taken from the upload**, so a crafted
  name like `../../.env` cannot escape the storage directory — and the resolved
  path is re-checked against the root before any disk access anyway.

`npx tsx --env-file=.env scripts/test-uploads.ts` exercises all of it — upload,
size and type rejection, each of the six read permissions, mentor verification,
and delete — against the running server.

## AI Resume Builder

Generates a resume grounded in the student's actual REEP record: completed
certifications with provider and hours, stage progress, dimension scores, logged
hours, attendance, and focus score — combined with the self-entered profile
(prior education, experience, projects, skills).

Every generated claim is tied back to the record that supports it, stored in the
resume's `evidence` field, so a mentor can audit it.

### Which writer runs

Three paths, tried in order. All three produce the same structure from the same
evidence pack, so a resume does not change shape depending on what is available.

| Order | Path | `generatedBy` | When |
|---|---|---|---|
| 1 | Any OpenAI-compatible model server | `local` | `LLM_BASE_URL` + `LLM_MODEL` are set |
| 2 | Anthropic | `anthropic` | `ANTHROPIC_API_KEY` is set and 1 is not |
| 3 | Deterministic composer | `fallback` | always available |

**The local path is first on purpose.** The prompt carries a student's name, USN,
email, marks and attendance. A model on the programme's own hardware is the only
version of this feature where that never leaves the building.

Set up the default (Gemma 3 12B, ~8 GB, runs on a 12 GB GPU):

```bash
winget install Ollama.Ollama    # or https://ollama.com/download
npm run ai:setup                # pulls gemma3:12b, builds reep-gemma3
```

`.env` already points at it:

```
LLM_BASE_URL="http://127.0.0.1:11434/v1"
LLM_MODEL="reep-gemma3"
LLM_CONTEXT_TOKENS="16384"
```

Swap those three values for any other server that speaks
`/v1/chat/completions` — LM Studio, vLLM, OpenRouter, Groq, or Google's Gemini
compatibility endpoint. Anything not on this machine sends the student's record
to a third party.

Expect **~60s per resume** on a laptop GPU, against ~3s for a hosted frontier
model. That is the trade for keeping the data local.

### What made a 12B model safe to use here

`adoptModelOutput()` in `resume.ts` was already the trust boundary for the
Anthropic path, and it is what makes a small open-weights model viable: it drops
any citation that does not name a record in the pack, so the model can write a
duller sentence than Claude but **cannot** claim a certification the student
never earned. `scripts/test-llm.ts` asserts exactly that against the live model.

Three things in `lib/ai/llm.ts` exist because open-weights models are less
obedient than a frontier API, not for elegance:

- **A response-format ladder.** `json_schema` → `json_object` → plain prose.
  Support for each varies by server *and* by model; the request steps down
  rather than assuming the top rung works.
- **A tolerant extractor** (`lib/ai/llm-parse.ts`, pure and unit-tested).
  Small models return JSON in ``` fences, after "Here is the resume:", or behind
  a `<think>` block. It brace-scans with string-literal tracking, because a
  regex picks the wrong end when a resume bullet contains `{` or a quote.
- **A prompt-size check that refuses rather than truncates.** Ollama's default
  context is 4096 tokens; this prompt is roughly twice that. A silently
  truncated evidence pack is this feature's worst failure — the model then
  invents the half it could not see — so `ollama/reep-gemma3.Modelfile` pins
  `num_ctx` to 16384 and the adapter errors if a prompt would not fit.

---

## REEP Agent

One agent, three doors. `/student/assistant`, `/mentor/assistant` and
`/director/assistant` render the same screen and post to the same endpoint; the
only thing that differs is the **scope** resolved from the session cookie before
the model is given anything.

| Role | Scope | Can read |
|---|---|---|
| `STUDENT` | `self` | their own record, and nothing else |
| `MENTOR` | `programme` | every student, plus mentor notes |
| `DIRECTOR` / `ADMIN` | `programme` | every student, plus programme analytics |

Note that `MENTOR` is deliberately wider here than on the mentor's own screens,
which scope a faculty member to their assigned mentees. If that is wrong for
your programme, `SCOPE_BY_ROLE` in `lib/ai/agent/scope.ts` is the one line to
change.

### Two ways in

A **floating launcher** sits in the corner of every screen (`AgentLauncher`,
mounted once in `AppShell`), opening the agent in a side panel over whatever you
were reading — a mentor looking at one student's focus log can ask about it
without navigating away and losing the row. The **full page** is the same agent
with room for the whole transcript, and the panel links across to it.

The launcher fetches nothing until it is opened: it renders on every page in the
product, so loading a scope and twenty past runs on each render would put a
database round-trip behind every navigation to pay for a panel most readers will
not open on most screens. `GET /api/agent` returns scope, copy and transcript on
first open, and the panel stays mounted after that — closing it hides it, only
Cancel cancels, because a run is several calls to a local model and unmounting
would kill a question still being answered.

### Why the student wall holds

The assistant reads a question a user wrote, and a model will follow an
instruction it finds inside one. So the wall is not built out of the prompt:

- **Scope comes from the cookie, never the conversation.** Nothing the model
  emits is an input to `resolveScope()`. A jailbreak in the question is still
  confined to what that signed-in user could have reached by clicking around.
- **No tool takes a student id.** Tools take a USN, and every USN goes through
  `resolveStudent()`, which refuses anything outside scope. Internal cuids never
  reach the model, so it cannot enumerate the table by guessing.
- **Staff-only tools are absent from a student's catalogue.** `find_students`,
  `mentor_notes` and `programme_analytics` are not refused for a student — they
  are never mentioned, and `adoptDecision()` will not dispatch a name that was
  not offered.
- **A refusal ends the run.** Left alone, a model will try the same lookup
  through a different tool. Every one of those would also refuse, but the result
  is four wasted model calls and a transcript that reads like probing.
- **Refusals are visible, not silent.** Quietly substituting the asker's own
  record would leave a student believing they had read a classmate's.

`scripts/test-agent.ts` is the proof: it asks for a classmate's record four
ways — plainly, by injection, by naming a staff tool, and by claiming to be
staff — and checks the *stored trace*, not just the wording of the reply.

### What the first live run changed

The wall held on every adversarial check the first time it ran. Everything that
broke was the model being led astray by our own documentation, which is worth
recording because none of it is visible without a real 12B model on the end:

- **It copies example arguments verbatim.** A student asked "how am I doing on my
  certifications?" and the model passed `usn: "1BG24MBA001"` — the placeholder
  out of this repo's own `argsHint` string — earning an access refusal for the
  student's own record. `argsHint` is now a function of scope, and a student is
  told the argument does not exist.
- **It generalises a magic value across fields.** Shown `"any"` as the no-filter
  value for `stage` and `risk`, it also sent `query: "any"`, which became a name
  substring matching nobody — and the assistant told a director there were no
  at-risk students. `find_students` now absorbs those placeholders.
- **Telling it to stop is not enough.** Handed an observation reading "you have
  already read this, answer now", it agreed and asked again, spending all four
  steps on one record. A repeated call now forces the answer turn, and the last
  turn dispatches no tools at all.
- **It writes grounded answers with empty `citations`.** The reply is sound; the
  ids are simply missing. Where that happens the records it actually read are
  attributed on its behalf, so "cited" still means "read".
- **It explained a refusal with a made-up fact.** Declining correctly, it said
  "REEP records do not contain data for USN 1BG23MBA202" — about a record that
  exists and it had never looked at. Refusing is honest; inventing a database
  fact to justify the refusal is the exact failure this product is built to
  avoid, refusal or not. The self-scope prompt now forbids it and
  `test-agent.ts` checks for it.

One test lesson too, since it nearly read as a leak: the leak check originally
looked for the other student's USN in the reply unless the wording contained
"denied" or "cannot", and it failed three *correct* refusals phrased another
way. Naming the student you are declining to read is right, and a refusal's
wording is not a security property. The checks are now on provenance — what the
trace shows was read, and what the answer cites — which is where the invariant
actually lives.

### What it costs to run

The loop is capped at **four steps**, each one a call to the same local model
the resume builder uses — so a question that needs two records takes about as
long as a resume. Most resolve in two steps.

Two consequences of the 16k window are worth knowing before extending it:

- **Tools return prose, not rows.** `getStudentDetail()` alone serialises to tens
  of thousands of tokens. Each tool hand-writes a few-hundred-token digest that
  states its numbers exactly as the dashboard states them, so the assistant and
  the screens cannot disagree.
- **The prompt is rebuilt each step, not appended to.** `llm.ts` refuses a prompt
  over 62% of the window rather than truncating it, so an appending loop would
  not degrade at step four — it would throw. Recent observations go in whole,
  older ones are cut to a headline, and anything dropped is announced to the
  model rather than vanishing.

### The audit trail

Every question, its answer, the tools it called, the digests they returned and
any access denied is written to `agent_runs`. That table is what makes "a
student cannot read another student's record" something an administrator can
check after the fact rather than take on trust — and it is where the chat
transcript is read back from, so conversation history cannot be forged by the
browser.

---

## Data visualisation

**The product has one hue.** 36° — the hue of paper, not of screen. Ink, page,
accent, status and every chart series are that hue at a different lightness or
saturation, including the neutrals, which carry the same cast rather than being
grey.

**There is no white in the light scheme.** The page is cream and every surface
is the same cream at another lightness:

| Token | Value | Role |
|---|---|---|
| `CREAM.page` | `#efe9dd` | the page — the *deeper* of the two |
| `CREAM.paper` | `#f8f4ec` | cards, menus, the glass fallback |

The order matters and is not a preference. Neumorphism is a tile extruded from
the page, so it needs room in **both** directions — somewhere lighter for the
top-left highlight and somewhere darker for the bottom-right shadow. On white
there is nowhere lighter to go and the effect collapses into a grey smudge,
which is why the page is the deeper tone and the tile rises out of it. For the
same reason no highlight in the system is `#ffffff`: white on cream reads as a
hole in the tile rather than as light falling on it.

The neumorphic gradient's **two ends are both surfaces text sits on**, so both
are measured, not just the flat colour — `#faf7f0 → #eae3d4`, holding the 12px
hint colour at 4.62:1 at the deep end. That is what limits the extrusion depth;
the shadows carry the rest, which they can do without touching legibility.

Four categorical slots, placed by solving rather than by eye, because a
monochrome scheme has to separate by luminance and two constraints compete:
each slot must clear **3:1 against its own surface**, and adjacent slots must
stay **~1.5:1 apart from each other**.

| Slot | Light | on `#efe9dd` | Dark | on `#14120d` |
|---|---|---|---|---|
| 1 | `#3a301f` | 10.71:1 | `#7c5d2e` | 3.09:1 |
| 2 | `#62471f` | 7.12:1 | `#ab7b32` | 5.00:1 |
| 3 | `#8b5f1c` | 4.63:1 | `#d4a155` | 8.05:1 |
| 4 | `#b5781d` | 3.06:1 | `#ead5b6` | 13.09:1 |

Four rungs is what the luminance range fits. **A fifth would have to break one
of the two constraints** — which is why every chart keeps its legend and
`RankedBarChart` keeps direct labels. The outermost rung in each row has no
headroom left, so re-measure after any change.

Moving off near-white cost about a fifth of the light row's range, so the ramp
was **re-solved rather than re-tinted**: light separations are now 1.50–1.54:1
against the 1.62:1 the old page afforded. Worst text contrast is 4.88:1 in
light and 5.26:1 in dark, zero failures in either.

### What monochrome costs, and what pays for it

Hue can no longer tell "on track" from "at risk". The rule the system already
had is now the whole signal rather than a nicety: **status always ships an icon
and a word**, enforced by `StatusChip`. Colour now ranks severity — critical is
the darkest, most saturated step in light mode and the brightest in dark, so it
still pulls the eye first — rather than naming it.

Two places where that had to be handled explicitly:

- `PaceCurveChart` puts its verdict in the **series label**
  (`Actual completion — behind pace`), not the colour. It is the one chart that
  tells a student they are falling behind, and it has to survive
  colour-blindness and the greyscale printable record.
- `RankedBarChart` labels sit *inside* the bar, so they contrast with the fill
  rather than with the page. `STATUS` is a fixed constant rather than a palette
  entry, so those bars are the same three dark ambers in both schemes and the
  label is pinned to white in both — 5.62:1 on the lightest. This is the one
  white in the product, and it is a foreground, never a background.

`STATUS.serious` is gone. Nothing used it, and it was indistinguishable from
`warning` even when the two had different hues.

---

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | dev server on :3100 |
| `npm run build` | production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:up` / `db:down` | start / stop the Postgres container |
| `npm run db:seed` | wipe and re-seed (deterministic) |
| `npm run db:reset` | reset migrations then re-seed |
| `npm run db:studio` | Prisma Studio |
| `npx tsx scripts/sanity-check.ts` | print the mentor roster and one student's rollup |
| `npx tsx scripts/verify-formulas.ts` | 37 assertions over the progress + analytics maths |
| `npx tsx --env-file=.env scripts/smoke.ts` | fetch every route with a real session and report pass/fail |
| `npx tsx --env-file=.env scripts/test-uploads.ts` | upload round-trip incl. every access-control path |
| `npx tsx --env-file=.env scripts/test-exports.ts` | every export scope and format — including that a single-student file contains one student |
| `npx tsx --env-file=.env scripts/test-activity.ts` | the time-entry rules: which days are allowed, what a hand-entered row is worth, and that a partly-valid batch saves the good rows (writes rows, then removes them) |
| `npx tsx --env-file=.env scripts/test-llm.ts` | the resume writer against the live model — reply parsing, then that every claim it wrote cites a real record |
| `npx tsx --env-file=.env scripts/test-agent.ts` | the assistant's data scope — a student is asked to fetch a classmate's record plainly, by prompt injection, and by naming a staff-only tool; then the same questions as a director, where they must succeed |
| `npm run ai:setup` | pull Gemma 3 12B and build `reep-gemma3` with the context window this prompt needs |
| `npx tsx --env-file=.env scripts/probe.ts /some/route [email] [text]` | fetch one route and show its error or content |

The seed uses a fixed PRNG seed, so the same numbers come back every time —
demos, screenshots and tests all agree.

---

## Build phases (from the wireframe's suggested priority)

1. **Student Home + Certification Tracker** — core progress visibility ✔
2. **Time Usage Log + lab check-in flow** ✔ — check-in mechanism is pluggable
   (`LabSession.source`); badge integration is the one piece needing hardware
3. **Mentor Cohort View + Student Detail / Focus Log** ✔ — alert rules engine ✔
4. **Director Analytics + placement-readiness composite** ✔

## Not done / needs a real deployment decision

- **Badge hardware.** `CheckInSource.BADGE` exists and the flow supports it, but
  there is no integration with a physical campus-ID reader. Until that exists,
  check-in runs on lab-PC login or mentor-confirmed manual entry.
- **Coursera Partner API.** `providers.ts` has the adapter seam and falls back to
  a simulated source. Real credentials go in `COURSERA_CLIENT_ID` / `_SECRET`.
- **Scheduled alert scans.** `runAlertScan()` runs on seed and on demand from the
  mentor UI. Production wants it on a cron / scheduled job.
- **Email + push for nudges.** "Send Nudge" records the mentor action; it does not
  yet deliver a message.
