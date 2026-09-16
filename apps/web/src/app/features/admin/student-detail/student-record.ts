/**
 * What the Student 360 screen reads, and the small pure functions that dress it.
 *
 * One place for the five payloads this screen asks the API for, and for the
 * dressing that turns them into the sentences the board prints. The component
 * holds the behaviour; a reader chasing "what is actually on this student"
 * reads this file and does not have to open a screen to find out.
 *
 * Every shape here is the EXACT snake_case body of an endpoint that exists on
 * `main` today. Nothing is modelled ahead of its endpoint — a client interface
 * for a payload nobody serves is the first half of a screen that quietly
 * renders invented data.
 *
 * `Student360Out` IS DECLARED NOW BECAUSE IT IS SERVED NOW. B4.5 landed
 * `GET /api/admin/students/{id}/360` (`app/routers/admin_student_360.py`), and
 * it is the read this screen was built around the absence of: the identity
 * block it returns is the roster's own `AdminStudentOut`, so the card at the
 * top of the detail screen and the row in the grid behind it cannot disagree.
 *
 * EVERY MISSING NUMBER ON THAT PAYLOAD IS `null` AND NEVER `0`, which is the
 * server's rule as much as this screen's: `results` is null for a semester with
 * no marks imported, `best_interview_score` is null when nothing was scored,
 * and the per-semester activity counts are null whenever the dates that would
 * attribute them to a semester were never recorded. A client that renders any
 * of those as a zero states a fact nobody measured.
 */

/** What an unreadable cell says. Never a zero: to the placement office a
 *  missing number and a zero mean opposite things. */
export const NOT_READABLE = '—';

// --------------------------------------------------------- API payloads --

/** `GET /api/admin/students` — `admin_students.AdminStudentOut`. */
export interface AdminStudentOut {
  student_id: string;
  user_id: string;
  name: string;
  email: string;
  usn: string | null;
  cohort_id: string | null;
  batch: string | null;
  department: string | null;
  department_id: string | null;
  mentor_id: string | null;
  mentor_user_id: string | null;
  mentor_name: string | null;
  current_stage: string;
  current_semester: number;
  enrolled_at: string;
  last_login_at: string | null;
}

/** `GET /api/admin/cohorts` — `console.CohortOut`. */
export interface CohortOut {
  id: string;
  code: string;
  /** The batch itself: a YEAR, "2026-28". */
  name: string;
  batch_label: string;
  /** The spine and the year in one sentence, composed by the server from the
   *  batch's own links: "General MBA - Finance · 2026-28". */
  display_label: string;
  degree_level: string;
  student_count: number;
}

/** `GET /api/admin/students/{id}/weekly` — `console.StudentWeeklyOut`. */
export interface StudentWeeklyOut {
  student_id: string;
  name: string;
  usn: string | null;
  weekly_hour_target: number;
  has_resume: boolean;
  weeks: { label: string; start: string; end: string }[];
  /** null for a week with no sessions at all — "no classes", never 0 %. */
  attendance_percent: (number | null)[];
  logged_hours: number[];
  skills_by_category: { category: string; count: number }[];
}

/** `GET /api/mentor/students/{id}/interviews` — `interview_records.InterviewSessionOut`. */
export interface InterviewSessionOut {
  id: string;
  specialization: string | null;
  status: string;
  terminal_reason: string | null;
  final_phase: string | null;
  answers_accepted: number;
  close_code: number | null;
  audio_recorded: boolean;
  started_at: string;
  ended_at: string | null;
  /** null means no evaluation row at all, which is a different fact from
   *  `'unavailable'` (a report was attempted and did not arrive). */
  report_status: string | null;
  overall_score: number | null;
}

/** `GET /api/mentor/students/{id}/badges` — `badges.BadgeDashboardOut`. */
export interface BadgeDashboardOut {
  stage: string;
  points_total: number;
  earned_total: number;
  badge_total: number;
}

