import { describe, expect, it } from 'vitest';

import type { SessionPayload } from './auth';
import {
  FORBIDDEN_PEER_FIELDS,
  PEER_VISIBLE_FIELDS,
  classBand,
  compareEntries,
  leaderboardScope,
  leaderboardWhere,
  rankBoard,
  shareBand,
  type LeaderboardEntry,
  type RankInput,
} from './leaderboard-scope';

/**
 * The rule these tests exist for: nothing a peer receives may carry a USN, a
 * mark, an attendance figure, an upload title — or the ranking figure itself.
 *
 * This is the first read path in the product that shows one student anything
 * about another, and it is the one kind of defect that cannot be walked back:
 * a fix ships after the data has already been rendered on somebody's screen.
 * So the whitelist is asserted three ways — as a type, as the exact key set of
 * every produced row, and as a scan of the serialised payload — because each
 * catches a different way of getting it wrong (adding a field to the type,
 * spreading a raw row into it, nesting the private object inside).
 */

// --- compile-time whitelist ------------------------------------------------
// These aliases are the assertion. Adding `usn` or `cgpa` to `LeaderboardEntry`
// makes `Extract<…>` non-empty and this file stops compiling, which
// `npm run typecheck` sweeps in along with the rest of `src/`.

type ForbiddenKey = (typeof FORBIDDEN_PEER_FIELDS)[number];
type AssertNever<T extends never> = T;
type _EntryCarriesNothingForbidden = AssertNever<
  Extract<keyof LeaderboardEntry, ForbiddenKey>
>;

type AllowedKey = (typeof PEER_VISIBLE_FIELDS)[number];
type _EntryCarriesNothingElse = AssertNever<Exclude<keyof LeaderboardEntry, AllowedKey>>;

// --- fixtures --------------------------------------------------------------

function session(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    userId: 'usr_1',
    email: 'student@bgscet.ac.in',
    name: 'Aditi Rao',
    role: 'STUDENT',
    studentId: 'stu_1',
    ...overrides,
  };
}

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function entry(overrides: Partial<RankInput> & { studentId: string }): RankInput {
  return {
    displayName: 'Peer',
    optOut: false,
    value: 0,
    achievedAt: null,
    ...overrides,
  };
}

/// A small cohort: the viewer fourth, one opted-out student second.
const COHORT: RankInput[] = [
  entry({ studentId: 'stu_9', displayName: 'Bhavana K', value: 9, achievedAt: day('2026-02-01') }),
  entry({
    studentId: 'stu_8',
    displayName: 'Hidden Student',
    value: 8,
    achievedAt: day('2026-02-02'),
    optOut: true,
  }),
  entry({ studentId: 'stu_7', displayName: 'Chirag N', value: 7, achievedAt: day('2026-03-01') }),
  entry({ studentId: 'stu_6', displayName: 'Divya S', value: 6, achievedAt: day('2026-03-02') }),
  entry({ studentId: 'stu_1', displayName: 'Aditi Rao', value: 5, achievedAt: day('2026-04-01') }),
  entry({ studentId: 'stu_2', displayName: 'Eshan P', value: 0, achievedAt: null }),
];

const rankAll = (rows: RankInput[], viewerStudentId = 'stu_1') =>
  rankBoard(rows, { viewerStudentId, band: 'share', visible: 10 });

// ---------------------------------------------------------------------------

describe('leaderboardScope', () => {
  it('caps a student to their own cohort', () => {
    expect(leaderboardScope(session(), 'coh_1')).toEqual({
      kind: 'cohort',
      cohortId: 'coh_1',
      viewerStudentId: 'stu_1',
    });
  });

  it('fails closed for a student session carrying no studentId', () => {
    expect(leaderboardScope(session({ studentId: undefined }), 'coh_1')).toEqual({
      kind: 'none',
    });
  });

  it('fails closed when the cohort is unknown', () => {
    // The token has no cohort in it, so the caller supplies one. A missing
    // cohort must not widen to the programme — that is the `session.mentorId ?
    // … : {}` bug wearing a different field's name.
    for (const cohortId of [null, undefined, '']) {
      expect(leaderboardScope(session(), cohortId)).toEqual({ kind: 'none' });
    }
  });

  it('fails closed for every role that is not a student', () => {
    for (const role of ['MENTOR', 'DIRECTOR', 'ADMIN'] as const) {
      expect(leaderboardScope(session({ role, studentId: 'stu_1' }), 'coh_1')).toEqual({
        kind: 'none',
      });
    }
  });
});

