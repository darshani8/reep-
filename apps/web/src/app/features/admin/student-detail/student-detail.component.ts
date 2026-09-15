/**
 * Student 360 — one student, across every semester (spec §6, board
 * `design/admin/StudentDetail.html`).
 *
 * THIS SCREEN NAMES ONE STUDENT AND MUST NEVER WIDEN TO A LIST. Everything it
 * draws is that student's private record — marks, attendance, interviews,
 * mentor notes — so every read is by id and every refusal is theirs.
 *
 * THE COMPOSITE READ IS HERE (B4.5), AND IT REPLACED THE ROSTER TRICK. This
 * screen used to fetch `GET /api/admin/students` — the WHOLE roster — and pick
 * one row out of it, because there was no by-id read. There is now:
 *
 *   GET /api/admin/students/{id}/360     identity, login, every semester with
 *                                        its results and activity, the semester
 *                                        history, readiness, open items, the
 *                                        current mentor, B9.1's assignment
 *                                        history and the recent trail
 *
 * The identity block it returns is the roster's own `AdminStudentOut`, built by
 * `admin_students._one`, so the card at the top of this screen and the row in
 * the grid behind it cannot disagree about a batch, a faculty member or a
 * stage. The five reads below it are the ones the 360 deliberately does not
 * carry, because each is a whole panel of its own:
 *
 *   GET   /api/admin/students/{id}/weekly            six weeks of attendance
 *                                                    and ledger hours, skills
 *   GET   /api/mentor/students/{id}/interviews       every mock interview
 *   GET   /api/mentor/students/{id}/badges           earned / total / points
 *   GET   /api/mentor/students/{id}/ledger/summary   the last 14 days
 *   GET   /api/mentor/students/{id}/english-baseline the CEFR attempt
 *   GET   /api/admin/cohorts                         the batches, for Move batch
 *   PATCH /api/admin/students/{id}                   Edit profile and Move batch
 *   POST  /api/admin/users/{user_id}/sign-out-everywhere
 *   POST  /api/admin/students/{id}/interview-cap/reset   B6.4, reason required
 *
 * SIGN OUT EVERYWHERE TAKES THE USER ID AND NOT THE STUDENT ID. The two are
 * different rows and the route is on `/admin/users`, because a session belongs
 * to an ACCOUNT and not to a place on a roster; `AdminStudentOut.user_id` is
 * the one this screen sends. It asks before it posts, because it acts on
 * somebody else's devices, and the question says what happens to them.
 *
 * THREE READS ARE EXPECTED TO BE REFUSED, AND THE SCREEN SAYS SO RATHER THAN
 * LOOKING BROKEN. The ledger and the English baseline are gated on
 * `mentor.mentees`, which `_FACULTY_ONLY` in `app/governance.py` deliberately
 * keeps OUT of the Main Admin's baseline: the office account has no mentees.
 * `/weekly` is gated on `admin.analytics`, which this screen's own capability
 * (`admin.students`) does not imply. And the cap reset is gated on
 * `admin.interviews`. A 403 on any of them is the system working, so the card
 * prints the server's own sentence instead of an empty state that reads as a
 * bug.
 *
 * WHAT IS STILL NOT READABLE, AND WHY EACH IS SAID RATHER THAN DRAWN. A
 * student's CONSENT grant is read by its holder alone (`GET /api/interview/
 * consent` is the caller's own and there is no admin read of somebody else's).
 * Their interview COUNT has no read at all — the cap reset reports it, so this
 * screen knows it only after one has been made. SWOC is a board across every
 * student a grant reaches, LEAVE is a queue, and UPLOADS has only a
 * programme-wide pending list: none of the three has a by-id read, and this
 * screen does not widen to a roster to fake one. Those three tabs are disabled
 * with that reason on the control — plain `disabled`, no phase number, because
 * no task is coming to fill them.
 *
 * "NOTHING IS REWRITTEN ON PROMOTION" is the board's own headline on the
 * timeline and it is still true of the schema: promotion increments
 * `students.current_semester`, writes one `student_semester_history` row per
 * student, and every other table keeps the semester number it was written with.
 * `tests/test_admin_promotion.py` pins that column by column.
 *
 * RE-SEND INVITE IS NOT A STUDENT ACTION AND IS NOT DRAWN AS ONE. The board
 * shows it; `issue_activation` refuses a STUDENT on purpose, because a
 * student's equivalent is the onboarding walk, which proves the mailbox with a
 * six-digit code before a password is set. The control is disabled and the
 * card says where the link actually comes from.
 */

import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';
import { plural } from '../../../shared/text/plural.pipe';
import {
  type ActivityEntry,
  type AdminStudentOut,
  type AuditRow360Out,
  type BadgeDashboardOut,
  type CapResetOut,
  type CapUsageOut,
  type CohortOut,
  DEFAULT_HIGHEST_SEMESTER,
  type EnglishBaselineOut,
  type InterviewSessionOut,
  type LedgerSummaryOut,
  type MentorSpell,
  NOT_READABLE,
  type ReadinessFactorOut,
  STAGES,
  type Semester360Out,
  type SemesterMove360Out,
  type SemesterStep,
  type Student360Out,
  type StudentWeeklyOut,
  formatDay,
  formatMoment,
  initialsOf,
  interviewActivityOf,
  interviewTallyOf,
  meanAttendancePercentOf,
  percentOf,
  semesterStepsUpTo,
  stageLabelOf,
} from './student-record';

