/**
 * The shapes the landing page's eight tiles are drawn from.
 *
 * Rows in, tile out. Nothing here touches Prisma or imports `server-only`, the
 * same split as `activity-rules.ts` against `activity-log.ts` — `queries.ts`
 * next door does the fetching and calls these. That split is what lets the two
 * clauses most likely to be quietly dropped be *tested* rather than eyeballed:
 *
 *  - A SWOC tile that does not distinguish PLACEMENT from MENTOR from PM is
 *    just a free-text box with a heading. `swocTile` therefore emits a fixed
 *    4×3 matrix — every quadrant, every source, zeroes included — so the chart
 *    it feeds cannot silently render two series because the third had no rows.
 *  - Likewise `mockTile`: GD, Interview and Aptitude are always all three, and
 *    "no aptitude test taken yet" is a zero on a labelled axis rather than an
 *    absent bar.
 *
 * Every builder here also has to answer for a brand-new student with nothing at
 * all. None of them returns null or an empty array in place of structure: the
 * axes exist, the numbers are zero, and the page decides whether to print an
 * empty state over the top. A tile that vanishes teaches a fresher that the
 * feature is broken.
 */

import type { MockType, SwocKind, SwocSource } from '@prisma/client';

import { dayFromKey, shiftKey } from '../timesheet/rules';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------
//
// These label maps live here rather than in `reep.ts` because they belong to
// the three tables added for this screen, and `reep.ts` is shared curriculum
// vocabulary owned elsewhere. If a second screen needs them they should move up
// rather than be copied.

/// Fixed order, because it is the order the acronym is read in.
export const SWOC_KINDS: readonly SwocKind[] = [
  'STRENGTH',
  'WEAKNESS',
  'OPPORTUNITY',
  'CHALLENGE',
] as const;

export const SWOC_KIND_LABEL: Record<SwocKind, string> = {
  STRENGTH: 'Strength',
  WEAKNESS: 'Weakness',
  OPPORTUNITY: 'Opportunity',
  CHALLENGE: 'Challenge',
};

/// The three desks, in the order they appear on the chart legend. Fixed so the
/// same source keeps the same colour across renders and across screens.
export const SWOC_SOURCES: readonly SwocSource[] = ['PLACEMENT', 'MENTOR', 'PM'] as const;

export const SWOC_SOURCE_LABEL: Record<SwocSource, string> = {
  PLACEMENT: 'Placement cell',
  MENTOR: 'Your mentor',
  PM: 'Programme manager',
};

export const MOCK_TYPES: readonly MockType[] = ['GD', 'INTERVIEW', 'APTITUDE'] as const;

export const MOCK_TYPE_LABEL: Record<MockType, string> = {
  GD: 'Group discussion',
  INTERVIEW: 'Interview',
  APTITUDE: 'Aptitude test',
};

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export type AttendanceRow = {
  courseCode: string;
  present: boolean;
  sessionDate: Date;
};

export type AttendanceTile = {
  /// Across every recorded session. 100 when nothing has been recorded, which
  /// matches `attendancePct` in `progress.ts` — a student who has not been
  /// marked absent has not been absent.
  overallPct: number;
  present: number;
  absent: number;
  sessions: number;
  /// Worst course first: the bar a student needs to look at is the short one,
  /// and putting it at the top means they see it without reading the chart.
  byCourse: { label: string; value: number; present: number; sessions: number }[];
};

/// The floor the placement criteria are written against. Repeated here only as
/// the tile's own "are we fine?" threshold — the authoritative check is
/// `evaluatePlacementReadiness`, which reads the director-configured value.
export const ATTENDANCE_COMFORT_PCT = 85;

export function attendanceTile(
  records: AttendanceRow[],
  courseNames: Map<string, string>,
  limit = 6,
): AttendanceTile {
  const present = records.filter((r) => r.present).length;
  const sessions = records.length;

  const byCourse = new Map<string, { present: number; sessions: number }>();
  for (const record of records) {
    const entry = byCourse.get(record.courseCode) ?? { present: 0, sessions: 0 };
    entry.sessions += 1;
    if (record.present) entry.present += 1;
    byCourse.set(record.courseCode, entry);
  }

  return {
    overallPct: sessions === 0 ? 100 : round1((present / sessions) * 100),
    present,
    absent: sessions - present,
    sessions,
    byCourse: [...byCourse.entries()]
      .map(([code, entry]) => ({
        // The code is kept in the label because two courses in a stage can read
        // alike at a glance and the axis is only ~100px wide.
        label: courseNames.get(code) ?? code,
        value: Math.round((entry.present / entry.sessions) * 100),
        present: entry.present,
        sessions: entry.sessions,
      }))
      .sort((a, b) => a.value - b.value || a.label.localeCompare(b.label))
      .slice(0, limit),
  };
}

