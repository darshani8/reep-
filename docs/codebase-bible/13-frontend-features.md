# Chapter 13 — Frontend Features: Every Screen a Student Actually Uses

When you finish this chapter you will be able to open any screen in REEP, name the file
that draws it before you look, predict which endpoints it will hit and in what order,
know what it shows while loading and what it shows when that endpoint is down, and say
whether the number on the screen was decided by the server or re-derived in the browser.
You will also know — precisely, with file and line — every place where a screen departs
from the house pattern Chapter 12 established, which is the list you want in front of you
the first time one of these screens misbehaves.

**In scope.** Every component under `apps/web/src/app/features/`: the student dashboard,
records, academics, jobs, offers, certifications, courses, uploads, skilling,
leaderboards, time-log, profile, the twenty-file resume builder, the assistant UI, login,
registration, and the placeholder that stands in for every staff screen.

**Deferred.** Chapter 12 owns bootstrap, the route table's mechanics, the guard, the
`core/` services, the shared `kit-*` components and the nine house patterns — this
chapter cites them and reports deviations rather than restating the rules. Chapter 11
owns `core/chat-voice.service.ts` in full; §8 documents only the assistant's *UI* over
it. Chapter 14 owns `apps/web/src/styles/*.scss`, so global class names are named here
but never defined. Chapter 6 owns the student endpoints and their rule engines; where a
screen's number and the server's number disagree, this chapter states the disagreement
and points at Chapter 6 for the authoritative rule. Chapter 2 owns `filestore.py`'s real
upload limits, which §5 compares the client's against.

---

## 1. The feature layer at a glance

### The folder convention

`apps/web/src/app/features/` holds one directory per screen, and the directory is named
for the screen, not for the class. Inside it lives the triplet Chapter 12 §10 describes:
`<screen>.component.ts` alongside `<screen>.component.html` and `<screen>.component.scss`,
wired with `templateUrl: './x.component.html'` and the singular `styleUrl`. Student
screens nest one level deeper under `features/student/`, so the full path of the jobs
board is `features/student/jobs/jobs.component.ts`.

The class is PascalCase ending in `Component`; the selector is `app-` plus the kebab
feature name with the area folded in — `JobsComponent` / `app-student-jobs`,
`RecordsComponent` / `app-student-records`. Two families deliberately break the `app-`
prefix: the shared kit uses `kit-`, and the seventeen resume-builder sub-components use
`rb-` (§7).

Not every screen keeps the triplet. Twelve of the fifteen resume sections inline their
`template:` string, and `PlaceholderComponent` inlines both `template:` and `styles:` —
it is forty lines and has one input.

### How a screen becomes a route