/** Days of ledger history the summary card asks for — the same fortnight a
 *  mentor opens the ledger to judge "are they keeping it up". */
const LEDGER_WINDOW_DAYS = 14;

/** Activity lines the card shows before it stops. The board draws five. */
const RECENT_ACTIVITY_LINES = 5;

/** The board's nine views. Six are answerable and three are not; `reason` is
 *  filled for exactly the three that are not, and it is the sentence that goes
 *  on the disabled control. No phase number: nothing is coming to fill them,
 *  and a phase badge past its phase is the stale label 45b91a9 deleted. */
interface TabSpec {
  key: string;
  label: string;
  reason: string | null;
}

const TABS: TabSpec[] = [
  { key: 'overview', label: 'Overview', reason: null },
  { key: 'results', label: 'Results', reason: null },
  { key: 'attendance', label: 'Attendance', reason: null },
  { key: 'timesheet', label: 'Time sheet', reason: null },
  { key: 'interviews', label: 'Interviews', reason: null },
  {
    key: 'swoc',
    label: 'SWOC',
    reason:
      'SWOC is read as a board across every student a grant reaches (/api/admin/swoc); ' +
      'there is no per-student read, and this screen never widens to a roster. Open SWOC notes.',
  },
  {
    key: 'leave',
    label: 'Leave',
    reason:
      'Leave is read as an approval queue, not as one person’s file — no endpoint answers ' +
      '“this student’s leave requests”. Open Leave requests.',
  },
  {
    key: 'uploads',
    label: 'Uploads',
    reason:
      'The only upload read is the programme-wide pending queue; nothing answers “this ' +
      'student’s documents”. How many are waiting for a verdict is on Open items.',
  },
  { key: 'audit', label: 'Audit', reason: null },
];

/** One read's outcome: the body, or the server's own sentence for refusing. */
interface ReadResult<T> {
  value: T | null;
  refusal: string | null;
}

/** One spell, dressed for the card. */
interface MentorSpellRow {
  id: string;
  who: string;
  /** "since 04 Sep 2026" / "04 Sep 2026 – 11 Sep 2026" / "since before this
   *  was recorded" — one phrase, composed where the nulls are understood. */
  when: string;
  current: boolean;
  /** "Assigned by S Kumar — thin year on the DM side", or "" when neither the
   *  actor nor the reason was recorded. */
  opened: string;
  closed: string;
}

/** `admin_faculty.AccountStateOut` — the answer from disable, enable and
 *  sign-out-everywhere.
 *
 *  `detail` is the SERVER'S OWN SENTENCE about what it just did ("Every device
 *  holding … has been signed out"), and it is shown verbatim: a client that
 *  composes its own version of that sentence is a second description of one
 *  act, and the two drift. */
interface AccountStateOut {
  user_id: string;
  email: string;
  role: string;
  disabled: boolean;
  disabled_at: string | null;
  disable_reason: string | null;
  token_version: number;
  links_revoked: number;
  detail: string;
}

/** How a spell ended, in the words a person would use. The stored vocabulary
 *  is `app/models/mentor_assignment.py`'s; an unknown value is printed as-is
 *  rather than swallowed, because a kind this client has not learned yet is
 *  still a fact about the student. */
function endLabelOf(kind: string): string {
  if (kind === 'release') return 'Released';
  if (kind === 'reassign') return 'Moved on';
  if (kind === 'faculty_disabled') return 'Released when the faculty account was disabled';
  return kind;
}

/** The vocabulary of `student_semester_history.kind`, in the office's words.
 *  An unrecognised kind is printed as stored — a value this client has not
 *  learned is still a move that happened. */
function moveLabelOf(kind: string): string {
  if (kind === 'promote') return 'Promoted';
  if (kind === 'graduate') return 'Graduated';
  if (kind === 'ungraduate') return 'Graduation reversed';
  if (kind === 'hold_back') return 'Held back';
  return kind;
}

/** "since 04 Sep 2026", "04 Sep 2026 – 11 Sep 2026", or the sentence a NULL
 *  `from_at` actually means. */
function whenOf(spell: MentorSpell): string {
  const from = spell.from_at === null ? null : formatDay(spell.from_at);
  const to = spell.to_at === null ? null : formatDay(spell.to_at);
  if (from === null && to === null) return 'Since before this was recorded';
  if (from === null) return `Until ${to}, from before this was recorded`;
  if (to === null) return `Since ${from}`;
  return `${from} – ${to}`;
}

/** "Assigned by S Kumar — thin year on the DM side". Either half may be
 *  missing: the CLI writers record no actor, and rows written before B9.2 made
 *  a reason compulsory carry none. An empty string draws no line at all, which
 *  is the honest rendering of "nobody wrote this down". */
function actOf(verb: string, by: string | null, reason: string | null): string {
  if (by === null && reason === null) return '';
  const who = by === null ? verb : `${verb} by ${by}`;
  return reason === null ? who : `${who} — ${reason}`;
}

