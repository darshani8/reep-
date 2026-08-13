import 'server-only';

/**
 * The five boards, assembled.
 *
 * Every query in this file is filtered by `leaderboardWhere()` and every row it
 * produces leaves through `rankBoard()`. That is not decoration: this is the
 * only place in the product where one student's rows are read on another
 * student's request, so the two halves of the fence — which students, and which
 * columns of them — are applied here together and nowhere else. A board added
 * later that reaches for `prisma` directly from a page would bypass both.
 *
 * The shape is: one query for the cohort, five aggregates keyed on the ids it
 * returns, and all six issued at once. Aggregating in the database rather than
 * loading rows means a cohort of sixty costs six round trips regardless of how
 * many certificates it has filed between them — and it means the *contents* of
 * those uploads (titles, filenames, review notes) never enter this process at
 * all, which is the strongest form of "never shown to a peer" available.
 *
 * The exception is the streak, which cannot be aggregated in SQL without a
 * window function per student and a hard-coded idea of which weekday campus is
 * shut. Ninety days of sign-in dates for a cohort is a few thousand `date`
 * values; `currentLoginStreak()` folds each student's down to one number.
 */

import type { SessionPayload } from '../auth';
import { prisma } from '../db';
import {
  leaderboardScope,
  leaderboardWhere,
  rankBoard,
  type LeaderboardBoard,
  type RankInput,
} from '../leaderboard-scope';
import { BOARDS, BOARD_KEYS, type BoardKey } from './boards';
import { currentLoginStreak } from './streak';

/// Ninety days is comfortably longer than the longest streak the programme can
/// produce (it started this academic year) and keeps the one unaggregated query
/// bounded.
const STREAK_WINDOW_DAYS = 90;

/// How many rows each board lists before the viewer's own row is appended.
const VISIBLE_ROWS = 10;

export type LeaderboardsView = {
  /// For the "you are ranked against these people" line. The cohort's own name,
  /// which the viewer is a member of — not a disclosure.
  cohortLabel: string;
  /// Students in the cohort, before anyone's opt-out is applied.
  cohortSize: number;
  /// The *viewer's* own opt-out. Drives the banner explaining why they are not
  /// on the boards they are reading.
  viewerOptedOut: boolean;
  boards: Record<BoardKey, LeaderboardBoard>;
};

/**
 * Null when this session may not read a board at all — a staff account that
 * reached the route, a student row that has gone missing under a live session.
 * The page renders an explanation rather than an empty ranking, because an
 * empty board and a forbidden one look identical and mean opposite things.
 */
