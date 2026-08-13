/**
 * The first read path in this product that shows one student something about
 * another student.
 *
 * Everything else fails closed by construction: `visibleStudentWhere()` in
 * `ai/agent/scope.ts` pins a STUDENT to `{ id: session.studentId }`, and
 * `menteeWhere()` narrows staff to a mentor group. A leaderboard cannot be
 * built that way — it is a list of other people by definition — so the fence
 * has to move from "which rows" to "which rows *and which columns*", and both
 * halves live here rather than in the five board queries or in the page.
 *
 * Three rules, in the order they bite:
 *
 *  1. **Cohort, not programme.** A student is capped to their own cohort. Rank
 *     is a social fact and it only means anything against people sitting the
 *     same semester; ranking a first-semester student against a fourth is both
 *     useless and a wider disclosure than the feature needs.
 *
 *  2. **A hard field whitelist, not a blacklist.** A peer row carries a display
 *     name, a rank and a coarse band. Not a USN, not a mark, not an attendance
 *     percentage, not the title of an upload, and not the ranking figure
 *     itself. `LeaderboardEntry` is the *only* shape that reaches a peer, and
 *     the way to add a field to it is to argue for it in review — which is why
 *     the rows are projected here from a `RankInput` that does hold the private
 *     fields, instead of the page being handed a Prisma row and trusted to pick.
 *     The viewer's own figure is exempt: they may always read their own number
 *     exactly, and `yourValue` is non-null on their row and null on every other.
 *
 *  3. **Opt-out is one-directional.** `StudentProfile.leaderboardOptOut`
 *     removes a student from everyone else's list. It does not cost them their
 *     own standing — they still see where they would land — because a privacy
 *     control that also takes away your own data is a punishment, and students
 *     would simply not use it.
 *
 * This module is pure and imports no Prisma client, so the rules are testable
 * without a database and cannot drift into a query. The mistake it guards
 * against is the one kind that cannot be walked back: once a peer's mark has
 * been rendered on someone else's screen, no later fix un-shows it.
 */

import type { Prisma } from '@prisma/client';

import type { SessionPayload } from './auth';

// ---------------------------------------------------------------------------
// Who may read a board
// ---------------------------------------------------------------------------

export type LeaderboardScope =
  /// A student, reading their own cohort and nothing wider.
  | { kind: 'cohort'; cohortId: string; viewerStudentId: string }
  /// Nobody. Every role that is not a student, and any student session missing
  /// the two facts the cap is built from.
  | { kind: 'none' };

/**
 * Keyed on role, in the same spirit as `mentorScope()` — a missing field is
 * never read as a wider permission.
 *
 * There is deliberately no staff branch. Staff already read real figures with
 * names attached on the roster, the placement board and the student record; a
 * de-identified ranking would be a strictly worse view of data they can see in
 * full, so handing them one buys nothing and creates a second code path over
 * peer data. If a staff-facing board is ever wanted it gets its own `kind`
 * here, argued for on its own terms.
 *
 * `viewerCohortId` is a parameter rather than a session field because the token
 * does not carry one, and inventing a fallback for a missing cohort is exactly
 * how `session.mentorId ? … : {}` turned into a programme-wide read. Absent, it
 * closes.
 */
export function leaderboardScope(
  session: SessionPayload,
  viewerCohortId: string | null | undefined,
): LeaderboardScope {
  if (session.role !== 'STUDENT') return { kind: 'none' };
  if (!session.studentId || !viewerCohortId) return { kind: 'none' };
  return {
    kind: 'cohort',
    cohortId: viewerCohortId,
    viewerStudentId: session.studentId,
  };
}

/**
 * The scope as a `Student` filter.
 *
 * No branch returns `{}`. An empty clause means "every student in the
 * programme", which on this screen would mean showing a first-semester student
 * a ranking against people they have never met — so the closed case is a filter
 * that cannot match rather than the absence of one, matching `menteeWhere()`.
 */
export function leaderboardWhere(scope: LeaderboardScope): Prisma.StudentWhereInput {
  if (scope.kind === 'cohort') return { cohortId: scope.cohortId };
  return { id: '__none__' };
}

// ---------------------------------------------------------------------------
// What a peer is allowed to learn
// ---------------------------------------------------------------------------

/**
 * One row of a board as it reaches the browser.
 *
 * Five fields, and the list is the point of the file. Note what is absent:
 * there is no `studentId`, so a rendered board cannot be turned into links to
 * other students' records, and nothing on it can be joined back to a person by
 * anything but the name already shown.
 */