// ---------------------------------------------------------------------------
// VTU marks
// ---------------------------------------------------------------------------

export type SubjectMarkRow = {
  subjectCode: string;
  subjectName: string;
  credits: number;
  internal: number;
  external: number;
  total: number;
  passed: boolean;
};

export type SemesterResultRow = {
  semester: number;
  sgpa: number | null;
  cgpa: number | null;
  resultClass: string | null;
  publishedOn: Date | null;
  subjects: SubjectMarkRow[];
};

export type MarksTile = {
  /// One point per semester that has a published SGPA. A semester in progress
  /// has a row with marks but no SGPA, and plotting it as zero would draw a
  /// cliff the student has not fallen off.
  sgpaSeries: { label: string; semester: number; sgpa: number; cgpa: number | null }[];
  /// The most recent semester with subjects — published or not. The breakdown
  /// is the useful half of a marks screen even before the result is out, and it
  /// is the only view a first-semester student has at all.
  latest: {
    semester: number;
    published: boolean;
    sgpa: number | null;
    cgpa: number | null;
    resultClass: string | null;
    subjects: { label: string; subjectName: string; internal: number; external: number; total: number; passed: boolean }[];
    backlogs: number;
  } | null;
  /// Latest published CGPA anywhere in the record, for the headline figure.
  cgpa: number | null;
};