describe('leaderboardWhere', () => {
  it('filters to the cohort', () => {
    expect(leaderboardWhere(leaderboardScope(session(), 'coh_1'))).toEqual({
      cohortId: 'coh_1',
    });
  });

  it('NEVER returns an empty clause', () => {
    // `{}` here would mean "rank this student against the whole programme",
    // which is both a wider disclosure than the feature needs and a meaningless
    // comparison across semesters.
    for (const scope of [
      leaderboardScope(session(), 'coh_1'),
      leaderboardScope(session({ role: 'DIRECTOR' }), 'coh_1'),
      leaderboardScope(session({ studentId: undefined }), 'coh_1'),
      leaderboardScope(session(), null),
    ]) {
      const where = leaderboardWhere(scope);
      expect(where).not.toEqual({});
      expect(Object.keys(where).length).toBeGreaterThan(0);
    }
  });

  it('uses an unmatchable filter for the closed scope', () => {
    expect(leaderboardWhere({ kind: 'none' })).toEqual({ id: '__none__' });
  });
});

describe('the student-facing payload', () => {
  it('carries exactly the whitelisted fields and nothing else', () => {
    const board = rankAll(COHORT);
    expect(board.rows.length).toBeGreaterThan(0);

    for (const row of board.rows) {
      expect(Object.keys(row).sort()).toEqual([...PEER_VISIBLE_FIELDS].sort());
    }
  });

  it('carries none of the forbidden fields, at any depth', () => {
    // A field can arrive by being added to the type, or by a private object
    // being nested inside a whitelisted one. Walking the serialised payload
    // catches the second, which the key-set check above would miss.
    const board = rankAll(COHORT);
    const seen = new Set<string>();
    const walk = (value: unknown) => {
      if (value == null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        seen.add(key);
        walk(child);
      }
    };
    walk(board.rows);

    for (const forbidden of FORBIDDEN_PEER_FIELDS) {
      expect([...seen]).not.toContain(forbidden);
    }
  });

  it('never reveals a peer id, so a board cannot be turned into links', () => {
    const board = rankAll(COHORT);
    expect(JSON.stringify(board.rows)).not.toContain('stu_');
  });

  it('gives a peer a coarse band and no figure at all', () => {
    const board = rankAll(COHORT);
    const peers = board.rows.filter((row) => !row.isViewer);

    expect(peers.length).toBeGreaterThan(0);
    for (const peer of peers) {
      expect(peer.yourValue).toBeNull();
      expect(['Leading', 'Strong', 'Building', 'Not started']).toContain(peer.band);
    }
  });

  it('shows the viewer their own exact figure', () => {
    const board = rankAll(COHORT);
    const mine = board.rows.find((row) => row.isViewer);

    expect(mine?.yourValue).toBe(5);
    expect(board.you?.value).toBe(5);
  });

  it('does not coarsen the viewer’s own CGPA', () => {
    // The one board whose figure is never shown to a peer is still shown in
    // full to the person it belongs to.
    const board = rankBoard(
      [entry({ studentId: 'stu_1', displayName: 'Aditi Rao', value: 8.42 })],
      { viewerStudentId: 'stu_1', band: 'class' },
    );

    expect(board.you?.value).toBe(8.42);
    expect(board.you?.band).toBe('Distinction');
    expect(board.rows[0].yourValue).toBe(8.42);
  });

  it('leaks no peer CGPA through the class band', () => {
    const board = rankBoard(
      [
        entry({ studentId: 'stu_9', displayName: 'Bhavana K', value: 9.11 }),
        entry({ studentId: 'stu_1', displayName: 'Aditi Rao', value: 6.4 }),
      ],
      { viewerStudentId: 'stu_1', band: 'class' },
    );

    const peer = board.rows.find((row) => !row.isViewer);
    expect(peer?.band).toBe('Distinction');
    expect(peer?.yourValue).toBeNull();
    expect(JSON.stringify(board.rows)).not.toContain('9.11');
  });
});