/** `GET /api/mentor/students/{id}/ledger/summary` — `mentee_records.LedgerSummaryOut`. */
export interface LedgerSummaryOut {
  window_days: number;
  days_submitted: number;
  days_with_anything: number;
  mean_logged_hours: number;
  days: { day: string; status: string; logged_hours: number; reconciled: boolean }[];
}

/** `GET /api/mentor/students/{id}/english-baseline` — `student_programme.EnglishBaselineOut`.
 *  Only the fields this screen prints; every score on it is nullable on
 *  purpose, and a pending section must never render as a confident 0. */
export interface EnglishBaselineOut {
  exists: boolean;
  status: string;
  overall_score: number | null;
  band_label: string | null;
  provisional: boolean;
  sections_scored: number;
  sections_total: number;
  pending_label: string | null;
}

// ------------------------------------------- the composite read (B4.5) --

/** One successful sign-in. `login_events` records SUCCESSES ONLY — a failed
 *  attempt is the brute-force limiter's business, and putting it on a screen
 *  turns a mistyped password into an alarm. */
export interface SignIn360Out {
  at: string;
  door: string;
  ip: string | null;
  user_agent: string | null;
}

/** How this account gets in, and whether it still can.
 *
 *  `google_linked` IS A REAL ANSWER HERE, which is the opposite of
 *  `GET /api/auth/me`'s contract — there it is `None` everywhere except the one
 *  screen that asked, because absent means "not asked" and a client reading it
 *  as `false` tells somebody their Google sign-in is unlinked on the screen
 *  immediately after they used it. This endpoint IS the asking. */
export interface Login360Out {
  google_linked: boolean;
  /** True only when a real `scrypt:` hash is on the row. The SSO-only sentinel
   *  `grant_access` and `seed_roster` write is deliberately not one, so `false`
   *  means "Google or the onboarding walk, no password ever issued" — which is
   *  the fact the office needs when a student says they cannot sign in. */
  password_set: boolean;
  token_version: number;
  disabled: boolean;
  disabled_at: string | null;
  disable_reason: string | null;
  disabled_by_name: string | null;
  /** 2026-09-16: set when the account is REMOVED from the roster (rows kept),
   *  with the reason the office typed. Null on a listed student. */
  deleted_at: string | null;
  delete_reason: string | null;
  last_login_at: string | null;
  recent_sign_ins: SignIn360Out[];
}

/** Marks for one semester. Every score is nullable because `semester_results`
 *  stores them nullable: results published with no SGPA entered is a real
 *  state, and a `0` there is a mark nobody gave. */
export interface SemesterResults360Out {
  sgpa: number | null;
  cgpa: number | null;
  live_backlogs: number;
  closed_backlogs: number;
  subjects_recorded: number;
  result_class: string | null;
  published_on: string | null;
}

/** One semester of this student's record.
 *
 *  `activity_known` IS THE FLAG EVERY COUNT HANGS ON. A ledger day, an
 *  interview and a badge carry a DATE, and the only record of which semester a
 *  date fell in is `student_semester_history`. A semester no recorded move
 *  bounds has no window, so its counts are null — never zero, which would read
 *  as "they did nothing that semester". */
export interface Semester360Out {
  semester: number;
  is_current: boolean;
  started_on: string | null;
  ended_on: string | null;
  activity_known: boolean;
  /** Null when no results row exists: nothing was imported, which is not the
   *  same fact as a row of zeros. */
  results: SemesterResults360Out | null;
  ledger_days_reconciled: number | null;
  interviews: number | null;
  best_interview_score: number | null;
  badges_earned: number | null;
}

/** One row of `student_semester_history` — the record of an academic act. */
export interface SemesterMove360Out {
  id: string;
  /** `promote` | `graduate` | `ungraduate` | `hold_back`. */
  kind: string;
  from_semester: number;
  to_semester: number;
  effective_on: string;
  reason: string | null;
  by_user_id: string | null;
  /** Null when the account that made the move has since been removed — the FK
   *  is SET NULL deliberately, because the fact that a batch was promoted
   *  outlives the account of whoever promoted it. */
  by_name: string | null;
  created_at: string;
}

