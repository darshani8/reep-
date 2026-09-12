/**
 * What the Student 360 screen reads, and the small pure functions that dress it.
 *
 * One place for the five payloads this screen asks the API for, and for the
 * dressing that turns them into the sentences the board prints. The component
 * holds the behaviour; a reader chasing "what is actually on this student"
 * reads this file and does not have to open a screen to find out.
 *
 * Every shape here is the EXACT snake_case body of an endpoint that exists on
 * `main` today. Nothing is modelled ahead of its endpoint: the composite read
 * `GET /api/admin/students/{id}/360` (B4.5) is not declared here, because a
 * client interface for a payload nobody serves is the first half of a screen
 * that quietly renders invented data.
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
  name: string;
  batch_label: string;
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

// ----------------------------------------------------------- vocabulary --

/** The REEP programme stages, as the office says them. Same list as the
 *  roster screen's, because the same `students.current_stage` is behind both. */
export const STAGES: { key: string; label: string }[] = [
  { key: 'REBOOT', label: 'Reboot' },
  { key: 'EXCEL', label: 'Excel' },
  { key: 'EXCEL_ADVANCED', label: 'Excel-Adv' },
  { key: 'ELEVATE', label: 'Elevate' },
];

/** `AdminStudentPatch.current_semester` is bounded 1..8 on the API. */
export const HIGHEST_SEMESTER = 8;

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
  /** `done` for a semester the student has left, `active` for the one they
   *  are in. There is deliberately no `pending`: how many semesters the
   *  course has is `academic_courses.total_semesters`, which arrives with
   *  B4.1, and drawing a semester 4 the course may not have is inventing it. */
  state: 'done' | 'active';
  label: string;
}

export function semesterStepsUpTo(currentSemester: number): SemesterStep[] {
  const steps: SemesterStep[] = [];
  for (let number = 1; number <= currentSemester; number += 1) {
    steps.push({
      number,
      state: number < currentSemester ? 'done' : 'active',
      label: `Semester ${number}`,
    });
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
 * This is the only part of the board's Recent activity card that any endpoint
 * on `main` can answer. The time sheet, leave, SWOC and upload lines beside it
 * on the board come from the composite read (B4.5) and are not invented here.
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