Every screen is registered in [app.routes.ts](apps/web/src/app/app.routes.ts) with
`loadComponent`, never a static `component:` reference. Chapter 12 §2 explains the
mechanism and the bundle budget that enforces it; the shape is always the same
([app.routes.ts:110-114](apps/web/src/app/app.routes.ts#L110)):

```ts
      {
        path: 'student/jobs',
        loadComponent: () =>
          import('./features/student/jobs/jobs.component').then((m) => m.JobsComponent),
      },
```

The file's own doc comment states the invariant in one direction — "Every nav destination
in the shell needs a route, or clicking it goes nowhere and navigation reads as broken"
([app.routes.ts:6-9](apps/web/src/app/app.routes.ts#L6)) — and nothing enforces the
converse. That asymmetry has consequences. The shell's nav
([app-shell.component.html:16-57](apps/web/src/app/layout/app-shell.component.html#L16))
lists exactly twelve student destinations: Landing, Jobs, Skilling, Leaderboards, Time
Sheet, then a **Programme** group of Certifications, Courses, Records, then a
**Documents** group of Uploads and Resume Builder, then a **More** group of REEP Agent
and Profile. The route table registers **fourteen** student paths. The two extras —
`student/academics` ([app.routes.ts:64-70](apps/web/src/app/app.routes.ts#L64)) and
`student/offers` ([app.routes.ts:115-119](apps/web/src/app/app.routes.ts#L115)) — have no
nav link. You reach them by typing the URL, or, for academics, by clicking a card the AI
agent emits: [orchestrator.py:80-82](apps/api-py/app/ai/orchestrator.py#L80) maps the
readiness factors *CGPA*, *Live backlogs* and *Attendance* to the route
`/student/academics`. Both orphan screens are broken against the current API (§3, §4),
and that is not a coincidence: **an unlinked screen is a screen nobody notices rotting.**

> **Why it is like this.** The route table's comment records the failure that made
> laziness non-negotiable: "A static `import` at the top of this file pulls the component
> into the initial bundle no matter which route the user visits — which is how every
> screen in the app ended up in one 1.23 MB `main` chunk with no lazy chunks at all. A
> student on a phone was downloading the mentor and director UIs, plus the resume builder
> and the assistant, before the login form could paint."
> ([app.routes.ts:13-18](apps/web/src/app/app.routes.ts#L13))

### The index — every feature component

Sizes are `.ts` lines + `.html` lines where a separate template exists.

| Component | Selector | Route | Endpoints consumed | Size |
|---|---|---|---|---|
| `StudentOverviewComponent`<br>`student/overview/student-overview.component.ts` | `app-student-overview` | `/student` | GET `/student/dashboard`, `/attendance`, `/results`, `/streak`, `/swoc`, `/mocks`, `/skills`, `/next-actions`, `/placement-readiness`, `/recommendations` | 467 + 236 |
| `RecordsComponent`<br>`student/records/records.component.ts` | `app-student-records` | `/student/records` | GET `/student/results`, `/attendance`, `/academics` | 220 + 250 |
| `AcademicsComponent`<br>`student/academics/academics.component.ts` | `app-student-academics` | `/student/academics` *(no nav link)* | GET `/student/academics`; PUT `/student/academics` **(no such route)** | 125 + 97 |
| `CertificationsComponent`<br>`student/certifications/certifications.component.ts` | `app-student-certifications` | `/student/certifications` | GET `/student/certifications` | 117 + 86 |
| `CoursesComponent`<br>`student/courses/courses.component.ts` | `app-student-courses` | `/student/courses` | GET `/student/courses` | 106 + 86 |
| `JobsComponent`<br>`student/jobs/jobs.component.ts` | `app-student-jobs` | `/student/jobs` | GET `/student/jobs`, `/student/offers`; POST `/student/jobs/{id}/apply`, `/student/offers` | 360 + 309 |
| `OffersComponent`<br>`student/offers/offers.component.ts` | `app-student-offers` | `/student/offers` *(no nav link)* | GET `/student/offers`; POST `/student/offers`, `/student/offers/{id}/submit` | 181 + 104 |
| `UploadsComponent`<br>`student/uploads/uploads.component.ts` | `app-student-uploads` | `/student/uploads` | GET `/student/uploads`; POST `/student/uploads`; DELETE `/student/uploads/{id}`; image GET `/student/uploads/{id}/file` | 303 + 231 |
| `SkillingComponent`<br>`student/skilling/skilling.component.ts` | `app-student-skilling` | `/student/skilling` | GET `/student/skills`, `/student/skill-claims`, `/student/skills/catalogue`; POST `/student/uploads`, `/student/skill-claims` | 216 + 109 |
| `LeaderboardsComponent`<br>`student/leaderboards/leaderboards.component.ts` | `app-student-leaderboards` | `/student/leaderboards` | GET `/student/leaderboards?board=`; PUT `/student/leaderboard-visibility` | 195 + 121 |
| `TimeLogComponent`<br>`student/time-log/time-log.component.ts` | `app-student-time-log` | `/student/time-log` | GET `/student/timesheet?days=1`; POST `/student/timesheet` ×5 | 229 + 100 |
| `ProfileComponent`<br>`student/profile/profile.component.ts` | `app-student-profile` | `/student/profile` | GET `/student/profile`, `/student/dashboard`; PUT `/student/profile` | 394 + 211 |
| `ResumeBuilderComponent` + 15 sections + 2 views + 1 service<br>`student/resume/**` | `app-resume-builder`, `rb-*` | `/student/resume` | GET/PUT `/student/resume-profile`; GET `/student/results`, `/academics`, `/uploads`, `/certifications`, `/resume`, `/dashboard`; POST `/student/uploads`, `/student/resume/generate`; GET `/student/resume/{id}/pdf` | 20 files, ~3,600 lines |
| `AssistantComponent`<br>`assistant/assistant.component.ts` | `app-assistant` | `/student/assistant`, `/mentor/assistant`, `/director/assistant` | via `ChatVoiceService`: GET `/api/agent/history`; POST `/api/agent/ask`, `/api/agent/feedback`; DELETE `/api/agent/conversation`; POST `/api/voice/consent`; GET `/api/voice/status`; POST `/api/voice/token` | 476 + 371 |
| `LoginComponent`<br>`login/login.component.ts` | `app-login` | `/login` (unguarded) | via `AuthService`: POST `/api/auth/login`; link to `/api/auth/sso/google` | 111 + 157 |
| `RegistrationComponent`<br>`register/registration.component.ts` | `app-registration` | `/register` (unguarded) | POST `/api/register` | 123 + 102 |
| `PlaceholderComponent`<br>`placeholder/placeholder.component.ts` | `app-placeholder` | 17 `mentor/*` and `director/*` routes | none | 40 (inline) |

Two facts fall out of that table. First, **every real screen in the product is a student
screen, plus login, register and the assistant.** All seventeen `mentor/*` and
`director/*` routes resolve to `PlaceholderComponent`
([app.routes.ts:135-161](apps/web/src/app/app.routes.ts#L135)) and no client code calls
`/api/mentor` or `/api/director` at all. Second, **the only screen that does not fetch is
the placeholder** — there is no HTTP service layer, no repository, no interceptor. Every
screen calls `fetch` for itself, with two justified exceptions (the assistant and the
resume builder, both because their state must outlive a component). Adherence to
`credentials: 'include'` is total and hand-maintained: 43 `fetch(` call sites in
`apps/web/src`, 43 occurrences of `credentials: 'include'`.

---

## 2. The student dashboard — `student-overview.component.ts`

This is the landing screen, the most-visited surface in the product, and the one place
where the design of the whole app is legible in a single method. Its header comment
states the running order it is built around
([student-overview.component.ts:1-15](apps/web/src/app/features/student/overview/student-overview.component.ts#L1)):
next actions, placement readiness, recommendations, SWOC, skill badges, and only then the
historical analytics. "Every card is independent — when its endpoint is missing, empty or
errors, the card shows its own state and the rest of the screen is unaffected."

### The fetch orchestration

The constructor is one line, `void this.load();`
([:190-192](apps/web/src/app/features/student/overview/student-overview.component.ts#L190)),
and `load()` is the whole network story
([:422-441](apps/web/src/app/features/student/overview/student-overview.component.ts#L422)):

```ts
  private async load(): Promise<void> {
    const [dash, att, res, streak, swoc, mocks, skills, actions, readiness, recos] =
      await Promise.all([
        this.getJson<Dashboard>('/student/dashboard'),
        this.getJson<AttendanceSummary>('/student/attendance'),
        this.getJson<SemesterResult[]>('/student/results'),
        this.getJson<Streak>('/student/streak'),
        this.getJson<SwocBoard>('/student/swoc'),
        this.getJson<MockAttempt[]>('/student/mocks'),
        this.getJson<StudentSkill[]>('/student/skills'),
        this.getJson<{ actions: NextAction[] }>('/student/next-actions'),
        this.getJson<PlacementReadiness>('/student/placement-readiness'),
        this.getJson<{ items: Recommendation[] }>('/student/recommendations'),
      ]);

    if (dash == null) {
      this.error.set('Could not load your overview.');
      this.loading.set(false);
      return;
    }
```

Ten reads, fully parallel, no sequencing and no dependency between them; the results are
destructured positionally, so **the order of that array is load-bearing** — inserting a
read in the middle without inserting a matching name silently rewires seven cards. There
is no `catch` around the `Promise.all`, and none is needed, because of the helper every
element goes through
([:456-466](apps/web/src/app/features/student/overview/student-overview.component.ts#L456)):

```ts
  /// One shape for every read: null on any non-OK response or network error, so
  /// a missing sub-endpoint becomes a per-card empty state, never a crash.
  private async getJson<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`${environment.apiBase}${path}`, { credentials: 'include' });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
```

`getJson` never rejects, so `Promise.all` never rejects. That is the mechanism behind the
header comment's promise. It is also the screen's single largest departure from the house
pattern, and §10 records it as such: Chapter 12 §9 Rule 2 says `!res.ok` and `catch` are
different diagnoses and must get different messages, and `getJson` deliberately collapses
them — and the status code with them. **The dashboard cannot tell a 401 from a 500 from
an offline browser**, and nine of its ten endpoints have no distinguishable failure
message at all. The trade is stated honestly in the comment, and for nine cards it is the
right trade; for the tenth it is why a logged-out session renders as "Could not load your
overview" instead of a redirect.

Only `/student/dashboard` is load-bearing. When it returns null the method returns
*before any other signal is set*, so nine successful responses are thrown away and the
template renders only its error branch
([student-overview.component.html:3-6](apps/web/src/app/features/student/overview/student-overview.component.html#L3)):
a `.dt-header` reading "Landing" with the error as its sub-line, plus a card reading
"We couldn't reach your record. Please try again shortly." Any of the other nine failing
sets its own signal to `null` and leaves the rest of the page untouched.

Two responses are unwrapped rather than stored raw
([:450-452](apps/web/src/app/features/student/overview/student-overview.component.ts#L450)):

```ts
    this.nextActions.set(actions ? actions.actions : null);
    this.readiness.set(readiness);
    this.recommendations.set(recos ? recos.items : null);
```

because `NextActionsOut` and `RecommendationsOut` are envelopes — `{actions: [...]}` and
`{items: [...]}` — while `PlacementReadinessOut` is a bare object. The ternary is what
preserves the null-versus-empty distinction through the unwrap.

### State: twelve signals, and what `null` means

Two control signals — `loading = signal(true)` and `error = signal<string | null>(null)`
([:174-175](apps/web/src/app/features/student/overview/student-overview.component.ts#L174))
— then ten data signals, all `T | null`. The action-led three carry an explicit comment
naming the convention
([:185-188](apps/web/src/app/features/student/overview/student-overview.component.ts#L185)):

```ts
  // Action-led sections (null = section failed to load → per-card error state).
  readonly nextActions = signal<NextAction[] | null>(null);
  readonly readiness = signal<PlacementReadiness | null>(null);
  readonly recommendations = signal<Recommendation[] | null>(null);
```

This is Chapter 12 §9 Rule 6 — `null` means "not resolved", `[]` means "resolved, nothing
there" — and the template honours it card by card. `nextActions() === null` renders "Your
next actions are unavailable right now."
([html:23-24](apps/web/src/app/features/student/overview/student-overview.component.html#L23));
an empty array renders a celebratory `chip good` "You're all caught up" plus "Nothing
needs your attention right now — great work."
([html:44-47](apps/web/src/app/features/student/overview/student-overview.component.html#L44)).
Recommendations do the same, and skill badges go three ways: null → "Skill badges are
unavailable right now.", empty → "No skills recorded yet — upload a certificate to claim
one.", else the badge row
([html:179-197](apps/web/src/app/features/student/overview/student-overview.component.html#L179)).
One card breaks the rule: SWOC renders "No SWOC inputs yet — your mentor and the placement
cell add these."
([html:121-123](apps/web/src/app/features/student/overview/student-overview.component.html#L121))
for both a failed load and a genuinely empty board, so a student cannot tell "your mentor
has not written this yet" from "this endpoint is down".

### The cards, and how the numbers are made

**Next actions.** `topActions` is the whole client-side logic
([:208-209](apps/web/src/app/features/student/overview/student-overview.component.ts#L208)):

```ts
  /** Show the most urgent few; the endpoint already sorts by priority asc. */
  readonly topActions = computed(() => this.nextActions()?.slice(0, 4) ?? []);
```

The comment is true — [student.py:2006-2007](apps/api-py/app/routers/student.py#L2006)
does `actions.sort(key=lambda a: a.priority)` then `return NextActionsOut(actions=actions[:5])`.
The server hands over five and the client shows four, so **the fifth action is
permanently invisible.** Each row prints the title, the reason, a status chip, an optional
deadline chip, and a `routerLink` to the server-supplied `cta_route`.

The status chip is the codebase's model statement of the colour rule
([:153-162](apps/web/src/app/features/student/overview/student-overview.component.ts#L153)):

```ts
/** Status-label → chip tone + icon. TEXT is always the label itself, so colour
 *  is never the only signal. Unknown labels fall back to a neutral chip. */
const STATUS_CHIPS: Record<string, StatusChip> = {
  Overdue: { cls: 'risk', icon: 'warning' },
  'In progress': { cls: 'warn', icon: 'schedule' },
  Missing: { cls: 'risk', icon: 'error' },
  Incomplete: { cls: 'warn', icon: 'pending' },
  'Pending review': { cls: 'neutral', icon: 'hourglass_top' },
  Unverified: { cls: 'warn', icon: 'help' },
};
```

Those six keys are the six literal status strings `next_actions` emits, verified
one-for-one against [student.py:1833-2007](apps/api-py/app/routers/student.py#L1833). The
lookup is total — `STATUS_CHIPS[status] ?? { cls: 'neutral', icon: 'info' }`
([:211-213](apps/web/src/app/features/student/overview/student-overview.component.ts#L211))
— and the template prints `{{ a.status }}` beside the chip, so a renamed server string
degrades to a grey chip with the right words rather than crashing or blanking. It does
lose the urgency colour silently, which is the cost of a total fallback.

**Placement readiness.** The client displays `r.score` out of 100, the band, the summary
and the six weighted factors. It never derives the band from the score; it maps the
server's band string to a tone
([:223-227](apps/web/src/app/features/student/overview/student-overview.component.ts#L223)):

```ts
  bandChip(band: string): ChipTone {
    if (band === 'Ready' || band === 'On track') return 'good';
    if (band === 'Developing') return 'warn';
    return 'risk';
  }
```

`_readiness_band` emits exactly `Not ready` / `Developing` / `On track` / `Ready`
([student.py:2024-2031](apps/api-py/app/routers/student.py#L2024)), so the mapping is
correct today. Note the failure mode is asymmetric: an added or renamed band falls into
the `else` and paints red. That is a hard-coded copy of the server's vocabulary, not a
recomputation — an important distinction §10 returns to.

**The stage donut.** `stagePct`
([:231-236](apps/web/src/app/features/student/overview/student-overview.component.ts#L231))
finds the current stage's index in the module table `STAGES`
([:138-143](apps/web/src/app/features/student/overview/student-overview.component.ts#L138),
whose four keys match the `ReepStage` enum exactly) and returns `(idx + 1) / 4 * 100`, so
25 / 50 / 75 / 100, or 0 for an unknown key. `donutStyle` turns that into a
`conic-gradient(var(--amber-600) 0% ${p}%, var(--line) ${p}% 100%)` bound as
`[style.background]`. This is a pure client invention — no server field corresponds to it
— so it cannot diverge from anything.

**Attendance and marks bars.** `attendanceBars` prefers the per-course breakdown, taking
six courses and labelling each with its code and rounded percentage; when there is no
breakdown it falls back to a single "Overall" bar built from the dashboard's
`attendance_percent`, with the comment "Fall back to the single overall % the dashboard
always carries." `marksBars` maps each semester to `r.cgpa ?? r.sgpa`, drops nulls with a
type-guard filter, and scales a 10-point GPA to a percentage. Both feed the shared height
guard ([:416-420](apps/web/src/app/features/student/overview/student-overview.component.ts#L416)):

```ts
  /// Keep a non-zero value visible (min 6%) while clamping to the chart height.
  private clampH(v: number): number {
    if (v <= 0) return 3;
    return Math.max(6, Math.min(100, Math.round(v)));
  }
```

Zero maps to 3, a visible stub rather than nothing — so an empty bar is distinguishable
from a missing bar.

**SWOC** becomes four fixed boxes (Strength / Weakness / Opportunity / Challenge) whose
items are joined with a middle dot and each of which carries a *framing* sentence that
turns the analysis into an instruction: "Leverage this in your applications and
interviews.", "Recommended activity — turn this into a skilling goal.", "Act before the
window closes — check the jobs board and deadlines.", "Plan a prep task now to get ahead
of this."

**Badges.** `badges` copies the array (`[...rows]`, so the signal's array is never
mutated), sorts verified-first with `Number(b.verified) - Number(a.verified)`, slices to
eight, and emits a locked badge with an explanatory title for every unverified skill —
"Verify a {category} skill to unlock this badge". The icon comes from `skillIcon`, a
private regex ladder over the slug, name and category, mapping e.g. `excel|spreadsheet` to
`calculate` and `sql|database|python|java|code` to `terminal`, defaulting to `verified`.

**Streak.** `streakChip` returns `null` when the endpoint failed, a warn chip "No active
streak" at zero, else a good chip "{n}-day login streak". `streakCells` is
`Array.from({length: 7}, (_, i) => i < Math.min(current, 7))` — a fixed seven-cell strip
that saturates, so a forty-day streak looks identical to a seven-day one.

---

## 3. Records and academics — the same data, two philosophies

### `records.component.ts` — three independent loads, no aggregation

Records is the read-only screen the REEP Agent points at, and its header comment states
both its architecture and its DTO discipline in one paragraph
([records.component.ts:1-15](apps/web/src/app/features/student/records/records.component.ts#L1)):

> **Why it is like this.** "One read-only screen that aggregates a student's academic
> records from three independent endpoints, each of which loads, empties and fails on its
> own so a single unreachable section never blanks the page… Interfaces are snake_case,
> verbatim from student.py's *Out models — no client remapping. STATUS is always text +
> colour together (the .chip tones), never colour alone."

There is no aggregate loader. The constructor fires three void-ed methods
([:142-146](apps/web/src/app/features/student/records/records.component.ts#L142)) and each
owns a signal pair — `results`/`resultsState`, `attendance`/`attendanceState`,
`academics`/`academicsState` — typed with the local
`type LoadState = 'loading' | 'ready' | 'error'`
([:21](apps/web/src/app/features/student/records/records.component.ts#L21)). All three
loaders are byte-for-byte the same shape apart from the URL and the signal names
([:148-160](apps/web/src/app/features/student/records/records.component.ts#L148)):

```ts
  private async loadResults(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/results`, { credentials: 'include' });
      if (!res.ok) {
        this.resultsState.set('error');
        return;
      }
      this.results.set((await res.json()) as SemesterResult[]);
      this.resultsState.set('ready');
    } catch {
      this.resultsState.set('error');
    }
  }
```

Note what that costs relative to the house pattern: because the state is a three-value
enum rather than an error *string*, `!res.ok` and `catch` produce the identical outcome.
Records is the mirror image of the dashboard's over-generalisation — twelve lines
triplicated instead of one helper — and both end up losing the same distinction. §10
records it.

Its interfaces are the ones to copy. `SubjectMark`/`SemesterResult`
([:25-42](apps/web/src/app/features/student/records/records.component.ts#L25)) match
`SubjectMarkOut`/`SemesterResultOut`, `CourseAttendance`/`AttendanceSummary`
([:45-56](apps/web/src/app/features/student/records/records.component.ts#L45)) match their
`*Out` models, and `Qualification`/`AcademicGap`/`Academics`
([:59-81](apps/web/src/app/features/student/records/records.component.ts#L59)) match
[student.py:461-484](apps/api-py/app/routers/student.py#L461) field for field including
the server-computed `percent` and `total_mo`. **Records is the only one of the two
academics-consuming screens outside the resume builder that is correct against the API.**

The template opens with a four-tile headline strip gated on
`resultsState() === 'ready' && results().length`
([records.component.html:9-30](apps/web/src/app/features/student/records/records.component.html#L9)):
Latest CGPA, Semesters on record, Live backlogs, Overall attendance. The last tile is a
cross-panel read — it prints an em dash when attendance failed — so an attendance outage
shows a dash inside a strip that otherwise rendered fine. Each of the three sections below
is a four-way ladder: `loading` → a `.card.c-note` "Loading your semester results…";
`error` → "We could not load your semester results just now. Please refresh in a moment.";
empty → "No semester results yet. They appear here once the examination office imports
your VTU marks."; else the content. Attendance's empty test is stricter than a null check
— `!attendance() || attendance()!.total === 0` — so a student with a summary row and zero
classes gets the empty message rather than "0%".

The attendance panel is the most accessible markup on any student screen: a
`role="progressbar"` meter carrying `[attr.aria-valuenow]`, `aria-valuemin`,
`aria-valuemax` and an `aria-label`, with the fill tinted *and* the number printed beside
it ([records.component.html:139-147](apps/web/src/app/features/student/records/records.component.html#L139)).

Two derived values on this screen are recomputations of server rules, and §10 lists them
as divergences. `attendanceChip` hard-codes 85 and 75
([:194-206](apps/web/src/app/features/student/records/records.component.ts#L194)) while
the server reads `crit.min_attendance_pct` off the active `PlacementCriteria`, defaulting
to `75.0` when there is none ([student.py:2051](apps/api-py/app/routers/student.py#L2051))
against a model default of `85` ([placement_criteria.py:27](apps/api-py/app/models/placement_criteria.py#L27)).
And `latestCgpa` ([:127-134](apps/web/src/app/features/student/records/records.component.ts#L127))
scans the results array backwards for the first *non-null* CGPA, whereas the server's
`_latest_cgpa` takes the **highest semester row and returns its `cgpa`, null included**
([student.py:1782-1789](apps/api-py/app/routers/student.py#L1782)).

### `academics.component.ts` — the screen that cannot work

Academics is the editable counterpart: qualifications and gap months are student-owned,
semester CGPA and backlogs are staff-imported and read-only. Its header states why that
split is not negotiable
([academics.component.ts:1-9](apps/web/src/app/features/student/academics/academics.component.ts#L1)):

> **Why it is like this.** "The student edits their qualifications and gap months;
> per-semester CGPA and backlogs are staff-imported and shown read-only, so they cannot
> mark their own backlogs cleared to slip past an eligibility gate."

The copy carries the same argument to the student: the page subtitle explains "Placement
eligibility reads your CGPA, live backlogs and total gap — so keeping this accurate is
what puts you on the right side of a drive's cut-off"
([academics.component.html:3](apps/web/src/app/features/student/academics/academics.component.html#L3)),
the semester section is labelled "Imported by the office — your CGPA and backlogs.
Read-only.", and the gap section says "A gap over a drive's limit disqualifies — record it
honestly." Those numbers match the model defaults: `max_live_backlogs` is 0 and
`max_gap_months` is 24 ([placement_criteria.py:30-31](apps/api-py/app/models/placement_criteria.py#L30)).

The design is sound. The wiring is not, in three independent ways.

**1. It reads a key the endpoint does not send.** The header also records the provenance —
"Ported from pod.ai's /academics" — and the interfaces are the Prisma-era camelCase shape,
never re-targeted at FastAPI
([:31-33](apps/web/src/app/features/student/academics/academics.component.ts#L31)):

```ts
interface Gap { twelfthToGradMo: number; diplomaToGradMo: number; gradToPgMo: number; otherMo: number }
interface Semester { semester: number; cgpa: number | null; closedBacklogs: number; liveBacklogs: number }
interface AcademicsView { qualifications: Qualification[]; gap: Gap; semesters: Semester[] }
```

`AcademicsOut` ([student.py:482-485](apps/api-py/app/routers/student.py#L482)) declares
only `qualifications` and `gap`, in snake_case, and there is no alias generator anywhere in
`apps/api-py`. So `load()`'s `this.semesters.set(v.semesters)`
([:83](apps/web/src/app/features/student/academics/academics.component.ts#L83)) stores
`undefined`, and the template's first branch after `@if (loaded())` is
`@if (semesters().length === 0)`
([academics.component.html:10](apps/web/src/app/features/student/academics/academics.component.html#L10))
— a `.length` read on `undefined` during change detection. `this.gap = v.gap` assigns the
snake_case object, so every `[(ngModel)]="gap.twelfthToGradMo"` binding reads `undefined`
and the "Total gap" caption evaluates to `NaN`. Chapter 12 §9 Rule 8 explains why
`ng build` stays green: the cast `(await res.json()) as AcademicsView` is an assertion the
compiler never tests, and `strict` is off.

**2. It saves to a route that does not exist.** `save()` PUTs to `/student/academics`
([:107-112](apps/web/src/app/features/student/academics/academics.component.ts#L107)). The
backend exposes exactly one academics route,
`@router.get("/academics", response_model=AcademicsOut)`
([student.py:487](apps/api-py/app/routers/student.py#L487)) — a repo-wide grep for
`academics` across `app/routers/` returns that one decorator and nothing else. Every save
is a 405, so the student sees "Could not save your academics." unconditionally. The
editable half of the screen — five level buttons, an eight-field qualification grid, four
gap inputs and a Save button — cannot persist anything.

**3. A `computed()` with no signal in it.** This one is worth studying because it is a
trap any Angular codebase can fall into
([:60-67](apps/web/src/app/features/student/academics/academics.component.ts#L60)):

```ts
  quals = signal<Qualification[]>([]);
  gap: Gap = { twelfthToGradMo: 0, diplomaToGradMo: 0, gradToPgMo: 0, otherMo: 0 };
  semesters = signal<Semester[]>([]);

  readonly totalGap = computed(() =>
    this.gap.twelfthToGradMo + this.gap.diplomaToGradMo + this.gap.gradToPgMo + this.gap.otherMo,
  );
```

`gap` is a plain mutable property, not a signal. `computed()` is lazy and memoises against
its *producer set*; with no producers it can never be invalidated, so "Total gap: N
months." is frozen at first read and never moves as the student types. By contrast
`liveBacklogs` on the very next line reads `this.semesters()`, a real signal, and is
properly reactive.

The corrective pattern already exists two directories away:
[resume/sections/education.component.ts:288-303](apps/web/src/app/features/student/resume/sections/education.component.ts#L288)
fetches `/student/results` **and** `/student/academics` in a `Promise.all` precisely
because academics carries no semesters, and guards with `academics.qualifications ?? []`.
Records reads `academics()!.gap.total_mo` directly rather than re-summing it. Two screens
consume this contract correctly; the orphan does not.

### Certifications and courses — the two well-behaved progress screens

Both were built later and both are textbook. `CertificationsComponent` holds a private
`rows = signal<CertRow[] | null>(null)` and exposes a `view` computed that decorates each
row with a chip, a bar tone and a human due read-out
([certifications.component.ts:70-101](apps/web/src/app/features/student/certifications/certifications.component.ts#L70)).
`dueReadout` turns `days_until_due` into "Overdue by 3 days" / "Due today" / "Due in 5
days" with a matching tone — colour and text together, per the rule, and the method's own
comment says so: "never colour-only". The template's ladder is
`@if (view(); as list)` → empty → grid, `@else if (error())`, `@else` "Loading…"
([certifications.component.html:11-86](apps/web/src/app/features/student/certifications/certifications.component.html#L11)),
and the progress bar is a real `role="progressbar"` with an `aria-label` naming the
certification.

`CoursesComponent` uses the other loading idiom — `courses = signal<Course[]>([])` plus
`state = signal<LoadState>('loading')`
([courses.component.ts:51-52](apps/web/src/app/features/student/courses/courses.component.ts#L51))
— and a four-way template ladder with a genuinely useful empty state: "You are not
enrolled in any courses yet. They appear here once the office registers you for the
semester." Its only client-side derivations are cosmetic: `stageLabel` title-cases the
enum (`EXCEL_ADVANCED` → "Excel Advanced") and `lecturesLeft` is
`Math.max(0, c.lectures_total - c.lectures_attended)`
([courses.component.ts:103-105](apps/web/src/app/features/student/courses/courses.component.ts#L103)).
Both files' headers note that all the real shaping — `progress_pct`, `next_task`,
`unlocks` — is computed server-side, rule-based, no LLM. These two are the closest thing
in the repo to a template for a new screen.