/** What this student is waiting on somebody for, or somebody on them.
 *  Counts, not lists: each one already has a screen that owns it. */
export interface OpenItems360Out {
  pending_uploads: number;
  pending_badge_claims: number;
  /** Evidence sent back for more information — waiting on the STUDENT. Kept
   *  apart from the claims above because the two need opposite conversations. */
  badge_claims_needing_info: number;
  unsubmitted_ledger_days: number;
  missing_profile_fields: string[];
  /** Totalled on the server so two clients cannot total it differently. */
  total: number;
}

/** Who mentors this student NOW — a present-tense fact off `students.mentor_id`,
 *  never a history. */
export interface MentorAssignment360Out {
  mentor_id: string | null;
  mentor_user_id: string | null;
  mentor_name: string | null;
}

/** `admin_mentoring.MentorAssignmentOut` — one spell of mentoring (B9.1).
 *
 *  EVERY DATE HERE IS NULLABLE AND THE NULLS MEAN DIFFERENT THINGS. `from_at`
 *  null is "mentoring since before this was recorded" — the seeded row for a
 *  pair that predates the table — and must never render as a blank or as the
 *  day the migration ran. `to_at` null is "this is the current pair". The two
 *  are read by the same card, and confusing them turns a live assignment into
 *  a closed one. */
export interface MentorSpell {
  id: string;
  mentor_id: string;
  mentor_name: string | null;
  from_at: string | null;
  to_at: string | null;
  kind: string;
  by_name: string | null;
  reason: string | null;
  end_kind: string | null;
  ended_by_name: string | null;
  end_reason: string | null;
}

/** Every mentor this student has had, newest first.
 *
 *  `available` IS NOT "does this deployment have the feature" — it always does
 *  now. It is "is there anything recorded for THIS student", and `note` says in
 *  the server's own words which of the two empty states this is: a pairing that
 *  predates `mentor_assignments`, or a student nobody has been seated with. */
export interface MentorHistory360Out {
  available: boolean;
  note: string;
  entries: MentorSpell[];
}

/** One line of the trail about this student. */
export interface AuditRow360Out {
  id: string;
  occurred_at: string;
  action: string;
  entity_type: string;
  entity_id: string;
  actor_user_id: string | null;
  actor_name: string | null;
  route: string | null;
}

/** One readiness check.
 *
 *  BRANCH ON `measured` FIRST. `met` is still present and still `false` on a
 *  check nobody has run, which is a compatibility decision the server documents
 *  — reading `met` alone renders a red "not met" over evidence that does not
 *  exist. */
export interface ReadinessFactorOut {
  label: string;
  met: boolean;
  detail: string;
  weight: number;
  measured: boolean;
}

/** `student.PlacementReadinessOut` — the weighted score, or the honest absence
 *  of one. `score` is null when too little is on record to score at all, and
 *  `band` then reads "Not assessed yet" rather than being blank. */
export interface PlacementReadinessOut {
  score: number | null;
  band: string;
  summary: string;
  factors: ReadinessFactorOut[];
}

/** `GET /api/admin/students/{id}/360` — `admin_student_360.Student360Out`. */
export interface Student360Out {
  identity: AdminStudentOut;
  login: Login360Out;
  /** The course's declared length, so the screen can say "semester 3 of 8".
   *  NULL on a batch whose course has not been given a shape — and the client
   *  must NOT fall back to 8 in the label, because a number nobody entered
   *  printed beside a real one is indistinguishable from a fact. */
  total_semesters: number | null;
  semesters: Semester360Out[];
  semester_history: SemesterMove360Out[];
  readiness: PlacementReadinessOut;
  open_items: OpenItems360Out;
  current_mentor: MentorAssignment360Out;
  mentor_history: MentorHistory360Out;
  recent_audit: AuditRow360Out[];
}