describe('leaderboardOptOut', () => {
  it('removes an opted-out student from everyone else’s board', () => {
    const board = rankAll(COHORT);

    expect(board.rows.map((row) => row.displayName)).not.toContain('Hidden Student');
    expect(board.optedOutPeers).toBe(1);
    expect(board.ranked).toBe(5);
  });

  it('closes the rank sequence rather than leaving a gap where they were', () => {
    // A gap at rank 2 would announce that somebody is hidden at rank 2, which
    // is most of what the opt-out was meant to withhold.
    const board = rankAll(COHORT);
    expect(board.rows.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it('still shows an opted-out viewer their own position and figure', () => {
    const opted = COHORT.map((row) =>
      row.studentId === 'stu_1' ? { ...row, optOut: true } : row,
    );
    const board = rankAll(opted);

    expect(board.you).not.toBeNull();
    expect(board.you?.onBoard).toBe(false);
    expect(board.you?.value).toBe(5);
    // Bhavana 9, Chirag 7, Divya 6 are ahead; Eshan on 0 is not.
    expect(board.you?.rank).toBe(4);
    expect(board.you?.outOf).toBe(5);
    expect(board.rows.some((row) => row.isViewer)).toBe(false);
  });

  it('does not let an opted-out viewer displace the peers they are reading', () => {
    const opted = COHORT.map((row) =>
      row.studentId === 'stu_1' ? { ...row, optOut: true } : row,
    );
    const board = rankAll(opted);

    expect(board.rows.map((row) => row.displayName)).toEqual([
      'Bhavana K',
      'Chirag N',
      'Divya S',
      'Eshan P',
    ]);
  });

  it('counts an opted-out viewer as on the board when they have not opted out', () => {
    const board = rankAll(COHORT);
    expect(board.you?.onBoard).toBe(true);
    expect(board.you?.rank).toBe(4);
    expect(board.you?.outOf).toBe(5);
  });
});

describe('ranking order', () => {
  it('is stable however the rows arrive', () => {
    const shuffled = [...COHORT].reverse();
    expect(rankAll(shuffled).rows).toEqual(rankAll(COHORT).rows);
  });

  it('breaks a tie on the earliest achievement date', () => {
    const tied = [
      entry({ studentId: 'stu_b', displayName: 'Later', value: 4, achievedAt: day('2026-05-01') }),
      entry({ studentId: 'stu_a', displayName: 'Earlier', value: 4, achievedAt: day('2026-01-01') }),
    ];
    expect(rankAll(tied, 'stu_a').rows.map((row) => row.displayName)).toEqual([
      'Earlier',
      'Later',
    ]);
  });

  it('falls back to the name, then to the id', () => {
    const tied = [
      entry({ studentId: 'stu_z', displayName: 'Zoya M', value: 4, achievedAt: day('2026-01-01') }),
      entry({ studentId: 'stu_b', displayName: 'Arun T', value: 4, achievedAt: day('2026-01-01') }),
      entry({ studentId: 'stu_a', displayName: 'Arun T', value: 4, achievedAt: day('2026-01-01') }),
    ];
    expect(rankAll(tied, 'stu_a').rows.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(compareEntries(tied[2], tied[1])).toBeLessThan(0);
    expect(compareEntries(tied[1], tied[0])).toBeLessThan(0);
  });

  it('sorts a student with no achievement date behind one who has it', () => {
    const rows = [
      entry({ studentId: 'stu_a', displayName: 'Undated', value: 4, achievedAt: null }),
      entry({ studentId: 'stu_b', displayName: 'Dated', value: 4, achievedAt: day('2026-06-01') }),
    ];
    expect(rankAll(rows, 'stu_a').rows.map((row) => row.displayName)).toEqual([
      'Dated',
      'Undated',
    ]);
  });

  it('appends the viewer below the visible slice instead of widening it', () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      entry({ studentId: `stu_${i}`, displayName: `Student ${i}`, value: 100 - i }),
    );
    many.push(entry({ studentId: 'stu_me', displayName: 'Aditi Rao', value: 1 }));

    const board = rankBoard(many, { viewerStudentId: 'stu_me', band: 'share', visible: 10 });

    expect(board.viewerAppended).toBe(true);
    expect(board.rows).toHaveLength(11);
    expect(board.rows.at(-1)?.isViewer).toBe(true);
    expect(board.rows.at(-1)?.rank).toBe(15);
    expect(board.rows.slice(0, 10).map((row) => row.rank)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });
});

describe('the empty cases', () => {
  it('survives a cohort of one — a brand-new student on their own', () => {
    const board = rankAll([entry({ studentId: 'stu_1', displayName: 'Aditi Rao' })]);

    expect(board.rows).toHaveLength(1);
    expect(board.you).toEqual({
      rank: 1,
      outOf: 1,
      value: 0,
      band: 'Not started',
      onBoard: true,
      empty: true,
    });
  });

  it('survives an empty cohort without inventing a standing', () => {
    const board = rankAll([]);
    expect(board.rows).toEqual([]);
    expect(board.you).toBeNull();
    expect(board.ranked).toBe(0);
  });

  it('says when nobody has got off zero, so the page can decline to rank them', () => {
    // Eleven students who have not taken a mock are not first through eleventh
    // at taking mocks.
    const board = rankAll([
      entry({ studentId: 'stu_1', displayName: 'Aditi Rao' }),
      entry({ studentId: 'stu_2', displayName: 'Bhavana K' }),
      entry({ studentId: 'stu_3', displayName: 'Chirag N' }),
    ]);

    expect(board.hasFigures).toBe(false);
    expect(board.ranked).toBe(3);
  });

  it('says when somebody has', () => {
    expect(rankAll(COHORT).hasFigures).toBe(true);
  });

  it('reports no figures for an empty cohort rather than dividing by its leader', () => {
    expect(rankAll([]).hasFigures).toBe(false);
  });

  it('survives a cohort in which every peer has opted out', () => {
    const board = rankAll([
      entry({ studentId: 'stu_1', displayName: 'Aditi Rao', value: 3 }),
      entry({ studentId: 'stu_2', displayName: 'Hidden', value: 9, optOut: true }),
    ]);

    expect(board.rows.map((row) => row.displayName)).toEqual(['Aditi Rao']);
    expect(board.you?.rank).toBe(1);
    expect(board.optedOutPeers).toBe(1);
  });
});

describe('bands', () => {
  it('is four buckets wide and no finer', () => {
    expect(shareBand(10, 10)).toBe('Leading');
    expect(shareBand(8, 10)).toBe('Leading');
    expect(shareBand(7.9, 10)).toBe('Strong');
    expect(shareBand(5, 10)).toBe('Strong');
    expect(shareBand(4.9, 10)).toBe('Building');
    expect(shareBand(1, 10)).toBe('Building');
    expect(shareBand(0, 10)).toBe('Not started');
  });

  it('does not divide by a leader on zero', () => {
    expect(shareBand(0, 0)).toBe('Not started');
  });

  it('uses VTU’s own class boundaries', () => {
    expect(classBand(9.2)).toBe('Distinction');
    expect(classBand(7.75)).toBe('Distinction');
    expect(classBand(7.74)).toBe('First class');
    expect(classBand(6.75)).toBe('First class');
    expect(classBand(6.74)).toBe('Second class');
    expect(classBand(5.75)).toBe('Second class');
    expect(classBand(5.74)).toBe('Pass');
    expect(classBand(0)).toBe('No result yet');
  });
});