export type LeaderboardEntry = {
  /// 1-based position within the board. Unique — the tie-break chain in
  /// `compareEntries` is total, so two rows never share a rank and React can
  /// key on it.
  rank: number;
  /// The student's name as the programme knows it. The only identifier here.
  displayName: string;
  /// A coarse bucket — four values at most. Says roughly how far off the top
  /// this row is without printing the figure that would answer it exactly.
  band: string;
  /// True on the reader's own row, so the page can highlight it.
  isViewer: boolean;
  /// The exact ranking figure. Non-null **only** when `isViewer` is true: you
  /// may always read your own number, and never anybody else's.
  yourValue: number | null;
};

/// The complete set of keys a peer row may carry. Exported so the test asserts
/// against a list rather than against whatever the type happens to say today.
export const PEER_VISIBLE_FIELDS = [
  'rank',
  'displayName',
  'band',
  'isViewer',
  'yourValue',
] as const;

/**
 * Names that must never appear on a peer row, in any spelling.
 *
 * A blacklist is not the mechanism — `PEER_VISIBLE_FIELDS` is — but keeping the
 * forbidden names written down turns "we thought about this" into something a
 * test can fail on, and names the columns the spec actually calls out.
 */
export const FORBIDDEN_PEER_FIELDS = [
  'usn',
  'studentId',
  'userId',
  'email',
  'cgpa',
  'sgpa',
  'marks',
  'internal',
  'external',
  'total',
  'attendance',
  'attendancePct',
  'title',
  'uploadTitle',
  'value',
  'achievedAt',
  'optOut',
] as const;

/// The reader's own standing, which survives their own opt-out.
export type ViewerStanding = {
  /// Where they sit. When `onBoard` is false this is where they *would* sit —
  /// the number of ranked students ahead of them, plus one.
  rank: number;
  /// How many students the ranking ran over, so "4th" can be read as "4 of 31".
  outOf: number;
  /// Their own figure, exact. Never coarsened, never withheld.
  value: number;
  band: string;
  /// False when this student has opted out: they are reading a board they do
  /// not appear on, and the page has to say so rather than imply they are
  /// listed under a rank nobody else can see.
  onBoard: boolean;
  /// Nothing logged for this board yet. Drives the empty state rather than
  /// printing a proud "31st of 31".
  empty: boolean;
};

/// A board as the page renders it. `rows` is already projected; nothing else
/// here is per-student.
export type LeaderboardBoard = {
  rows: LeaderboardEntry[];
  /// Always present when the viewer's own row was supplied to `rankBoard`.
  you: ViewerStanding | null;
  /// Students the ranking ran over — opted-in peers, plus the viewer when they
  /// have not opted out.
  ranked: number;
  /// Whether anybody on the board has actually got off zero. A cohort where
  /// nobody has taken a mock yet still ranks eleven students, and printing
  /// "1st … 11th" over eleven zeroes invents a hierarchy out of nothing. A
  /// boolean rather than the leading figure, which is a peer's number.
  hasFigures: boolean;
  /// Peers who removed themselves. Shown as a count so the board is honest
  /// about not being the whole cohort; never as a set of gaps in the rank
  /// column, which would advertise that someone is hidden at a given position.
  optedOutPeers: number;
  /// True when the viewer's row was appended below the visible slice because
  /// they rank outside it, so the page can draw the break in the sequence.
  viewerAppended: boolean;
};

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * What a board query hands in: the private row, before projection.
 *
 * `value` is always "higher is better" — a board whose natural key runs the
 * other way inverts it in its own query rather than teaching this module about
 * directions.
 */
export type RankInput = {
  studentId: string;
  displayName: string;
  /// This student's own `StudentProfile.leaderboardOptOut`.
  optOut: boolean;
  value: number;
  /// When this student reached their figure — first verified certificate, first
  /// mock, day the streak began. The tie-break: two students on four
  /// certificates are not equal if one got there in March.
  achievedAt: Date | null;
};

/// How a board turns a figure into a band.
export type BandKind =
  /// Share of the leader's figure. Works for any count or streak.
  | 'share'
  /// VTU's own class vocabulary, for CGPA — the one board where the raw figure
  /// must never be shown and a recognised word is more use than a quartile.
  | 'class';

export type RankOptions = {
  viewerStudentId: string;
  band: BandKind;
  /// How many rows to list. The rest of the cohort is not withheld for privacy
  /// — they are all opted in — but a board of sixty names is not a leaderboard,
  /// it is a register.
  visible?: number;
};

const DEFAULT_VISIBLE = 10;

/**
 * Deterministic to the last row.
 *
 * Value, then earliest achievement, then name, then id. The id is not a
 * meaningful ordering, it is the guarantee that the chain never ends in a draw
 * — without it two students with the same name, count and date would swap
 * places between renders as Postgres felt like it, and a rank that moves when
 * nothing changed is a rank nobody trusts.
 */
