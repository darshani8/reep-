/**
 * The five boards, assembled — the port of src/lib/leaderboard/queries.ts.
 *
 * Every query is filtered by leaderboardWhere() and every row leaves through
 * rankBoard(): the two halves of the fence (which students, which columns) are
 * applied here and nowhere else. The private figures never leave this service —
 * peer rows carry a name, a rank and a band, and the display strings (ordinal,
 * the viewer's own formatted value, the standing percentile) are computed here
 * so the Angular renderer never sees a raw peer figure.
 */

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { SessionPayload } from '../auth/session.types';
import { leaderboardScope, leaderboardWhere, rankBoard, type RankInput } from './scope';
import { BOARDS, BOARD_KEYS, formatBoardValue, ordinalRank, standingPercentile, type BoardKey } from './boards';
import { currentLoginStreak } from './streak';

const STREAK_WINDOW_DAYS = 90;
const VISIBLE_ROWS = 10;

export interface BoardRowView {
  rank: number;
  ordinal: string;
  displayName: string;
  band: string;
  isViewer: boolean;
  yourValueLabel: string | null;
}

export interface BoardView {
  key: BoardKey;
  label: string;
  blurb: string;
  rankingKey: string;
  tieBreak: string;
  emptyHint: string;
  actionHref: string;
  actionLabel: string;
  rows: BoardRowView[];
  you: {
    rank: number;
    ordinal: string;
    outOf: number;
    valueLabel: string;
    band: string;
    onBoard: boolean;
    empty: boolean;
    standingPct: number;
  } | null;
  ranked: number;
  hasFigures: boolean;
  optedOutPeers: number;
  viewerAppended: boolean;
}

export interface LeaderboardsResponse {
  available: boolean;
  cohortLabel?: string;
  cohortSize?: number;
  viewerOptedOut?: boolean;
  boards?: BoardView[];
  /// For the one chart: the viewer's own standing across boards they are on.
  standings?: { label: string; value: number }[];
}

@Injectable()
export class LeaderboardService {
  constructor(private readonly prisma: PrismaService) {}

  async view(session: SessionPayload, now = new Date()): Promise<LeaderboardsResponse> {
    if (!session.studentId) return { available: false };

    const viewer = await this.prisma.student.findUnique({
      where: { id: session.studentId },
      select: { id: true, cohortId: true, cohort: { select: { name: true, code: true } } },
    });
    if (!viewer) return { available: false };

    const scope = leaderboardScope(session, viewer.cohortId);
    if (scope.kind !== 'cohort') return { available: false };

    const peers = await this.prisma.student.findMany({
      where: leaderboardWhere(scope),
      select: {
        id: true,
        userId: true,
        user: { select: { name: true } },
        profile: { select: { leaderboardOptOut: true } },
      },
    });

    const studentIds = peers.map((p) => p.id);
    const userIds = peers.map((p) => p.userId);
    const since = new Date(
      Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - STREAK_WINDOW_DAYS * 86_400_000,
    );

    const [certificates, skills, mocks, results, loginDays] = await Promise.all([
      this.prisma.upload.groupBy({
        by: ['studentId'],
        where: { studentId: { in: studentIds }, kind: 'CERTIFICATE_PROOF', status: 'VERIFIED' },
        _count: { _all: true },
        _min: { uploadedAt: true },
      }),
      this.prisma.studentSkill.groupBy({
        by: ['studentId'],
        where: { studentId: { in: studentIds }, verified: true },
        _count: { _all: true },
        _min: { addedAt: true },
      }),
      this.prisma.mockAttempt.groupBy({
        by: ['studentId'],
        where: { studentId: { in: studentIds } },
        _count: { _all: true },
        _min: { takenOn: true },
      }),
      this.prisma.semesterResult.findMany({
        where: { studentId: { in: studentIds }, cgpa: { not: null } },
        select: { studentId: true, semester: true, cgpa: true, publishedOn: true },
        orderBy: [{ studentId: 'asc' }, { semester: 'desc' }],
      }),
      this.prisma.loginDay.findMany({
        where: { userId: { in: userIds }, day: { gte: since } },
        select: { userId: true, day: true },
      }),
    ]);

    const certByStudent = byStudent(certificates);
    const skillByStudent = byStudent(skills);
    const mockByStudent = byStudent(mocks);

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

    const inputs: Record<BoardKey, RankInput[]> = { streak: [], certificates: [], skills: [], mocks: [], cgpa: [] };

    for (const peer of peers) {
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

    const self = peers.find((p) => p.id === viewer.id);
    const standings: { label: string; value: number }[] = [];

    const boards: BoardView[] = BOARD_KEYS.map((key) => {
      const spec = BOARDS[key];
      const board = rankBoard(inputs[key], { viewerStudentId: viewer.id, band: spec.band, visible: VISIBLE_ROWS });
      const you = board.you;

      if (you && !you.empty) {
        standings.push({ label: spec.label, value: Math.round(standingPercentile(you.rank, you.outOf)) });
      }

      return {
        key,
        label: spec.label,
        blurb: spec.blurb,
        rankingKey: spec.rankingKey,
        tieBreak: spec.tieBreak,
        emptyHint: spec.emptyHint,
        actionHref: spec.actionHref,
        actionLabel: spec.actionLabel,
        rows: board.rows.map((r) => ({
          rank: r.rank,
          ordinal: ordinalRank(r.rank),
          displayName: r.displayName,
          band: r.band,
          isViewer: r.isViewer,
          yourValueLabel: r.isViewer && r.yourValue != null ? formatBoardValue(key, r.yourValue) : null,
        })),
        you: you
          ? {
              rank: you.rank,
              ordinal: ordinalRank(you.rank),
              outOf: you.outOf,
              valueLabel: formatBoardValue(key, you.value),
              band: you.band,
              onBoard: you.onBoard,
              empty: you.empty,
              standingPct: Math.round(standingPercentile(you.rank, you.outOf)),
            }
          : null,
        ranked: board.ranked,
        hasFigures: board.hasFigures,
        optedOutPeers: board.optedOutPeers,
        viewerAppended: board.viewerAppended,
      };
    });

    return {
      available: true,
      cohortLabel: `${viewer.cohort.name} · ${viewer.cohort.code}`,
      cohortSize: peers.length,
      viewerOptedOut: self?.profile?.leaderboardOptOut ?? false,
      boards,
      standings,
    };
  }
}

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
      { count: row._count._all, first: row._min.uploadedAt ?? row._min.addedAt ?? row._min.takenOn ?? null },
    ]),
  );
}