@Component({
  selector: 'app-admin-student-detail',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './student-detail.component.html',
  styleUrl: './student-detail.component.scss',
})
export class AdminStudentDetailComponent {
  private readonly route = inject(ActivatedRoute);

  readonly studentId = this.route.snapshot.paramMap.get('id') ?? '';

  // --- what the screen has read -------------------------------------------

  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);

  /** B4.5's one read. Everything the board's panels are built from. */
  readonly record = signal<Student360Out | null>(null);

  readonly student = signal<AdminStudentOut | null>(null);
  readonly weekly = signal<StudentWeeklyOut | null>(null);
  readonly interviews = signal<InterviewSessionOut[]>([]);
  readonly badges = signal<BadgeDashboardOut | null>(null);
  readonly ledger = signal<LedgerSummaryOut | null>(null);
  readonly english = signal<EnglishBaselineOut | null>(null);
  readonly batches = signal<CohortOut[]>([]);

  /** Why the two `mentor.mentees` reads did not answer, in the API's own
   *  words. Almost always "You do not hold the 'Mentee log' capability", which
   *  is the Main Admin's baseline working as designed. */
  readonly menteeReadsRefusal = signal<string | null>(null);

  /** Why the batch list did not answer, if it did not. The select is then
   *  empty and the editor says why rather than looking broken. */
  readonly batchesRefusal = signal<string | null>(null);

  /** Why the six-week read did not answer, if it did not. `/weekly` is gated
   *  on `admin.analytics`, which this screen's own capability
   *  (`admin.students`, spec §6) does not imply: a faculty member granted the
   *  roster and not Analytics is refused here. That refusal used to render as
   *  "no sessions in the last six weeks", which is a claim about the student
   *  made out of a read that never happened. */
  readonly weeklyRefusal = signal<string | null>(null);

  /** Whether the Sign out everywhere question is on screen. The button asks
   *  before it posts because the devices it drops are somebody else's. */
  readonly confirmingSignOut = signal(false);

  // --- the tabs -----------------------------------------------------------

  readonly tabs = TABS;
  readonly tab = signal('overview');

  setTab(key: string): void {
    this.tab.set(key);
  }

  // --- the editor ---------------------------------------------------------

  readonly editorOpen = signal(false);
  /** Which button opened the editor. `batch` adds the line that says so; both
   *  save through the same PATCH, because moving a batch IS editing a
   *  student and two write paths for one field is how they drift. */
  readonly editorIntent = signal<'profile' | 'batch'>('profile');

  readonly formName = signal('');
  readonly formEmail = signal('');
  readonly formUsn = signal('');
  readonly formBatchId = signal('');
  readonly formStage = signal('');
  readonly formSemester = signal(1);

  readonly stages = STAGES;

  readonly notReadable = NOT_READABLE;

  // --- the interview cap reset (B6.4) -------------------------------------

  readonly capResetOpen = signal(false);
  readonly capReason = signal('');
  /** What the student has spent, as reported BY THE RESET. There is no read of
   *  this anywhere — the POST's response is the only place the pair appears —
   *  so it is null until one is made, and the card says that rather than
   *  drawing a zero. */
  readonly capUsage = signal<CapUsageOut | null>(null);

  constructor() {
    void this.loadEverything();
  }

  // --- the header ---------------------------------------------------------

  readonly studentName = computed(() => this.student()?.name ?? 'Student');

  readonly usnLabel = computed(() => this.student()?.usn ?? NOT_READABLE);

  readonly batchLabel = computed(() => this.student()?.batch ?? 'No batch yet');

  readonly departmentLabel = computed(() => this.student()?.department ?? 'No department yet');

  readonly mentorName = computed(() => this.student()?.mentor_name ?? null);

  readonly mentorInitials = computed(() => {
    const name = this.mentorName();
    if (name === null) {
      return '?';
    }
    return initialsOf(name);
  });

  /**
   * The spells, dressed. NEWEST FIRST, and the open one is the first row.
   *
   * AN EMPTY LIST IS NOT "NEVER HAD A MENTOR" — the server says which in
   * `mentor_history.note`, using the current assignment beside it, and the
   * template prints that sentence rather than composing a second one here.
   */
  readonly mentorSpells = computed<MentorSpellRow[]>(() =>
    (this.record()?.mentor_history.entries ?? []).map((spell) => ({
      id: spell.id,
      who: spell.mentor_name ?? 'A faculty account that is no longer on the roster',
      when: whenOf(spell),
      current: spell.to_at === null,
      opened: actOf(spell.kind === 'reassign' ? 'Moved here' : 'Assigned', spell.by_name, spell.reason),
      closed:
        spell.end_kind === null
          ? ''
          : actOf(endLabelOf(spell.end_kind), spell.ended_by_name, spell.end_reason),
    })),
  );

  /** The server's own sentence for an empty history, or "" when there are rows
   *  to draw instead. */
  readonly mentorHistoryNote = computed(() => this.record()?.mentor_history.note ?? '');

  readonly stageLabel = computed(() => {
    const row = this.student();
    if (row === null) {
      return NOT_READABLE;
    }
    return stageLabelOf(row.current_stage);
  });

  /** "Active" once they have signed in at least once, "Invited" until then —
   *  and "Disabled" over both, because an account that cannot get in is not
   *  described by either of the other two words.
   *
   *  NULL-SAFE ON PURPOSE. `this.student()?.last_login_at !== null` reads
   *  `undefined !== null`, which is TRUE, so before the row is read — and
   *  after a refused read — the header printed a green "Active" chip for a
   *  student nobody had looked up. */
  readonly hasSignedIn = computed(() => {
    const row = this.student();
    return row !== null && row.last_login_at !== null;
  });

  readonly isDisabled = computed(() => this.record()?.login.disabled === true);

  readonly accountStatusLabel = computed(() => {
    if (this.isDisabled()) {
      return 'Disabled';
    }
    return this.hasSignedIn() ? 'Active' : 'Invited';
  });

  /** The one sentence a disabled account owes the reader: when, by whom and
   *  why. B3.1 makes the reason compulsory, so it is always there. */
  readonly disabledLine = computed(() => {
    const login = this.record()?.login;
    if (login === undefined || !login.disabled) {
      return null;
    }
    const when = formatMoment(login.disabled_at);
    const who = login.disabled_by_name ?? 'an account that has since been removed';
    const why = login.disable_reason ?? 'no reason recorded';
    return `Disabled ${when} by ${who} — ${why}`;
  });

  readonly semesterLine = computed(() => {
    const row = this.student();
    if (row === null) {
      return NOT_READABLE;
    }
    const total = this.record()?.total_semesters ?? null;
    if (total === null) {
      return `semester ${row.current_semester}`;
    }
    return `semester ${row.current_semester} of ${total}`;
  });

  readonly enrolledLabel = computed(() => formatDay(this.student()?.enrolled_at ?? null));

  readonly lastSignInLabel = computed(() => {
    const row = this.student();
    if (row === null || row.last_login_at === null) {
      return 'Has not signed in yet';
    }
    return formatMoment(row.last_login_at);
  });

  // --- identity & login ----------------------------------------------------

  readonly signIns = computed(() => this.record()?.login.recent_sign_ins ?? []);

  /** "A password and Google", "Google only", "The onboarding walk only". Two
   *  booleans, said as the fact the office needs when somebody cannot get in —
   *  never as two green ticks, which do not answer the question. */
  readonly doorsLine = computed(() => {
    const login = this.record()?.login;
    if (login === undefined) {
      return NOT_READABLE;
    }
    if (login.password_set && login.google_linked) {
      return 'A password, and Google sign-in linked';
    }
    if (login.google_linked) {
      return 'Google sign-in only — no password has ever been issued';
    }
    if (login.password_set) {
      return 'A password — no Google account linked';
    }
    return 'Neither yet — the onboarding link is how the first password is set';
  });

  /** The two ceilings, as reported by the last reset. Null until one is made:
   *  nothing else reports these numbers, and a zero would read as "they have
   *  not practised today" when the truth is that nobody asked. */
  readonly capLine = computed(() => {
    const usage = this.capUsage();
    if (usage === null) {
      return null;
    }
    return (
      `${usage.completed} of ${usage.daily_cap} completed · ` +
      `${usage.attempts} of ${usage.attempt_cap} attempts · counted from ` +
      `${formatMoment(usage.window_start)}`
    );
  });

  // --- semester timeline --------------------------------------------------

  readonly semesterSteps = computed<SemesterStep[]>(() => {
    const row = this.student();
    if (row === null) {
      return [];
    }
    return semesterStepsUpTo(row.current_semester, this.record()?.total_semesters ?? null);
  });

  /** Everything the timeline needs about one step, keyed by its number, so the
   *  template can print a semester's results and activity under it. */
  readonly semesterByNumber = computed<Map<number, Semester360Out>>(() => {
    const map = new Map<number, Semester360Out>();
    for (const semester of this.record()?.semesters ?? []) {
      map.set(semester.semester, semester);
    }
    return map;
  });

  semesterOf(number: number): Semester360Out | null {
    return this.semesterByNumber().get(number) ?? null;
  }

  /** "4 ledger days · 2 interviews · 1 badge", or the sentence that says why
   *  there are no counts. Null counts are NOT zeros: a semester with no
   *  recorded start and end has no window to count over. */
  activityLineOf(semester: Semester360Out | null): string {
    if (semester === null) {
      return 'Nothing recorded for this semester.';
    }
    if (!semester.activity_known) {
      return (
        'When this semester began and ended was never recorded, so ledger days, ' +
        'interviews and badges cannot be attributed to it.'
      );
    }
    const parts = [
      `${plural(semester.ledger_days_reconciled ?? 0, 'reconciled day')}`,
      `${plural(semester.interviews ?? 0, 'interview')}`,
      `${plural(semester.badges_earned ?? 0, 'badge')}`,
    ];
    return parts.join(' · ');
  }

  /** The dates a semester ran between, when both were recorded. */
  windowOf(semester: Semester360Out | null): string | null {
    if (semester === null || semester.started_on === null) {
      return null;
    }
    const from = formatDay(semester.started_on);
    if (semester.ended_on === null) {
      return `from ${from}`;
    }
    return `${from} – ${formatDay(semester.ended_on)}`;
  }

  /** The course's length, or the honest absence of one. */
  readonly courseLengthLine = computed(() => {
    const total = this.record()?.total_semesters ?? null;
    if (total === null) {
      return (
        'This batch names no course with a semester count, so how many semesters the ' +
        'programme runs is not on record. Set Total semesters on the course to bound it.'
      );
    }
    return `This programme runs ${plural(total, 'semester')}.`;
  });

  // --- the semesters the editor's select offers ---------------------------

  /** Bounded by the COURSE where the course says so, and by the deployment
   *  fallback where it does not — the same answer `app/semester_bounds.py`
   *  gives the PATCH, so the select cannot offer a number the save refuses. */
  readonly semesters = computed<number[]>(() => {
    const declared = this.record()?.total_semesters ?? null;
    const current = this.student()?.current_semester ?? 1;
    // A student already sitting above the course's declared length is a row
    // that exists; the select must still be able to show where they are.
    const highest = Math.max(declared ?? DEFAULT_HIGHEST_SEMESTER, current);
    return Array.from({ length: highest }, (_unused, index) => index + 1);
  });

  readonly semesterHelp = computed(() => {
    const declared = this.record()?.total_semesters ?? null;
    if (declared === null) {
      return (
        `This batch names no course with a semester count, so the deployment default of ` +
        `${DEFAULT_HIGHEST_SEMESTER} applies.`
      );
    }
    return `Bounded by the course, which runs ${plural(declared, 'semester')}.`;
  });

  // --- readiness (B6.3, computed on the server) ---------------------------

  readonly readiness = computed(() => this.record()?.readiness ?? null);

  /** The chip beside the score. `Not assessed yet` is a WORD and not a blank,
   *  and it is the server's, so the two surfaces that draw readiness (the
   *  student's own home card and this panel) say the same thing. */
  readonly readinessTone = computed(() => {
    const readiness = this.readiness();
    if (readiness === null || readiness.score === null) {
      return 'neutral';
    }
    if (readiness.score < 40) {
      return 'risk';
    }
    if (readiness.score < 70) {
      return 'warn';
    }
    return 'good';
  });

  /** Every check, with the unmeasured ones kept apart rather than drawn as
   *  failures — `measured: false` means nobody has run the check, which is not
   *  the same fact as failing it. */
  readonly readinessFactors = computed<ReadinessFactorOut[]>(
    () => this.readiness()?.factors ?? [],
  );

  factorChip(factor: ReadinessFactorOut): { tone: string; label: string } {
    if (!factor.measured) {
      return { tone: 'neutral', label: 'Not measured' };
    }
    return factor.met ? { tone: 'good', label: 'Met' } : { tone: 'warn', label: 'Not met' };
  }

  readonly meanAttendancePercent = computed(() => meanAttendancePercentOf(this.weekly()));

  /** What the attendance meter says instead of a bar. "No sessions" is a fact
   *  about the six weeks and may only be printed when the six weeks were
   *  actually read; an unread window says so. */
  readonly attendanceNoneLine = computed(() => {
    if (this.weekly() === null) {
      return 'not readable';
    }
    return 'no sessions in the last six weeks';
  });

  readonly badgesEarnedPercent = computed(() => {
    const dashboard = this.badges();
    if (dashboard === null) {
      return null;
    }
    return percentOf(dashboard.earned_total, dashboard.badge_total);
  });

  readonly interviewTally = computed(() => interviewTallyOf(this.interviews()));

  readonly bestInterviewScore = computed(() => this.interviewTally().bestScore);

  /** What the meter says instead of a bar. "3 sat, none scored" and "none sat"
   *  are different facts, and neither is a zero. */
  readonly interviewsSatLine = computed(() => {
    const tally = this.interviewTally();
    if (tally.total === 0) {
      return 'none sat';
    }
    return `${tally.total} sat, none scored`;
  });

  readonly ledgerSubmittedPercent = computed(() => {
    const summary = this.ledger();
    if (summary === null) {
      return null;
    }
    return percentOf(summary.days_submitted, summary.window_days);
  });

  readonly englishLine = computed(() => {
    const attempt = this.english();
    if (attempt === null) {
      return null;
    }
    if (!attempt.exists) {
      return 'Not sat yet';
    }
    if (attempt.pending_label !== null && attempt.pending_label !== '') {
      return attempt.pending_label;
    }
    if (attempt.band_label === null) {
      return `${attempt.sections_scored} of ${plural(attempt.sections_total, 'section')} scored`;
    }
    return attempt.band_label;
  });

  readonly verifiedSkillCount = computed(() => {
    const record = this.weekly();
    if (record === null) {
      return null;
    }
    let total = 0;
    for (const category of record.skills_by_category) {
      total += category.count;
    }
    return total;
  });

  // --- open items (the server's counts, B4.5) -----------------------------

  /** The board's Open items, every line now a real count from the composite
   *  read. `total` is the server's own sum, so this client cannot disagree
   *  with the tab badge about how much is outstanding. */
  readonly openItems = computed<{ chip: string; tone: string; text: string }[]>(() => {
    const open = this.record()?.open_items;
    if (open === undefined) {
      return [];
    }
    const items: { chip: string; tone: string; text: string }[] = [];
    if (open.pending_uploads > 0) {
      items.push({
        chip: 'Uploads',
        tone: 'warn',
        text: `${plural(open.pending_uploads, 'document')} waiting for a staff verdict`,
      });
    }
    if (open.pending_badge_claims > 0) {
      items.push({
        chip: 'Badges',
        tone: 'warn',
        text: `${plural(open.pending_badge_claims, 'badge claim')} waiting for verification`,
      });
    }
    if (open.badge_claims_needing_info > 0) {
      items.push({
        chip: 'Badges',
        tone: 'neutral',
        text: `${plural(open.badge_claims_needing_info, 'claim')} sent back for more information — waiting on the student`,
      });
    }
    if (open.unsubmitted_ledger_days > 0) {
      items.push({
        chip: 'Time sheet',
        tone: 'warn',
        text: `${plural(open.unsubmitted_ledger_days, 'day')} started and never submitted`,
      });
    }
    if (open.missing_profile_fields.length > 0) {
      items.push({
        chip: 'Profile',
        tone: 'neutral',
        text: `Not filled in: ${open.missing_profile_fields.join(', ')}`,
      });
    }
    return items;
  });

  readonly openItemsTotal = computed(() => this.record()?.open_items.total ?? 0);

  // --- recent activity ----------------------------------------------------

  readonly recentActivity = computed<ActivityEntry[]>(() =>
    interviewActivityOf(this.interviews(), RECENT_ACTIVITY_LINES),
  );

  // --- the tabbed panels --------------------------------------------------

  /** Every semester that has a results row. A semester with none is left out
   *  rather than drawn as a line of dashes — nothing was imported, and an
   *  empty row invites the reader to wonder what the marks were. */
  readonly resultRows = computed<Semester360Out[]>(() =>
    (this.record()?.semesters ?? []).filter((semester) => semester.results !== null),
  );

  readonly semesterMoves = computed<SemesterMove360Out[]>(
    () => this.record()?.semester_history ?? [],
  );

  moveLabel(kind: string): string {
    return moveLabelOf(kind);
  }

  readonly auditRows = computed<AuditRow360Out[]>(() => this.record()?.recent_audit ?? []);

  /** The weeks of the six-week window, zipped into rows the table can draw.
   *  `attendance_percent` is null for a week with no sessions at all, which is
   *  "no classes" and never 0 %. */
  readonly attendanceWeeks = computed(() => {
    const record = this.weekly();
    if (record === null) {
      return [];
    }
    return record.weeks.map((week, index) => ({
      label: week.label,
      start: week.start,
      end: week.end,
      percent: record.attendance_percent[index] ?? null,
      hours: record.logged_hours[index] ?? 0,
    }));
  });

  /** A week's attendance as text AND colour, never colour alone.
   *
   *  NULL IS "NO SESSIONS THAT WEEK" AND NOT 0 %. `console`'s weekly read
   *  returns null for a week that held no classes, and rendering it as a red
   *  zero turns a holiday into a warning on somebody's record — which is the
   *  same mistake `_attendance_pct` made when it returned 0.0 with nothing
   *  imported. */
  attendanceChip(percent: number | null): { tone: string; label: string } {
    if (percent === null) {
      return { tone: 'neutral', label: 'No sessions' };
    }
    return { tone: percent >= 75 ? 'good' : 'warn', label: `${percent}%` };
  }

  readonly interviewRows = computed(() =>
    [...this.interviews()].sort(
      (left, right) => new Date(right.started_at).getTime() - new Date(left.started_at).getTime(),
    ),
  );

  readonly ledgerDays = computed(() => this.ledger()?.days ?? []);

  formatDay(iso: string | null): string {
    return formatDay(iso);
  }

  formatMoment(iso: string | null): string {
    return formatMoment(iso);
  }

  // --- the editor ---------------------------------------------------------

  readonly editorTitle = computed(() =>
    this.editorIntent() === 'batch' ? 'Move batch' : 'Edit profile',
  );

  readonly canSaveProfile = computed(() => {
    if (this.busy()) {
      return false;
    }
    return this.formName().trim() !== '' && this.formEmail().trim() !== '';
  });

  openEditor(intent: 'profile' | 'batch'): void {
    const row = this.student();
    if (row === null) {
      return;
    }
    this.formName.set(row.name);
    this.formEmail.set(row.email);
    this.formUsn.set(row.usn ?? '');
    this.formBatchId.set(row.cohort_id ?? '');
    this.formStage.set(row.current_stage);
    this.formSemester.set(row.current_semester);
    this.editorIntent.set(intent);
    this.editorOpen.set(true);
  }

  closeEditor(): void {
    this.editorOpen.set(false);
  }

  onName(value: string): void {
    this.formName.set(value);
  }

  onEmail(value: string): void {
    this.formEmail.set(value);
  }

  onUsn(value: string): void {
    this.formUsn.set(value);
  }

  onBatch(value: string): void {
    this.formBatchId.set(value);
  }

  onStage(value: string): void {
    this.formStage.set(value);
  }

  onSemester(value: string): void {
    const semester = Number(value);
    if (Number.isNaN(semester)) {
      return;
    }
    this.formSemester.set(semester);
  }

  async saveProfile(): Promise<void> {
    const row = this.student();
    if (row === null || this.busy()) {
      return;
    }
    const changes = this.changedFields(row);
    if (Object.keys(changes).length === 0) {
      this.flash.set('Nothing changed.');
      this.editorOpen.set(false);
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.flash.set(null);
    try {
      const response = await fetch(`${environment.apiBase}/admin/students/${this.studentId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      });
      if (!response.ok) {
        this.error.set(await this.detailOf(response));
        return;
      }
      const saved = (await response.json()) as AdminStudentOut;
      this.student.set(saved);
      this.editorOpen.set(false);
      this.flash.set('Saved.');
      // The batch may have changed, and with it the course that bounds the
      // semesters and every per-semester panel below. Re-read rather than
      // patching the composite by hand: one writer for that shape.
      await this.load360();
    } catch {
      this.error.set('The server could not be reached. Nothing was changed.');
    } finally {
      this.busy.set(false);
    }
  }

  /** Only what the reader actually changed. `cohort_id: null` is the explicit
   *  un-seat the API reads through `model_fields_set`, so an empty batch
   *  select has to travel as a null and never as an omission. */
  private changedFields(row: AdminStudentOut): Record<string, unknown> {
    const changes: Record<string, unknown> = {};
    const name = this.formName().trim();
    if (name !== row.name) {
      changes['name'] = name;
    }
    const email = this.formEmail().trim().toLowerCase();
    if (email !== row.email) {
      changes['email'] = email;
    }
    const usn = this.formUsn().trim().toUpperCase();
    const currentUsn = row.usn ?? '';
    if (usn !== currentUsn) {
      changes['usn'] = usn === '' ? null : usn;
    }
    const batchId = this.formBatchId();
    const currentBatchId = row.cohort_id ?? '';
    if (batchId !== currentBatchId) {
      changes['cohort_id'] = batchId === '' ? null : batchId;
    }
    if (this.formStage() !== row.current_stage) {
      changes['current_stage'] = this.formStage();
    }
    if (this.formSemester() !== row.current_semester) {
      changes['current_semester'] = this.formSemester();
    }
    return changes;
  }

  // --- sign out everywhere (B3.6) -----------------------------------------

  /** Asks first. The FACULTY screen calls this same endpoint without asking
   *  (`features/admin/faculty`, which argues it is reversible and sits beside a
   *  Disable dialog that sets the gradient). This button stands alone among
   *  disabled controls, where a misclick is likelier and nothing else nearby
   *  confirms. Both readings are defensible; the divergence is deliberate and
   *  cross-referenced so whoever settles it changes both. */
  askSignOutEverywhere(): void {
    if (this.student() === null || this.busy()) {
      return;
    }
    this.error.set(null);
    this.flash.set(null);
    this.confirmingSignOut.set(true);
  }

  cancelSignOutEverywhere(): void {
    this.confirmingSignOut.set(false);
  }

  /**
   * `POST /api/admin/users/{user_id}/sign-out-everywhere`.
   *
   * THE ACCOUNT'S ID, NOT THE STUDENT'S. A session hangs off `users`, so the
   * route is on `/admin/users` and the id it wants is `user_id` — sending
   * `studentId` here reaches a different row's account or, more often, a 404
   * that reads as a broken button.
   *
   * Nothing on this screen is re-read afterwards, deliberately: the endpoint
   * changes `token_version` and nothing this screen draws. `last_login_at` is
   * untouched — the student HAS signed in before, and rewriting the header to
   * say otherwise would be this client inventing a fact the server did not
   * report. The server's own `detail` is the whole confirmation.
   */
  async signOutEverywhere(): Promise<void> {
    const row = this.student();
    if (row === null || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.flash.set(null);
    try {
      const response = await fetch(
        `${environment.apiBase}/admin/users/${row.user_id}/sign-out-everywhere`,
        { method: 'POST', credentials: 'include' },
      );
      if (!response.ok) {
        this.error.set(await this.detailOf(response));
        return;
      }
      const state = (await response.json()) as AccountStateOut;
      this.confirmingSignOut.set(false);
      this.flash.set(state.detail);
    } catch {
      this.error.set('The server could not be reached. Nothing was changed.');
    } finally {
      this.busy.set(false);
    }
  }

  // --- the interview cap reset (B6.4) -------------------------------------

  askCapReset(): void {
    if (this.student() === null || this.busy()) {
      return;
    }
    this.error.set(null);
    this.flash.set(null);
    this.capReason.set('');
    this.capResetOpen.set(true);
  }

  cancelCapReset(): void {
    this.capResetOpen.set(false);
  }

  onCapReason(value: string): void {
    this.capReason.set(value);
  }

  readonly canResetCap = computed(() => !this.busy() && this.capReason().trim() !== '');

  /**
   * `POST /api/admin/students/{id}/interview-cap/reset`.
   *
   * THE REASON IS NOT OPTIONAL, and the button is disabled without one rather
   * than posting a blank and rendering the 422. B3.1's precedent: this is the
   * other console action whose effect is invisible from the console a day
   * later — the 24-hour window rolls, the count falls back to normal, and
   * nothing on any screen says why a student had eleven interviews on Tuesday.
   *
   * IT DOES NOT ZERO A COUNTER, and the copy must not say it does. The cap is a
   * rolling count, so the reset is an extra LOWER BOUND on the window it is
   * taken over: a student mid-day never loses attempts already counted, and a
   * second reset can only move the bound forward.
   *
   * Gated on `admin.interviews`, which this screen's own capability does not
   * imply — a 403 here is the system working and the server's sentence is what
   * the reader gets.
   */
  async resetCap(): Promise<void> {
    const reason = this.capReason().trim();
    if (this.student() === null || this.busy() || reason === '') {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.flash.set(null);
    try {
      const response = await fetch(
        `${environment.apiBase}/admin/students/${this.studentId}/interview-cap/reset`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        },
      );
      if (!response.ok) {
        this.error.set(await this.detailOf(response));
        return;
      }
      const reset = (await response.json()) as CapResetOut;
      this.capUsage.set(reset.usage);
      this.capResetOpen.set(false);
      this.capReason.set('');
      this.flash.set(
        `${this.studentName()} may practise again — the 24-hour window is now counted from ` +
          `${formatMoment(reset.at)}, and your reason is on the audit trail.`,
      );
    } catch {
      this.error.set('The server could not be reached. Nothing was changed.');
    } finally {
      this.busy.set(false);
    }
  }

  // --- reading ------------------------------------------------------------

  private async loadEverything(): Promise<void> {
    if (this.studentId === '') {
      this.error.set('No student was named in the address.');
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    await this.load360();
    if (this.student() === null) {
      this.loading.set(false);
      return;
    }
    await Promise.all([
      this.loadWeekly(),
      this.loadInterviews(),
      this.loadBadges(),
      this.loadMenteeRecords(),
      this.loadBatches(),
    ]);
    this.loading.set(false);
  }

  /**
   * B4.5's composite read — the one that replaced picking a row out of the
   * whole roster.
   *
   * A refusal here is the screen's own refusal and stops everything: both
   * fences run inside this endpoint (`require_capability` with the student's
   * ancestry as the target, and rule 2's `_assert_can_access_student`), so a
   * 403 means this account may not read this student at all, and drawing the
   * panels around an empty middle would be a screen pretending to work.
   */
  private async load360(): Promise<void> {
    const record = await this.read<Student360Out>(`/admin/students/${this.studentId}/360`);
    if (record.value === null) {
      this.error.set(record.refusal ?? 'This student could not be read.');
      return;
    }
    this.record.set(record.value);
    this.student.set(record.value.identity);
  }

  private async loadWeekly(): Promise<void> {
    const weekly = await this.read<StudentWeeklyOut>(`/admin/students/${this.studentId}/weekly`);
    this.weekly.set(weekly.value);
    this.weeklyRefusal.set(weekly.refusal);
  }

  private async loadInterviews(): Promise<void> {
    const interviews = await this.read<InterviewSessionOut[]>(
      `/mentor/students/${this.studentId}/interviews`,
    );
    this.interviews.set(interviews.value ?? []);
  }

  private async loadBadges(): Promise<void> {
    const badges = await this.read<BadgeDashboardOut>(`/mentor/students/${this.studentId}/badges`);
    this.badges.set(badges.value);
  }

  /** The two reads gated on `mentor.mentees`. They share one refusal line
   *  because they share one capability: telling the reader twice that the
   *  office account does not hold the Mentee log is noise, not information. */
  private async loadMenteeRecords(): Promise<void> {
    const ledger = await this.read<LedgerSummaryOut>(
      `/mentor/students/${this.studentId}/ledger/summary?days=${LEDGER_WINDOW_DAYS}`,
    );
    this.ledger.set(ledger.value);
    const english = await this.read<EnglishBaselineOut>(
      `/mentor/students/${this.studentId}/english-baseline`,
    );
    this.english.set(english.value);
    if (ledger.value === null) {
      this.menteeReadsRefusal.set(ledger.refusal);
      return;
    }
    if (english.value === null) {
      this.menteeReadsRefusal.set(english.refusal);
    }
  }

  private async loadBatches(): Promise<void> {
    const cohorts = await this.read<CohortOut[]>('/admin/cohorts');
    this.batches.set(cohorts.value ?? []);
    this.batchesRefusal.set(cohorts.refusal);
  }

  private async read<T>(path: string): Promise<ReadResult<T>> {
    try {
      const response = await fetch(`${environment.apiBase}${path}`, { credentials: 'include' });
      if (!response.ok) {
        return { value: null, refusal: await this.detailOf(response) };
      }
      return { value: (await response.json()) as T, refusal: null };
    } catch {
      return { value: null, refusal: 'The server could not be reached.' };
    }
  }

  /** FastAPI answers a schema error with `detail` as a LIST; rendered raw it
   *  reads "[object Object]". The server's refusals name the rule they are
   *  keeping, so its own sentence is kept wherever there is one. */
  private async detailOf(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { detail?: unknown };
      const detail = body.detail;
      if (typeof detail === 'string') {
        return detail;
      }
      if (Array.isArray(detail)) {
        const messages: string[] = [];
        for (const entry of detail) {
          const message = (entry as { msg?: string }).msg;
          if (typeof message === 'string') {
            messages.push(message);
          }
        }
        if (messages.length > 0) {
          return messages.join(' ');
        }
      }
    } catch {
      /* not JSON — fall through to the status */
    }
    return `The request was refused (${response.status}).`;
  }
}