/** What one student has spent against the two interview ceilings, as reported
 *  by the cap reset (`interview_policy.CapUsageOut`).
 *
 *  BOTH NUMBERS ARE SHOWN because both can refuse the interview and they refuse
 *  it for different reasons: `completed` is the practice allowance, `attempts`
 *  counts every session row because each one billed an upstream handshake. */
export interface CapUsageOut {
  completed: number;
  attempts: number;
  daily_cap: number;
  attempt_cap: number;
  window_start: string;
  reset_applied: boolean;
}

/** `POST /api/admin/students/{id}/interview-cap/reset` —
 *  `interview_policy.CapResetOut`. */
export interface CapResetOut {
  id: string;
  student_id: string;
  at: string;
  reason: string;
  by_user_id: string | null;
  usage: CapUsageOut;
}

// ----------------------------------------------------------- vocabulary --

/** The REEP programme stages, as the office says them. Same list as the
 *  roster screen's, because the same `students.current_stage` is behind both. */
export const STAGES: { key: string; label: string }[] = [
  { key: 'REBOOT', label: 'Reboot' },
  { key: 'EXCEL', label: 'Excel' },
  { key: 'EXCEL_ADVANCED', label: 'Excel-Adv' },
  { key: 'ELEVATE', label: 'Elevate' },
];

/** The bound the API falls back to when a batch names no course, or the course
 *  names no length — `app/semester_bounds.py`'s `DEFAULT_MAX_SEMESTER`.
 *
 *  IT IS A FALLBACK AND NOT THE BOUND. B4.2 moved the real one onto the course
 *  (`academic_courses.total_semesters`), because a flat 8 was wrong in both
 *  directions: an MBA runs four semesters and accepted seven, a five-year
 *  integrated course has ten and was refused. `Student360Out.total_semesters`
 *  carries the real number when the course declares one, and the editor's
 *  select is built from that; this number is only what stands in when nothing
 *  answers, and the help text under the select says which of the two it is. */
export const DEFAULT_HIGHEST_SEMESTER = 8;

export function stageLabelOf(stageKey: string): string {
  const stage = STAGES.find((candidate) => candidate.key === stageKey);
  if (stage === undefined) {
    return stageKey;
  }
  return stage.label;
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length === 0 || words[0] === '') {
    return '?';
  }
  const first = words[0].charAt(0);
  if (words.length === 1) {
    return first.toUpperCase();
  }
  const last = words[words.length - 1].charAt(0);
  return `${first}${last}`.toUpperCase();
}

// ------------------------------------------------------------- dressing --

/** "11 Sep 2026", or the em dash. Dates on this screen are read by a person
 *  deciding whether to act, so the month is a word and never a number. */