export function marksTile(results: SemesterResultRow[]): MarksTile {
  const ordered = [...results].sort((a, b) => a.semester - b.semester);

  const sgpaSeries = ordered
    .filter((row): row is SemesterResultRow & { sgpa: number } => row.sgpa != null)
    .map((row) => ({
      label: `Sem ${row.semester}`,
      semester: row.semester,
      sgpa: row.sgpa,
      cgpa: row.cgpa,
    }));

  const withSubjects = ordered.filter((row) => row.subjects.length > 0);
  const latestRow = withSubjects[withSubjects.length - 1] ?? null;

  const published = [...ordered].reverse().find((row) => row.cgpa != null) ?? null;

  return {
    sgpaSeries,
    cgpa: published?.cgpa ?? null,
    latest: latestRow
      ? {
          semester: latestRow.semester,
          published: latestRow.sgpa != null,
          sgpa: latestRow.sgpa,
          cgpa: latestRow.cgpa,
          resultClass: latestRow.resultClass,
          subjects: [...latestRow.subjects]
            .sort((a, b) => a.subjectCode.localeCompare(b.subjectCode))
            .map((subject) => ({
              // Internal and external stay separate all the way to the chart.
              // Folding them into `total` throws away the diagnostic the split
              // exists for — strong internals with a weak external is exam
              // technique, the reverse is coursework discipline.
              label: subject.subjectCode,
              subjectName: subject.subjectName,
              internal: subject.internal,
              external: subject.external,
              total: subject.total,
              passed: subject.passed,
            })),
          backlogs: latestRow.subjects.filter((subject) => !subject.passed).length,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// SWOC
// ---------------------------------------------------------------------------

export type SwocRow = {
  source: SwocSource;
  kind: SwocKind;
  text: string;
  weight: number;
  recordedAt: Date;
};

/// One bar group: a quadrant, with a count from each of the three desks. The
/// source keys are spelt out as properties rather than nested in a map because
/// `BarChart`'s `dataset` addresses series by `dataKey`.
export type SwocBar = {
  kind: SwocKind;
  label: string;
  PLACEMENT: number;
  MENTOR: number;
  PM: number;
};

export type SwocTile = {
  /// Always four rows with all three sources present. See the module note.
  bars: SwocBar[];
  /// The heaviest entry from each source in each quadrant, so the chart has
  /// words underneath it. A count with no text is a tally, not a reading.
  highlights: { source: SwocSource; sourceLabel: string; kind: SwocKind; kindLabel: string; text: string; weight: number }[];
  bySource: { source: SwocSource; label: string; count: number }[];
  total: number;
};

export function swocTile(entries: SwocRow[], highlightsPerSource = 2): SwocTile {
  const bars: SwocBar[] = SWOC_KINDS.map((kind) => ({
    kind,
    label: SWOC_KIND_LABEL[kind],
    PLACEMENT: 0,
    MENTOR: 0,
    PM: 0,
  }));
  const index = new Map(bars.map((bar) => [bar.kind, bar]));

  for (const entry of entries) {
    const bar = index.get(entry.kind);
    if (bar) bar[entry.source] += 1;
  }

  // Heaviest first, then most recent — the same order the SWOC board itself
  // sorts a quadrant by, so the line quoted here is the line at the top there.
  const ranked = [...entries].sort(
    (a, b) => b.weight - a.weight || b.recordedAt.getTime() - a.recordedAt.getTime(),
  );

  const highlights: SwocTile['highlights'] = [];
  for (const source of SWOC_SOURCES) {
    for (const entry of ranked.filter((row) => row.source === source).slice(0, highlightsPerSource)) {
      highlights.push({
        source,
        sourceLabel: SWOC_SOURCE_LABEL[source],
        kind: entry.kind,
        kindLabel: SWOC_KIND_LABEL[entry.kind],
        text: entry.text,
        weight: entry.weight,
      });
    }
  }

  return {
    bars,
    highlights,
    bySource: SWOC_SOURCES.map((source) => ({
      source,
      label: SWOC_SOURCE_LABEL[source],
      count: entries.filter((entry) => entry.source === source).length,
    })),
    total: entries.length,
  };
}

// ---------------------------------------------------------------------------
// Mock assessments
// ---------------------------------------------------------------------------

export type MockRow = {
  type: MockType;
  takenOn: Date;
  score: number | null;
  maxScore: number | null;
};

export type MockBar = {
  type: MockType;
  label: string;
  attempts: number;
  /// Best result as a percentage, or null where every attempt was a debrief
  /// with no number — a GD often is. Null is printed as "not scored", never as
  /// a zero, which would read as a failure.
  bestPct: number | null;
  lastTakenOn: Date | null;
};

export type MockTile = {
  /// Always three rows, one per `MockType`. See the module note.
  bars: MockBar[];
  total: number;
};

export function mockTile(attempts: MockRow[]): MockTile {
  const bars: MockBar[] = MOCK_TYPES.map((type) => {
    const mine = attempts.filter((attempt) => attempt.type === type);

    const scored = mine.filter(
      (attempt): attempt is MockRow & { score: number; maxScore: number } =>
        attempt.score != null && attempt.maxScore != null && attempt.maxScore > 0,
    );

    // Papers are marked out of different totals across terms, so the only way
    // two attempts compare is as percentages — which is exactly why the raw
    // score and its denominator are both stored rather than one ratio.
    const bestPct =
      scored.length === 0
        ? null
        : Math.round(Math.max(...scored.map((a) => (a.score / a.maxScore) * 100)));

    const lastTakenOn = mine.reduce<Date | null>(
      (latest, attempt) => (latest == null || attempt.takenOn > latest ? attempt.takenOn : latest),
      null,
    );

    return { type, label: MOCK_TYPE_LABEL[type], attempts: mine.length, bestPct, lastTakenOn };
  });

  return { bars, total: attempts.length };
}

// ---------------------------------------------------------------------------
// Login streak — the rail under the numbers
// ---------------------------------------------------------------------------

/// One square on the streak rail.
export type StreakDay = {
  key: string;
  /// Single letter, because fourteen of these sit in a row about 300px wide.
  weekday: string;
  /// Long form for the tooltip and the screen reader, where there is room.
  label: string;
  present: boolean;
  /// Sunday. Drawn differently from a miss, because it is not one — campus is
  /// closed and `loginStreak` steps over it rather than breaking on it. A rail
  /// that drew Sundays as gaps would contradict the number printed above it.
  closed: boolean;
  isToday: boolean;
};

const WEEKDAY_INITIAL = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAME = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * The last `span` days as squares, oldest first.
 *
 * Separate from `loginStreak` because it answers a different question — that
 * one folds an unbounded history down to two integers, this one draws a fixed
 * recent window. Sharing a return type would force the streak module to carry
 * a window it deliberately does not have.
 */
export function streakRail(days: Iterable<string>, today: string, span = 14): StreakDay[] {
  const present = new Set<string>();
  for (const raw of days) present.add(raw.trim());

  const rail: StreakDay[] = [];
  for (let back = span - 1; back >= 0; back--) {
    const key = shiftKey(today, -back);
    const date = key ? dayFromKey(key) : null;
    if (!key || !date) continue;

    const weekday = date.getUTCDay();
    rail.push({
      key,
      weekday: WEEKDAY_INITIAL[weekday],
      label: `${WEEKDAY_NAME[weekday]} ${key}`,
      present: present.has(key),
      closed: weekday === 0,
      isToday: back === 0,
    });
  }
  return rail;
}

// ---------------------------------------------------------------------------

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
