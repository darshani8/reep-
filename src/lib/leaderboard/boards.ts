/**
 * The five boards, declared once.
 *
 * The spec asks for leaderboards "based on uploads of certificates, skills, VTU
 * results, streak, mocks taken", and the temptation with five of anything is to
 * write one screen five times. Everything that differs between them is a value
 * in this table: what is counted, what breaks a tie, how a figure is worded,
 * and — the one that matters — whether the figure may be shown at all.
 *
 * Two properties are stated in prose on every board and rendered on the page,
 * because a ranking whose rule is not written down is a rule the reader invents:
 *
 *  - `rankingKey` — exactly what is being counted, including what does not
 *    count. Four of the five boards count only *verified* things, which is the
 *    difference between a leaderboard and a self-declaration contest.
 *  - `tieBreak` — why two students on the same number are in the order they are
 *    in. `compareEntries` implements it identically for all five.
 *
 * Pure: no Prisma, no `server-only`. The queries import it, the page imports it,
 * and the test imports it without a database.
 */

import type { BandKind } from '../leaderboard-scope';

/// The five. Order is the order of the tabs, cheapest-to-earn first, so a new
/// student sees a board they can move on before one they cannot.
export const BOARD_KEYS = [
  'streak',
  'certificates',
  'skills',
  'mocks',
  'cgpa',
] as const;

export type BoardKey = (typeof BOARD_KEYS)[number];

export type BoardSpec = {
  key: BoardKey;
  /// Tab label and heading.
  label: string;
  /// One line under the heading: why this board exists at all.
  blurb: string;
  /// The ranking key in words, including the exclusions.
  rankingKey: string;
  /// The tie-break in words. Identical mechanics on every board; the wording
  /// changes because "first certificate" and "first mock" are different dates.
  tieBreak: string;
  band: BandKind;
  /// What the reader sees when they are on zero.
  emptyHint: string;
  /// Where they go to change that.
  actionHref: string;
  actionLabel: string;
};

/**
 * Formatting the *viewer's own* figure. Peers never reach this — their row
 * carries a band and nothing numeric — so this is only ever printing a number
 * back to the person it belongs to.
 */
export function formatBoardValue(key: BoardKey, value: number): string {
  switch (key) {
    case 'cgpa':
      // Two decimals is how VTU publishes it, and this is the one board where
      // the figure is shown to exactly one person.
      return value > 0 ? value.toFixed(2) : '—';
    case 'streak':
      return value === 1 ? '1 day' : `${value} days`;
    case 'certificates':
      return value === 1 ? '1 certificate' : `${value} certificates`;
    case 'skills':
      return value === 1 ? '1 skill' : `${value} skills`;
    case 'mocks':
      return value === 1 ? '1 mock' : `${value} mocks`;
  }
}

export const BOARDS: Record<BoardKey, BoardSpec> = {
  streak: {
    key: 'streak',
    label: 'Sign-in streak',
    blurb: 'Turning up, day after day. The only board that resets if you stop.',
    rankingKey:
      'Consecutive teaching days signed in, counting back from today. Sundays are skipped rather than counted as a miss — campus is closed, so a Sunday cannot break anything.',
    tieBreak:
      'Two equal streaks are ordered by the day the streak began, oldest first, then by name.',
    band: 'share',
    emptyHint: 'Your streak starts the next day you sign in.',
    actionHref: '/student',
    actionLabel: 'Your dashboard',
  },
  certificates: {
    key: 'certificates',
    label: 'Certificates',
    blurb: 'Certificates filed and checked by a mentor — not certifications marked done.',
    rankingKey:
      'Uploads of kind CERTIFICATE_PROOF at status VERIFIED. A proof still waiting for review does not count, and a rejected one never will; self-reported completions are not on this board at all.',
    tieBreak:
      'Two students on the same count are ordered by the date of their earliest upload, oldest first, then by name.',
    band: 'share',
    emptyHint: 'Upload a certificate and ask your mentor to check it.',
    actionHref: '/student/uploads',
    actionLabel: 'Uploads',
  },
  skills: {
    key: 'skills',
    label: 'Verified skills',
    blurb: 'Skills a mentor has checked against evidence, not skills claimed.',
    rankingKey:
      'Entries in the skill catalogue held at verified = true. A self-declared skill counts for the job matcher and for your resume; it does not count here.',
    tieBreak:
      'Equal counts are ordered by the date the earliest of those skills was added, oldest first, then by name.',
    band: 'share',
    emptyHint: 'Claim a skill with a certificate behind it to get it verified.',
    actionHref: '/student/profile',
    actionLabel: 'Your profile',
  },
  mocks: {
    key: 'mocks',
    label: 'Mocks taken',
    blurb: 'Group discussions, interviews and aptitude tests sat. Attempts, not scores.',
    rankingKey:
      'Every MockAttempt on record, of any of the three types. Deliberately a count and not an average score: this board rewards showing up to be assessed, and ranking students by their interview marks in front of each other is the one thing the placement cell asked us not to build.',
    tieBreak:
      'Equal counts are ordered by the date of the first mock sat, oldest first, then by name.',
    band: 'share',
    emptyHint: 'Mocks are scheduled by the placement cell — ask your mentor for the next slot.',
    actionHref: '/student',
    actionLabel: 'Your dashboard',
  },
  cgpa: {
    key: 'cgpa',
    label: 'VTU results',
    blurb: 'University standing. Rank and class only — nobody sees anybody else’s CGPA.',
    rankingKey:
      'CGPA from your most recently published semester result. The figure itself is shown to you and to nobody else: peers see your position and the class band the CGPA falls in, which is the wording already on the transcript.',
    tieBreak:
      'Equal CGPAs are ordered by publication date, earliest first, then by name. A result with no publication date sorts behind one that has it.',
    band: 'class',
    emptyHint: 'This board fills in once your first semester result is published.',
    actionHref: '/student',
    actionLabel: 'Your dashboard',
  },
};

export const BOARD_LIST: BoardSpec[] = BOARD_KEYS.map((key) => BOARDS[key]);

/// "4th", not "4". A bare integer in a column headed # is a row number; the
/// ordinal is the only thing that reads as a placing.
export function ordinalRank(rank: number): string {
  const lastTwo = rank % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${rank}th`;
  switch (rank % 10) {
    case 1:
      return `${rank}st`;
    case 2:
      return `${rank}nd`;
    case 3:
      return `${rank}rd`;
    default:
      return `${rank}th`;
  }
}

/**
 * Where the viewer sits as a 0–100 figure, for the one chart on the screen.
 *
 * Derived from their own rank and nothing else, so it discloses nothing a peer
 * owns — which is why it is the only thing on this page that can be charted at
 * all. A bar chart of the actual leaderboard would be a bar chart of other
 * people's marks.
 */
export function standingPercentile(rank: number, outOf: number): number {
  if (outOf <= 1) return 100;
  return ((outOf - rank) / (outOf - 1)) * 100;
}

/// An unknown or repeated `?board=` falls back to the first board rather than
/// 404ing — which board you are looking at is a view preference, not a
/// resource identifier. Same rule as the `?stage=` filter on Certifications.
export function parseBoardKey(raw: string | string[] | undefined): BoardKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (BOARD_KEYS as readonly string[]).includes(value ?? '')
    ? (value as BoardKey)
    : BOARD_KEYS[0];
}
