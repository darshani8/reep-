import { describe, expect, it } from 'vitest';

import {
  MOCK_TYPES,
  SWOC_KINDS,
  attendanceTile,
  marksTile,
  mockTile,
  streakRail,
  swocTile,
} from './tiles';

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('attendanceTile', () => {
  it('reads 100% for a student with no sessions recorded', () => {
    const tile = attendanceTile([], new Map());
    expect(tile.overallPct).toBe(100);
    expect(tile.sessions).toBe(0);
    expect(tile.byCourse).toEqual([]);
  });

  it('puts the worst course first', () => {
    const tile = attendanceTile(
      [
        { courseCode: 'REE101', present: true, sessionDate: day('2026-08-03') },
        { courseCode: 'REE101', present: true, sessionDate: day('2026-08-04') },
        { courseCode: 'REE202', present: false, sessionDate: day('2026-08-03') },
        { courseCode: 'REE202', present: true, sessionDate: day('2026-08-04') },
      ],
      new Map([
        ['REE101', 'Business Communication'],
        ['REE202', 'Data Analysis'],
      ]),
    );

    expect(tile.overallPct).toBe(75);
    expect(tile.absent).toBe(1);
    expect(tile.byCourse.map((row) => row.value)).toEqual([50, 100]);
    expect(tile.byCourse[0].label).toBe('Data Analysis');
  });

  it('falls back to the course code when no name is known', () => {
    const tile = attendanceTile(
      [{ courseCode: 'REE999', present: true, sessionDate: day('2026-08-03') }],
      new Map(),
    );
    expect(tile.byCourse[0].label).toBe('REE999');
  });
});

describe('marksTile', () => {
  it('renders for a student with no results at all', () => {
    const tile = marksTile([]);
    expect(tile.sgpaSeries).toEqual([]);
    expect(tile.latest).toBeNull();
    expect(tile.cgpa).toBeNull();
  });

  it('plots only published semesters but still breaks down the in-progress one', () => {
    const tile = marksTile([
      {
        semester: 1,
        sgpa: 7.4,
        cgpa: 7.4,
        resultClass: 'FIRST CLASS',
        publishedOn: day('2026-02-01'),
        subjects: [
          {
            subjectCode: 'MBA11',
            subjectName: 'Management',
            credits: 4,
            internal: 40,
            external: 38,
            total: 78,
            passed: true,
          },
        ],
      },
      {
        semester: 2,
        sgpa: null,
        cgpa: null,
        resultClass: null,
        publishedOn: null,
        subjects: [
          {
            subjectCode: 'MBA21',
            subjectName: 'Operations',
            credits: 4,
            internal: 42,
            external: 0,
            total: 42,
            passed: true,
          },
        ],
      },
    ]);

    // The in-progress semester has no SGPA, so it is absent from the line — a
    // zero there would draw a collapse that has not happened.
    expect(tile.sgpaSeries).toHaveLength(1);
    expect(tile.sgpaSeries[0]).toMatchObject({ semester: 1, sgpa: 7.4, label: 'Sem 1' });

    // …but it is still the semester broken down, because that is the only view
    // a student mid-semester has.
    expect(tile.latest?.semester).toBe(2);
    expect(tile.latest?.published).toBe(false);
    expect(tile.latest?.subjects[0].external).toBe(0);
    expect(tile.cgpa).toBe(7.4);
  });

  it('counts backlogs in the latest semester', () => {
    const tile = marksTile([
      {
        semester: 3,
        sgpa: 5.1,
        cgpa: 6.0,
        resultClass: 'PASS',
        publishedOn: day('2026-06-01'),
        subjects: [
          { subjectCode: 'B', subjectName: 'Two', credits: 4, internal: 20, external: 12, total: 32, passed: false },
          { subjectCode: 'A', subjectName: 'One', credits: 4, internal: 35, external: 30, total: 65, passed: true },
        ],
      },
    ]);
    expect(tile.latest?.backlogs).toBe(1);
    // Sorted by subject code so the breakdown is stable between renders.
    expect(tile.latest?.subjects.map((s) => s.label)).toEqual(['A', 'B']);
  });
});