export function compareEntries(a: RankInput, b: RankInput): number {
  if (a.value !== b.value) return b.value - a.value;
  // A student with no date has not been beaten by one who has; they simply
  // cannot prove they were first, so they sort behind.
  const at = a.achievedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bt = b.achievedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (at !== bt) return at - bt;
  const byName = a.displayName.localeCompare(b.displayName, 'en');
  if (byName !== 0) return byName;
  return a.studentId.localeCompare(b.studentId);
}

/**
 * Rank a cohort's rows and project the ones a peer may see.
 *
 * The ranking field is the opted-in students. The viewer is ranked against that
 * field whether or not they are in it, which is what makes the opt-out
 * one-directional: an opted-out reader gets a true "you would be 6th" without
 * appearing in anybody's sixth row. Their notional rank can equal a listed
 * student's, and that is the honest reading — they are not on the board, they
 * are beside it.
 */
export function rankBoard(entries: RankInput[], opts: RankOptions): LeaderboardBoard {
  const visible = opts.visible ?? DEFAULT_VISIBLE;
  const viewer = entries.find((entry) => entry.studentId === opts.viewerStudentId) ?? null;

  const field = entries.filter((entry) => !entry.optOut).sort(compareEntries);
  const topValue = field[0]?.value ?? 0;
  const bandFor = (value: number) =>
    opts.band === 'class' ? classBand(value) : shareBand(value, topValue);

  const project = (entry: RankInput, rank: number): LeaderboardEntry => {
    const isViewer = entry.studentId === opts.viewerStudentId;
    return {
      rank,
      displayName: entry.displayName,
      band: bandFor(entry.value),
      isViewer,
      // The single exemption to the whitelist, and it is not an exemption at
      // all: this is the reader's own figure being shown back to them.
      yourValue: isViewer ? entry.value : null,
    };
  };

  const viewerIndex = viewer
    ? field.findIndex((entry) => entry.studentId === viewer.studentId)
    : -1;
  const onBoard = viewerIndex >= 0;

  const rows = field.slice(0, visible).map((entry, i) => project(entry, i + 1));

  // A viewer who ranks 27th still has to see their own row, so it is appended
  // rather than the slice being widened — the numbers stay 1…10 and then jump,
  // which reads as "and here is you" instead of implying seventeen hidden rows.
  const viewerAppended = onBoard && viewerIndex >= visible;
  if (viewerAppended && viewer) rows.push(project(viewer, viewerIndex + 1));

  const notionalRank = viewer
    ? field.filter((entry) => compareEntries(entry, viewer) < 0).length + 1
    : 0;

  const you: ViewerStanding | null = viewer
    ? {
        rank: onBoard ? viewerIndex + 1 : notionalRank,
        outOf: field.length + (onBoard ? 0 : 1),
        value: viewer.value,
        band: bandFor(viewer.value),
        onBoard,
        empty: viewer.value <= 0,
      }
    : null;

  return {
    rows,
    you,
    ranked: field.length,
    hasFigures: topValue > 0,
    optedOutPeers: entries.filter(
      (entry) => entry.optOut && entry.studentId !== opts.viewerStudentId,
    ).length,
    viewerAppended,
  };
}

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

/**
 * Four buckets against the leader's figure.
 *
 * Chosen over a quartile of rank because rank is already printed beside it: a
 * quartile band would restate the column next to it, while distance from the
 * top says the thing rank cannot — whether fourth place is a whisker behind
 * first or nowhere near it. Deliberately coarse: at four buckets over the whole
 * range, a band narrows a peer's figure to a wide interval and no further.
 *
 * The wording is not a grade. "Building" is where most of a cohort lives in
 * October, and a board that calls two thirds of a class "bottom quarter" gets
 * read once.
 */
export function shareBand(value: number, topValue: number): string {
  if (value <= 0 || topValue <= 0) return 'Not started';
  const share = value / topValue;
  if (share >= 0.8) return 'Leading';
  if (share >= 0.5) return 'Strong';
  return 'Building';
}

/**
 * VTU's own class boundaries, from CGPA.
 *
 * The CGPA board is the one that must never print its ranking figure to a peer,
 * so the band carries the whole message and it may as well be the word that
 * appears on the transcript. The thresholds are the CBCS ones: 7.75 is the
 * 70% aggregate that earns distinction, 6.75 the 60% that earns first class.
 * Derived from the CGPA rather than read from `SemesterResult.resultClass`,
 * which is free text transcribed from the published sheet and so is not a
 * value anything can safely branch on.
 */
export function classBand(cgpa: number): string {
  if (cgpa <= 0) return 'No result yet';
  if (cgpa >= 7.75) return 'Distinction';
  if (cgpa >= 6.75) return 'First class';
  if (cgpa >= 5.75) return 'Second class';
  return 'Pass';
}
