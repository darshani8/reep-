/**
 * The Jobs sheet's row: what `GET /api/admin/jobs` answers, and what the grid
 * draws from it.
 *
 * WHAT THE BOARD DRAWS THAT NOTHING ANSWERS YET, and why each is an em dash
 * here rather than a number:
 *
 *   Track      `jobs` carries no track column. B12.1 (Phase 4) adds
 *              `tracks text[]` and makes it decide which students see the
 *              posting.
 *   CTC        A posting records no pay. Nothing in 04-backend-changes.md adds
 *              one either — B12.3's "median CTC" is computed from OFFERS, which
 *              is a different record — so this is a gap in the plan, not a task
 *              waiting its turn, and it is reported as one.
 *   Eligible   The board reads "6 / 13": applicants over the students the
 *              posting is open to. The numerator is real; the denominator is
 *              B12.1's eligibility, so the column shows the count alone.
 *
 * A plausible number in any of those cells is indistinguishable from working
 * software in a screenshot, which is the one thing this phase must not ship.
 */

/** Rows per page the status bar offers, and the one it starts on. */
export const PAGE_SIZES = [10, 25, 50, 100];
export const DEFAULT_PAGE_SIZE = 10;

/** The comfortable and compact row heights (01-design-system.md §4). */
export const COMFORTABLE_ROW_HEIGHT_PX = 40;
export const COMPACT_ROW_HEIGHT_PX = 36;

/** A posting inside this many days of its closing date reads "closing soon" —
 *  the same reading the student's jobs board gives it. */
export const CLOSING_SOON_DAYS = 7;

const MILLISECONDS_IN_A_DAY = 86_400_000;

/** What an unreadable cell says. Never a zero: to a placement office a missing
 *  number and a zero mean opposite things. */
export const NOT_READABLE = '—';

/** Real columns that are off the board's six, so they start hidden and the
 *  Columns popover offers them rather than losing them: the degree level, and
 *  the two per-posting eligibility gates the endpoint answers. */
export const INITIALLY_HIDDEN_COLUMN_IDS = ['level', 'minCgpa', 'maxLiveBacklogs'];

/** Long enough that typing does not fire a filter per keystroke. */
export const SEARCH_DEBOUNCE_MS = 200;

// ------------------------------------------------------- the API payloads --

/** `JobSheetOut` in `app/routers/console.py`. */
export interface JobPostingApiRow {
  id: string;
  title: string;
  company: string;
  degree_level: string;
  location: string | null;
  apply_url: string | null;
  required_skills: string[];
  posted_on: string;
  closes_on: string | null;
  min_cgpa: number | null;
  max_live_backlogs: number | null;
  applicants: number;
}

/** `CriteriaOut` in `app/routers/console.py`, narrowed to the two gates the
 *  posting form inherits. */
export interface PlacementCriteriaApi {
  name: string;
  min_cgpa: number;
  max_live_backlogs: number;
}

// ------------------------------------------------------------- the screen --

export type DeadlineTone = 'good' | 'warn' | 'neutral';

/** One posting, dressed for the grid. */
export interface JobPostingRow {
  jobId: string;
  title: string;
  company: string;
  location: string | null;
  /** The pinned cell's second line: "Deloitte · Bengaluru". */
  companyAndLocation: string;
  degreeLevel: string;
  applyUrl: string | null;
  /** The slugs the student board matches a resume against. No screen writes
   *  them today, so the sheet carries them through a Duplicate rather than
   *  quietly publishing a copy that asks for nothing. */
  requiredSkills: string[];
  /** The posting's OWN eligibility gates, or null when it inherits the
   *  programme's placement criteria. Null is not zero and is not rendered as
   *  one — `routers/student.py` falls back to the criteria on null. */
  minCgpa: number | null;
  maxLiveBacklogs: number | null;
  applicants: number;
  postedOn: string;
  closesOn: string | null;
  /** The Deadline column: "22 Sep 2026", or main's "No deadline". */
  deadlineLabel: string;
  /** The Status column, in main's own words. */
  statusLabel: string;
  statusTone: DeadlineTone;
  /** True once the closing date has passed. */
  isClosed: boolean;
  /** True while the posting is open and inside CLOSING_SOON_DAYS. */
  isClosingSoon: boolean;
}

/** What the sheet's Status filter offers. Every one of these reads a date the
 *  posting already carries — none of them waits on B12.2's close state. */
export const STATUS_FILTERS = [
  { key: '', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'closing', label: 'Closing this week' },
  { key: 'closed', label: 'Closed' },
];