describe('swocTile', () => {
  /// The clause most likely to collapse into one free-text box.
  it('emits all four quadrants with all three sources even when empty', () => {
    const tile = swocTile([]);
    expect(tile.bars).toHaveLength(SWOC_KINDS.length);
    for (const bar of tile.bars) {
      expect(bar).toMatchObject({ PLACEMENT: 0, MENTOR: 0, PM: 0 });
    }
    expect(tile.bySource.map((row) => row.source)).toEqual(['PLACEMENT', 'MENTOR', 'PM']);
    expect(tile.total).toBe(0);
  });

  it('keeps the three desks apart rather than averaging them', () => {
    const tile = swocTile([
      { source: 'PLACEMENT', kind: 'WEAKNESS', text: 'Struggles to structure an answer', weight: 5, recordedAt: day('2026-08-01') },
      { source: 'MENTOR', kind: 'STRENGTH', text: 'Strongest analyst in the group', weight: 4, recordedAt: day('2026-08-02') },
      { source: 'PM', kind: 'OPPORTUNITY', text: 'Ready for the analytics track', weight: 3, recordedAt: day('2026-08-03') },
      { source: 'MENTOR', kind: 'STRENGTH', text: 'Reliable in a team', weight: 2, recordedAt: day('2026-08-04') },
    ]);

    const strength = tile.bars.find((bar) => bar.kind === 'STRENGTH')!;
    expect(strength).toMatchObject({ PLACEMENT: 0, MENTOR: 2, PM: 0 });

    const weakness = tile.bars.find((bar) => bar.kind === 'WEAKNESS')!;
    expect(weakness).toMatchObject({ PLACEMENT: 1, MENTOR: 0, PM: 0 });

    expect(tile.bySource).toEqual([
      { source: 'PLACEMENT', label: 'Placement cell', count: 1 },
      { source: 'MENTOR', label: 'Your mentor', count: 2 },
      { source: 'PM', label: 'Programme manager', count: 1 },
    ]);
  });

  it('quotes the heaviest line from each source', () => {
    const tile = swocTile(
      [
        { source: 'MENTOR', kind: 'STRENGTH', text: 'heaviest', weight: 5, recordedAt: day('2026-07-01') },
        { source: 'MENTOR', kind: 'CHALLENGE', text: 'lighter', weight: 1, recordedAt: day('2026-08-01') },
      ],
      1,
    );
    expect(tile.highlights).toHaveLength(1);
    expect(tile.highlights[0].text).toBe('heaviest');
  });
});

describe('mockTile', () => {
  /// A chart with two series is a silently dropped clause.
  it('renders GD, Interview and Aptitude even when every count is zero', () => {
    const tile = mockTile([]);
    expect(tile.bars.map((bar) => bar.type)).toEqual([...MOCK_TYPES]);
    for (const bar of tile.bars) {
      expect(bar.attempts).toBe(0);
      expect(bar.bestPct).toBeNull();
      expect(bar.lastTakenOn).toBeNull();
    }
  });

  it('keeps a type on the axis when only the others have attempts', () => {
    const tile = mockTile([
      { type: 'GD', takenOn: day('2026-07-01'), score: null, maxScore: null },
      { type: 'INTERVIEW', takenOn: day('2026-07-10'), score: 7, maxScore: 10 },
    ]);
    const aptitude = tile.bars.find((bar) => bar.type === 'APTITUDE')!;
    expect(aptitude.attempts).toBe(0);
    expect(tile.bars).toHaveLength(3);
  });

  it('normalises differently-marked papers to a percentage for the best result', () => {
    const tile = mockTile([
      { type: 'APTITUDE', takenOn: day('2026-06-01'), score: 55, maxScore: 100 },
      { type: 'APTITUDE', takenOn: day('2026-07-01'), score: 18, maxScore: 25 },
    ]);
    const aptitude = tile.bars.find((bar) => bar.type === 'APTITUDE')!;
    expect(aptitude.attempts).toBe(2);
    expect(aptitude.bestPct).toBe(72);
    expect(aptitude.lastTakenOn).toEqual(day('2026-07-01'));
  });

  it('reports an unscored debrief as not scored rather than as zero', () => {
    const tile = mockTile([{ type: 'GD', takenOn: day('2026-07-01'), score: null, maxScore: null }]);
    const gd = tile.bars.find((bar) => bar.type === 'GD')!;
    expect(gd.attempts).toBe(1);
    expect(gd.bestPct).toBeNull();
  });
});

describe('streakRail', () => {
  it('draws a full window for a student who has never signed in', () => {
    const rail = streakRail([], '2026-08-11');
    expect(rail).toHaveLength(14);
    expect(rail.every((square) => !square.present)).toBe(true);
    expect(rail[rail.length - 1].isToday).toBe(true);
  });

  it('marks Sunday as closed rather than as a miss', () => {
    // 2026-08-09 is the Sunday before Tuesday the 11th.
    const rail = streakRail(['2026-08-10'], '2026-08-11');
    const sunday = rail.find((square) => square.key === '2026-08-09')!;
    expect(sunday.closed).toBe(true);
    expect(sunday.present).toBe(false);

    const monday = rail.find((square) => square.key === '2026-08-10')!;
    expect(monday.closed).toBe(false);
    expect(monday.present).toBe(true);
  });

  it('runs oldest to newest and ends on today', () => {
    const rail = streakRail([], '2026-08-11', 3);
    expect(rail.map((square) => square.key)).toEqual([
      '2026-08-09',
      '2026-08-10',
      '2026-08-11',
    ]);
  });
});