export async function getStudentLeaderboards(
  session: SessionPayload,
  now = new Date(),
): Promise<LeaderboardsView | null> {
  if (!session.studentId) return null;

  const viewer = await prisma.student.findUnique({
    where: { id: session.studentId },
    select: { id: true, cohortId: true, cohort: { select: { name: true, code: true } } },
  });
  if (!viewer) return null;

  const scope = leaderboardScope(session, viewer.cohortId);
  if (scope.kind !== 'cohort') return null;

  const peers = await prisma.student.findMany({
    where: leaderboardWhere(scope),
    select: {
      id: true,
      userId: true,
      user: { select: { name: true } },
      profile: { select: { leaderboardOptOut: true } },
    },
  });

  const studentIds = peers.map((peer) => peer.id);
  const userIds = peers.map((peer) => peer.userId);
  const since = new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
      STREAK_WINDOW_DAYS * 86_400_000,
  );

  const [certificates, skills, mocks, results, loginDays] = await Promise.all([
    // Verified proof only. A pending upload is a claim, and this board is the
    // one place a claim must not be worth a rank.
    prisma.upload.groupBy({
      by: ['studentId'],
      where: { studentId: { in: studentIds }, kind: 'CERTIFICATE_PROOF', status: 'VERIFIED' },
      _count: { _all: true },
      _min: { uploadedAt: true },
    }),
    prisma.studentSkill.groupBy({
      by: ['studentId'],
      where: { studentId: { in: studentIds }, verified: true },
      _count: { _all: true },
      _min: { addedAt: true },
    }),
    prisma.mockAttempt.groupBy({
      by: ['studentId'],
      where: { studentId: { in: studentIds } },
      _count: { _all: true },
      _min: { takenOn: true },
    }),
    // Only the semester with a published CGPA matters, but which semester that
    // is differs per student, so the pick happens below rather than in SQL.
    prisma.semesterResult.findMany({
      where: { studentId: { in: studentIds }, cgpa: { not: null } },
      select: { studentId: true, semester: true, cgpa: true, publishedOn: true },
      orderBy: [{ studentId: 'asc' }, { semester: 'desc' }],
    }),
    prisma.loginDay.findMany({
      where: { userId: { in: userIds }, day: { gte: since } },
      select: { userId: true, day: true },
    }),
  ]);

  const certByStudent = byStudent(certificates);
  const skillByStudent = byStudent(skills);
  const mockByStudent = byStudent(mocks);

  // `orderBy` put the highest semester first, so the first row seen for a
  // student is their latest published result.
  const latestResult = new Map<string, { cgpa: number; publishedOn: Date | null }>();
  for (const row of results) {
    if (latestResult.has(row.studentId) || row.cgpa == null) continue;
    latestResult.set(row.studentId, { cgpa: row.cgpa, publishedOn: row.publishedOn });
  }

  const daysByUser = new Map<string, Date[]>();
  for (const row of loginDays) {
    const list = daysByUser.get(row.userId);
    if (list) list.push(row.day);
    else daysByUser.set(row.userId, [row.day]);
  }

  const inputs: Record<BoardKey, RankInput[]> = {
    streak: [],
    certificates: [],
    skills: [],
    mocks: [],
    cgpa: [],
  };

  for (const peer of peers) {
    // A student with no `StudentProfile` row has never opened the profile
    // screen, which is not the same as having opted out — the column defaults
    // to false and the missing row reads the same way.
    const base = {
      studentId: peer.id,
      displayName: peer.user.name,
      optOut: peer.profile?.leaderboardOptOut ?? false,
    };

    const streak = currentLoginStreak(daysByUser.get(peer.userId) ?? [], now);
    inputs.streak.push({ ...base, value: streak.length, achievedAt: streak.since });

    const cert = certByStudent.get(peer.id);
    inputs.certificates.push({ ...base, value: cert?.count ?? 0, achievedAt: cert?.first ?? null });

    const skill = skillByStudent.get(peer.id);
    inputs.skills.push({ ...base, value: skill?.count ?? 0, achievedAt: skill?.first ?? null });

    const mock = mockByStudent.get(peer.id);
    inputs.mocks.push({ ...base, value: mock?.count ?? 0, achievedAt: mock?.first ?? null });

    const result = latestResult.get(peer.id);
    inputs.cgpa.push({ ...base, value: result?.cgpa ?? 0, achievedAt: result?.publishedOn ?? null });
  }

  const boards = Object.fromEntries(
    BOARD_KEYS.map((key) => [
      key,
      rankBoard(inputs[key], {
        viewerStudentId: viewer.id,
        band: BOARDS[key].band,
        visible: VISIBLE_ROWS,
      }),
    ]),
  ) as Record<BoardKey, LeaderboardBoard>;

  const self = peers.find((peer) => peer.id === viewer.id);

  return {
    cohortLabel: `${viewer.cohort.name} · ${viewer.cohort.code}`,
    cohortSize: peers.length,
    viewerOptedOut: self?.profile?.leaderboardOptOut ?? false,
    boards,
  };
}

/// The three count boards come back in the same shape; unpack them the same way.
function byStudent(
  rows: {
    studentId: string;
    _count: { _all: number };
    _min: { uploadedAt?: Date | null; addedAt?: Date | null; takenOn?: Date | null };
  }[],
): Map<string, { count: number; first: Date | null }> {
  return new Map(
    rows.map((row) => [
      row.studentId,
      {
        count: row._count._all,
        first: row._min.uploadedAt ?? row._min.addedAt ?? row._min.takenOn ?? null,
      },
    ]),
  );
}