export const DEGREE_LEVELS = [
  { key: 'PG', label: 'PG' },
  { key: 'UG', label: 'UG' },
];

/** What a new posting starts as. */
export interface JobPostingDraft {
  title: string;
  company: string;
  location: string;
  degreeLevel: string;
  closesOn: string;
  applyUrl: string;
  /** Carried, never typed: the form has no skills field (the board has none
   *  either), but a Duplicate that dropped them would publish a posting that
   *  matches every resume equally. */
  requiredSkills: string[];
}

export const EMPTY_DRAFT: JobPostingDraft = {
  title: '',
  company: '',
  location: '',
  degreeLevel: 'PG',
  closesOn: '',
  applyUrl: '',
  requiredSkills: [],
};

// ------------------------------------------------------------- the helpers --

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "22 Sep 2026". The grid's renderers run outside Angular, so DatePipe cannot
 *  reach them and the date is formatted once, here, when the row is built. */
export function formatDeadlineDate(closesOn: string | null): string {
  if (closesOn === null) return 'No deadline';
  const deadline = new Date(closesOn);
  if (Number.isNaN(deadline.getTime())) return 'No deadline';
  return deadline.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** The closing instant, or null when the posting has no deadline or carries
 *  one nothing can parse. */
function deadlineAt(closesOn: string | null): number | null {
  if (closesOn === null) return null;
  const deadline = new Date(closesOn).getTime();
  return Number.isNaN(deadline) ? null : deadline;
}

/** Whole days from now until the closing date; null when there is none. */
export function daysUntilDeadline(closesOn: string | null): number | null {
  const deadline = deadlineAt(closesOn);
  if (deadline === null) return null;
  return Math.ceil((deadline - Date.now()) / MILLISECONDS_IN_A_DAY);
}

/** Has the deadline passed? READ FROM THE TIMESTAMP, never from the day count
 *  above: `Math.ceil` of a small negative number is `-0` in JavaScript and
 *  `-0 < 0` is false, so a posting that shut a few hours ago counted as OPEN —
 *  in the stat strip, in the Status filter's Open bucket, and on the row, which
 *  read "Closes in 0d". */
export function hasClosed(closesOn: string | null): boolean {
  const deadline = deadlineAt(closesOn);
  return deadline !== null && deadline < Date.now();
}

/** Turn one API posting into the row the grid draws.
 *
 *  The status is DERIVED FROM THE CLOSING DATE, which is the only thing a
 *  posting records today; a posting the office closes by hand is B12.2. The
 *  words are main's ("Closed", "Closes in 3d", "Open", "No deadline") so the
 *  sheet reads the same as the student's board it publishes to. */
export function toJobPostingRow(posting: JobPostingApiRow): JobPostingRow {
  const daysLeft = daysUntilDeadline(posting.closes_on);
  const isClosed = hasClosed(posting.closes_on);
  const isClosingSoon = !isClosed && daysLeft !== null && daysLeft <= CLOSING_SOON_DAYS;
  return {
    jobId: posting.id,
    title: posting.title,
    company: posting.company,
    location: posting.location,
    companyAndLocation:
      posting.location === null ? posting.company : `${posting.company} · ${posting.location}`,
    degreeLevel: posting.degree_level,
    applyUrl: posting.apply_url,
    requiredSkills: [...posting.required_skills],
    minCgpa: posting.min_cgpa,
    maxLiveBacklogs: posting.max_live_backlogs,
    applicants: posting.applicants,
    postedOn: posting.posted_on,
    closesOn: posting.closes_on,
    deadlineLabel: formatDeadlineDate(posting.closes_on),
    statusLabel: statusLabelOf(daysLeft, isClosed, isClosingSoon),
    statusTone: statusToneOf(daysLeft, isClosed, isClosingSoon),
    isClosed,
    isClosingSoon,
  };
}

function statusLabelOf(daysLeft: number | null, isClosed: boolean, isClosingSoon: boolean): string {
  if (daysLeft === null) return 'No deadline';
  if (isClosed) return 'Closed';
  // The student's own board's words (features/student/jobs), so the sheet and
  // the board it publishes to say the same thing about the same posting.
  if (isClosingSoon) {
    if (daysLeft <= 0) return 'Closes today';
    return `Closes in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
  }
  return 'Open';
}

function statusToneOf(
  daysLeft: number | null,
  isClosed: boolean,
  isClosingSoon: boolean,
): DeadlineTone {
  if (daysLeft === null) return 'neutral';
  if (isClosed) return 'neutral';
  if (isClosingSoon) return 'warn';
  return 'good';
}