export function formatDay(iso: string | null): string {
  if (iso === null || iso === '') {
    return NOT_READABLE;
  }
  const moment = new Date(iso);
  if (Number.isNaN(moment.getTime())) {
    return NOT_READABLE;
  }
  return moment.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** "11 Sep 2026, 14:02". */
export function formatMoment(iso: string | null): string {
  if (iso === null || iso === '') {
    return NOT_READABLE;
  }
  const moment = new Date(iso);
  if (Number.isNaN(moment.getTime())) {
    return NOT_READABLE;
  }
  const day = moment.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = moment.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}`;
}

// ------------------------------------------------- the semester timeline --

export interface SemesterStep {
  number: number;
  /** `done` for a semester the student has left, `active` for the one they are
   *  in, `pending` for one the COURSE declares and they have not reached.
   *
   *  `pending` only exists where `academic_courses.total_semesters` answered
   *  (B4.1/B4.2). A batch whose course names no length draws no pending steps
   *  at all — drawing a semester 4 the course may not have is inventing it,
   *  and the deployment fallback of 8 is not a fact about this programme. */
  state: 'done' | 'active' | 'pending';
  label: string;
}

/**
 * The strip: every semester up to the one they are in, plus the ones the course
 * says are still to come.
 *
 * `totalSemesters` is null on a batch whose course has no declared length, and
 * the strip then stops at the current semester exactly as it did before B4.1.
 * A total BELOW the current semester is not corrected here and not hidden — the
 * walk still runs to the semester the student is actually in, because the row
 * is what it is, and the caller says so in words.
 */
export function semesterStepsUpTo(
  currentSemester: number,
  totalSemesters: number | null = null,
): SemesterStep[] {
  const last = Math.max(currentSemester, totalSemesters ?? 0);
  const steps: SemesterStep[] = [];
  for (let number = 1; number <= last; number += 1) {
    let state: SemesterStep['state'] = 'pending';
    if (number < currentSemester) {
      state = 'done';
    } else if (number === currentSemester) {
      state = 'active';
    }
    steps.push({ number, state, label: `Semester ${number}` });
  }
  return steps;
}

// ---------------------------------------------------------- the activity --

/** One line of Recent activity. `icon` is a Material Symbols ligature that is
 *  in the app's subset — a glyph outside it renders as nothing at all. */
export interface ActivityEntry {
  id: string;
  icon: string;
  text: string;
  at: string;
}

function interviewLineOf(interview: InterviewSessionOut): string {
  const track = interview.specialization ?? 'General';
  const scored =
    interview.overall_score === null ? 'not scored' : `score ${interview.overall_score}`;
  return `Mock interview · ${track} · ${scored} · ${interview.status}`;
}

/**
 * The interviews, newest first, as activity lines.
 *
 * THESE ARE THE STUDENT'S OWN ACTS, and they are the only ones any endpoint
 * reports as a timeline for one student. The composite read did not change
 * that: it answers how many documents and badge claims are OUTSTANDING (counts,
 * on Open items) and what STAFF have done to this record (the trail, on the
 * Audit view), neither of which is a stream of the student's own activity. The
 * board's time sheet, leave, SWOC and upload lines are not composed here from
 * those counts, because a count is not an event and dating one would be
 * inventing when it happened.
 */
export function interviewActivityOf(
  interviews: InterviewSessionOut[],
  mostRecent: number,
): ActivityEntry[] {
  const newestFirst = [...interviews].sort(
    (left, right) => new Date(right.started_at).getTime() - new Date(left.started_at).getTime(),
  );
  const entries: ActivityEntry[] = [];
  for (const interview of newestFirst.slice(0, mostRecent)) {
    entries.push({
      id: interview.id,
      icon: 'record_voice_over',
      text: interviewLineOf(interview),
      at: formatMoment(interview.started_at),
    });
  }
  return entries;
}

export interface InterviewTally {
  total: number;
  scoredCount: number;
  bestScore: number | null;
}

/** How many interviews, and the best score among the ones that were scored.
 *  A session with no score is counted in `total` and left out of the best,
 *  because "sat three, scored none" and "sat three, scored 0" are different. */
export function interviewTallyOf(interviews: InterviewSessionOut[]): InterviewTally {
  const scores: number[] = [];
  for (const interview of interviews) {
    if (interview.overall_score !== null) {
      scores.push(interview.overall_score);
    }
  }
  if (scores.length === 0) {
    return { total: interviews.length, scoredCount: 0, bestScore: null };
  }
  return { total: interviews.length, scoredCount: scores.length, bestScore: Math.max(...scores) };
}

/** The mean attendance across the weeks that HAD sessions. Averaging over the
 *  whole window would report a week with no classes as 0 % and turn a holiday
 *  into a warning. */
export function meanAttendancePercentOf(weekly: StudentWeeklyOut | null): number | null {
  if (weekly === null) {
    return null;
  }
  const measured: number[] = [];
  for (const percent of weekly.attendance_percent) {
    if (percent !== null) {
      measured.push(percent);
    }
  }
  if (measured.length === 0) {
    return null;
  }
  const total = measured.reduce((running, percent) => running + percent, 0);
  return Math.round(total / measured.length);
}

/** Whole percent, clamped to 0..100, for a meter's width. */
export function percentOf(part: number, whole: number): number {
  if (whole <= 0) {
    return 0;
  }
  const value = Math.round((100 * part) / whole);
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}
