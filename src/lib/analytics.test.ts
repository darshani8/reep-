import { describe, expect, it } from 'vitest';

import { makeSession } from '../../test/fixtures';
import type { CourseBottleneck } from './analytics';
import {
  ABANDONED_SESSION_MIN,
  SHALLOW_PROGRESS_PER_HOUR,
  classifySession,
  consistency,
  courseAllocation,
  dailyBuckets,
  focusQuality,
  forecastCompletion,
  modeBreakdown,
  paceCurve,
  rankBottlenecks,
  timeOfDayProfile,
  weeklySeries,
} from './analytics';

const MONDAY = new Date(2026, 7, 3); // 2026-08-03 is a Monday

describe('dailyBuckets', () => {
  it('labels the days it renders starting from Monday', () => {
    const buckets = dailyBuckets([], MONDAY, 12);

    expect(buckets.map((b) => b.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  });

  it('spreads the weekly target evenly across the days it renders', () => {
    const buckets = dailyBuckets([], MONDAY, 12);

    expect(buckets.every((b) => b.targetHours === 2)).toBe(true);
  });

  it('puts a session in the day it started', () => {
    const sessions = [makeSession({ checkInAt: new Date(2026, 7, 5, 14, 0), durationMin: 90 })];
    const buckets = dailyBuckets(sessions, MONDAY, 12);

    expect(buckets[2].hours).toBe(1.5);
    expect(buckets[1].hours).toBe(0);
  });

  it('puts a session starting exactly at midnight in that day, not the one before', () => {
    const sessions = [makeSession({ checkInAt: new Date(2026, 7, 5, 0, 0), durationMin: 60 })];

    expect(dailyBuckets(sessions, MONDAY, 12)[2].hours).toBe(1);
  });

  it('puts a session at 23:59 in that day, not the next', () => {
    const sessions = [makeSession({ checkInAt: new Date(2026, 7, 5, 23, 59), durationMin: 30 })];

    expect(dailyBuckets(sessions, MONDAY, 12)[2].hours).toBe(0.5);
  });

  it('splits a day by learning mode and totals them', () => {
    const sessions = [
      makeSession({ checkInAt: new Date(2026, 7, 3, 9, 0), durationMin: 60, mode: 'INSTRUCTOR_LED' }),
      makeSession({ checkInAt: new Date(2026, 7, 3, 14, 0), durationMin: 120, mode: 'SUPERVISED_LAB' }),
    ];
    const monday = dailyBuckets(sessions, MONDAY, 12)[0];

    expect(monday.byMode.INSTRUCTOR_LED).toBe(1);
    expect(monday.byMode.SUPERVISED_LAB).toBe(2);
    expect(monday.byMode.INDEPENDENT).toBe(0);
    expect(monday.hours).toBe(3);
  });

  it('marks the target met only once the day reaches it', () => {
    const under = [makeSession({ checkInAt: new Date(2026, 7, 3, 9, 0), durationMin: 110 })];
    const exact = [makeSession({ checkInAt: new Date(2026, 7, 3, 9, 0), durationMin: 120 })];

    expect(dailyBuckets(under, MONDAY, 12)[0].metTarget).toBe(false);
    expect(dailyBuckets(exact, MONDAY, 12)[0].metTarget).toBe(true);
  });

  it('counts an open session as zero hours rather than crashing on a null duration', () => {
    const sessions = [makeSession({ checkInAt: new Date(2026, 7, 3, 9, 0), durationMin: null })];

    expect(dailyBuckets(sessions, MONDAY, 12)[0].hours).toBe(0);
  });

  it('renders a seven-day week when asked for one', () => {
    const buckets = dailyBuckets([], MONDAY, 14, 7);

    expect(buckets).toHaveLength(7);
    expect(buckets[6].label).toBe('Sun');
    expect(buckets[6].targetHours).toBe(2);
  });
});

describe('modeBreakdown', () => {
  it('always reports all three modes, even at zero', () => {
    const breakdown = modeBreakdown([]);

    expect(breakdown.map((m) => m.mode)).toEqual([
      'INSTRUCTOR_LED',
      'SUPERVISED_LAB',
      'INDEPENDENT',
    ]);
    expect(breakdown.every((m) => m.hours === 0 && m.pct === 0)).toBe(true);
  });

  it('splits hours and shares between modes', () => {
    const breakdown = modeBreakdown([
      makeSession({ durationMin: 60, mode: 'SUPERVISED_LAB' }),
      makeSession({ durationMin: 180, mode: 'INDEPENDENT' }),
    ]);
    const byMode = new Map(breakdown.map((m) => [m.mode, m]));

    expect(byMode.get('SUPERVISED_LAB')!.pct).toBe(25);
    expect(byMode.get('INDEPENDENT')!.pct).toBe(75);
    expect(byMode.get('SUPERVISED_LAB')!.sessionCount).toBe(1);
  });

  it('has shares summing to 100 when any time is logged', () => {
    const breakdown = modeBreakdown([
      makeSession({ durationMin: 50, mode: 'SUPERVISED_LAB' }),
      makeSession({ durationMin: 70, mode: 'INDEPENDENT' }),
      makeSession({ durationMin: 30, mode: 'INSTRUCTOR_LED' }),
    ]);

    expect(breakdown.reduce((sum, m) => sum + m.pct, 0)).toBeCloseTo(100, 1);
  });

  it('counts an open session in the session count but not the hours', () => {
    const breakdown = modeBreakdown([makeSession({ durationMin: null, mode: 'SUPERVISED_LAB' })]);
    const lab = breakdown.find((m) => m.mode === 'SUPERVISED_LAB')!;

    expect(lab.sessionCount).toBe(1);
    expect(lab.hours).toBe(0);
  });
});

describe('weeklySeries', () => {
  const now = new Date(2026, 7, 5, 12, 0); // Wednesday

  it('returns the requested number of weeks ending with the current one', () => {
    const series = weeklySeries([], 4, 12, now);

    expect(series).toHaveLength(4);
    expect(series[3].weekStart).toEqual(MONDAY);
  });

  it('leaves weeks with no sessions at zero rather than omitting them', () => {
    const series = weeklySeries([makeSession({ checkInAt: new Date(2026, 7, 4), durationMin: 60 })], 3, 12, now);

    expect(series[0].hours).toBe(0);
    expect(series[1].hours).toBe(0);
    expect(series[2].hours).toBe(1);
  });

  it('does not let a session leak into an adjacent week', () => {
    // Sunday 2026-08-02 belongs to the week before the one starting 08-03.
    const series = weeklySeries(
      [makeSession({ checkInAt: new Date(2026, 7, 2, 23, 0), durationMin: 60 })],
      2,
      12,
      now,
    );

    expect(series[0].hours).toBe(1);
    expect(series[1].hours).toBe(0);
  });
});

describe('classifySession', () => {
  it('is UNVERIFIED while a session is still open', () => {
    expect(classifySession(makeSession({ checkOutAt: null, durationMin: null }))).toBe('UNVERIFIED');
  });

  it('is UNVERIFIED for a closed session with no provider progress figure', () => {
    expect(classifySession(makeSession({ durationMin: 90, progressDeltaPct: null }))).toBe(
      'UNVERIFIED',
    );
  });

  it('is ABANDONED just under the short-session floor', () => {
    expect(
      classifySession(makeSession({ durationMin: ABANDONED_SESSION_MIN - 1, progressDeltaPct: 5 })),
    ).toBe('ABANDONED');
  });

  it('is not ABANDONED exactly at the floor', () => {
    expect(
      classifySession(makeSession({ durationMin: ABANDONED_SESSION_MIN, progressDeltaPct: 5 })),
    ).not.toBe('ABANDONED');
  });

  it('is PRODUCTIVE at or above the yield threshold', () => {
    // 60 minutes, 1.5 points gained = exactly 1.5 points per hour.
    expect(
      classifySession(makeSession({ durationMin: 60, progressDeltaPct: SHALLOW_PROGRESS_PER_HOUR })),
    ).toBe('PRODUCTIVE');
  });

  it('is SHALLOW just below the yield threshold', () => {
    expect(classifySession(makeSession({ durationMin: 60, progressDeltaPct: 1.4 }))).toBe('SHALLOW');
  });

  it('treats a very short session as at least a quarter hour when dividing', () => {
    // The floor stops a 21-minute session with 1 point looking like a 3x
    // performer through a tiny denominator.
    expect(classifySession(makeSession({ durationMin: 21, progressDeltaPct: 0.3 }))).toBe('SHALLOW');
  });
});

describe('focusQuality', () => {
  it('reports zeroes for a student with no sessions rather than NaN', () => {
    const quality = focusQuality([]);

    expect(quality.totalSessions).toBe(0);
    expect(quality.progressPerHour).toBe(0);
    expect(quality.medianSessionMin).toBe(0);
    expect(quality.abandonedRatePct).toBe(0);
    expect(Number.isNaN(quality.focusScore)).toBe(false);
  });

  it('excludes open sessions from every figure', () => {
    const quality = focusQuality([
      makeSession({ durationMin: null, checkOutAt: null }),
      makeSession({ durationMin: 60, progressDeltaPct: 3 }),
    ]);

    expect(quality.totalSessions).toBe(1);
    expect(quality.totalHours).toBe(1);
  });

  it('computes yield as progress points per logged hour', () => {
    const quality = focusQuality([
      makeSession({ durationMin: 120, progressDeltaPct: 6 }),
    ]);

    expect(quality.progressPerHour).toBe(3);
  });

  it('takes the median of an odd and an even number of sessions', () => {
    const odd = focusQuality([
      makeSession({ durationMin: 30, progressDeltaPct: 1 }),
      makeSession({ durationMin: 90, progressDeltaPct: 1 }),
      makeSession({ durationMin: 60, progressDeltaPct: 1 }),
    ]);
    const even = focusQuality([
      makeSession({ durationMin: 30, progressDeltaPct: 1 }),
      makeSession({ durationMin: 90, progressDeltaPct: 1 }),
    ]);

    expect(odd.medianSessionMin).toBe(60);
    expect(even.medianSessionMin).toBe(60);
  });

  it('rates a student who logs long productive sessions near the top', () => {
    const quality = focusQuality([
      makeSession({ durationMin: 120, progressDeltaPct: 8 }),
      makeSession({ durationMin: 120, progressDeltaPct: 7 }),
    ]);

    expect(quality.focusScore).toBeGreaterThan(80);
  });

  it('drags the score down for a student who taps in and leaves', () => {
    const quality = focusQuality([
      makeSession({ durationMin: 5, progressDeltaPct: 0 }),
      makeSession({ durationMin: 6, progressDeltaPct: 0 }),
      makeSession({ durationMin: 7, progressDeltaPct: 0 }),
    ]);

    expect(quality.abandonedRatePct).toBe(100);
    expect(quality.focusScore).toBe(0);
  });

  it('keeps the score inside 0–100 for extreme yields', () => {
    const quality = focusQuality([makeSession({ durationMin: 30, progressDeltaPct: 100 })]);

    expect(quality.focusScore).toBeLessThanOrEqual(100);
    expect(quality.focusScore).toBeGreaterThanOrEqual(0);
  });

  it('classifies every counted session into exactly one bucket', () => {
    const sessions = [
      makeSession({ durationMin: 10, progressDeltaPct: 0 }),
      makeSession({ durationMin: 60, progressDeltaPct: 5 }),
      makeSession({ durationMin: 60, progressDeltaPct: 0.5 }),
      makeSession({ durationMin: 60, progressDeltaPct: null }),
    ];
    const quality = focusQuality(sessions);
    const total = Object.values(quality.counts).reduce((sum, n) => sum + n, 0);

    expect(total).toBe(quality.totalSessions);
  });
});

describe('consistency', () => {
  const now = new Date(2026, 7, 9, 12, 0);

  it('reports an empty window for a student with no sessions', () => {
    const result = consistency([], 30, now);

    expect(result).toMatchObject({
      activeDays: 0,
      currentStreakDays: 0,
      longestStreakDays: 0,
      lastActiveAt: null,
    });
    expect(result.longestGapDays).toBe(30);
  });

  it('counts a day once however many sessions fall in it', () => {
    const result = consistency(
      [
        makeSession({ checkInAt: new Date(2026, 7, 9, 9, 0) }),
        makeSession({ checkInAt: new Date(2026, 7, 9, 15, 0) }),
      ],
      30,
      now,
    );

    expect(result.activeDays).toBe(1);
  });

  it('counts consecutive days as a streak', () => {
    const result = consistency(
      [7, 8, 9].map((day) => makeSession({ checkInAt: new Date(2026, 7, day, 10, 0) })),
      30,
      now,
    );

    expect(result.currentStreakDays).toBe(3);
    expect(result.longestStreakDays).toBe(3);
  });

  it('does not break the current streak just because today is still empty', () => {
    const result = consistency(
      [7, 8].map((day) => makeSession({ checkInAt: new Date(2026, 7, day, 10, 0) })),
      30,
      now,
    );

    expect(result.currentStreakDays).toBe(2);
  });

  it('breaks a streak on a missing day', () => {
    const result = consistency(
      [5, 6, 9].map((day) => makeSession({ checkInAt: new Date(2026, 7, day, 10, 0) })),
      30,
      now,
    );

    expect(result.currentStreakDays).toBe(1);
    expect(result.longestStreakDays).toBe(2);
  });

  it('reports the most recent check-in even when it is outside the window', () => {
    const old = new Date(2026, 5, 1, 10, 0);
    const result = consistency([makeSession({ checkInAt: old })], 30, now);

    expect(result.lastActiveAt).toEqual(old);
    expect(result.activeDays).toBe(0);
  });

  it('expresses the active-day rate against the window, not against the sessions', () => {
    const result = consistency(
      [makeSession({ checkInAt: new Date(2026, 7, 9, 10, 0) })],
      10,
      now,
    );

    expect(result.activeDayRatePct).toBe(10);
  });
});

describe('timeOfDayProfile', () => {
  it('always returns all six bands', () => {
    expect(timeOfDayProfile([])).toHaveLength(6);
  });

  it('files a session under the band its check-in falls in', () => {
    const profile = timeOfDayProfile([
      makeSession({ checkInAt: new Date(2026, 7, 3, 19, 30), durationMin: 60, progressDeltaPct: 4 }),
    ]);
    const evening = profile.find((b) => b.startHour === 18)!;

    expect(evening.hours).toBe(1);
    expect(evening.progressPerHour).toBe(4);
  });

  it('wraps the small hours into the night band rather than dropping them', () => {
    // 02:00 is "Night (21–6)", not a seventh band and not nowhere.
    const profile = timeOfDayProfile([
      makeSession({ checkInAt: new Date(2026, 7, 3, 2, 0), durationMin: 60 }),
    ]);

    expect(profile.find((b) => b.startHour === 21)!.hours).toBe(1);
    expect(profile.reduce((sum, b) => sum + b.hours, 0)).toBe(1);
  });

  it('reports zero yield rather than NaN for a band with no hours', () => {
    expect(timeOfDayProfile([]).every((b) => b.progressPerHour === 0)).toBe(true);
  });
});

describe('forecastCompletion', () => {
  const now = new Date(2026, 7, 3);
  const deadline = new Date(2026, 9, 3); // ~8.7 weeks out

  it('projects no movement for a student with no recent sessions', () => {
    const forecast = forecastCompletion({ sessions: [], currentPct: 40, deadline, now });

    expect(forecast.velocityPctPerWeek).toBe(0);
    expect(forecast.projectedCompletionPct).toBe(40);
    expect(forecast.willFinishOnTime).toBe(false);
  });

  it('returns no finish date rather than an Infinite one when velocity is zero', () => {
    const forecast = forecastCompletion({ sessions: [], currentPct: 40, deadline, now });

    expect(forecast.projectedFinishDate).toBeNull();
  });

  it('projects forward from the trailing velocity', () => {
    const sessions = [
      makeSession({ checkInAt: new Date(2026, 7, 1), durationMin: 240, progressDeltaPct: 20 }),
    ];
    const forecast = forecastCompletion({ sessions, currentPct: 40, deadline, now, trailingWeeks: 4 });

    expect(forecast.velocityPctPerWeek).toBe(5);
    expect(forecast.projectedCompletionPct).toBeGreaterThan(40);
  });

  it('ignores sessions older than the trailing window', () => {
    const sessions = [
      makeSession({ checkInAt: new Date(2026, 5, 1), durationMin: 600, progressDeltaPct: 80 }),
    ];
    const forecast = forecastCompletion({ sessions, currentPct: 40, deadline, now, trailingWeeks: 4 });

    expect(forecast.velocityPctPerWeek).toBe(0);
  });

  it('says a finished student is done today', () => {
    const forecast = forecastCompletion({ sessions: [], currentPct: 100, deadline, now });

    expect(forecast.willFinishOnTime).toBe(true);
    expect(forecast.projectedFinishDate).toEqual(now);
  });

  it('treats a deadline in the past as zero weeks remaining, not negative', () => {
    const forecast = forecastCompletion({
      sessions: [],
      currentPct: 40,
      deadline: new Date(2026, 6, 1),
      now,
    });

    expect(forecast.weeksRemaining).toBe(0);
    expect(forecast.requiredPctPerWeek).toBe(60);
  });

  it('asks for no extra hours from a student already ahead of the required rate', () => {
    const sessions = [
      makeSession({ checkInAt: new Date(2026, 7, 2), durationMin: 600, progressDeltaPct: 90 }),
    ];
    const forecast = forecastCompletion({ sessions, currentPct: 90, deadline, now });

    expect(forecast.extraHoursPerWeekNeeded).toBe(0);
  });

  it('converts a shortfall into extra hours using the student own observed yield', () => {
    // 2 hours produced 2 points, so a yield of 1 point/hour: the extra hours
    // asked for should equal the weekly points shortfall.
    const sessions = [
      makeSession({ checkInAt: new Date(2026, 7, 2), durationMin: 120, progressDeltaPct: 2 }),
    ];
    const forecast = forecastCompletion({ sessions, currentPct: 10, deadline, now, trailingWeeks: 4 });

    expect(forecast.extraHoursPerWeekNeeded).toBeGreaterThan(0);
    expect(forecast.extraHoursPerWeekNeeded).toBeCloseTo(
      forecast.requiredPctPerWeek - forecast.velocityPctPerWeek,
      1,
    );
  });
});

describe('paceCurve', () => {
  const startedAt = new Date(2026, 0, 5);
  const deadline = new Date(2026, 3, 6); // 13 weeks
  const now = new Date(2026, 1, 2);

  it('draws the expected line from 0 to 100 across the whole window', () => {
    const points = paceCurve({ sessions: [], startedAt, deadline, currentPct: 0, now });

    expect(points[0].expected).toBe(0);
    expect(points[points.length - 1].expected).toBe(100);
  });

  it('leaves the actual line unplotted for weeks that have not happened', () => {
    const points = paceCurve({ sessions: [], startedAt, deadline, currentPct: 10, now });
    const future = points.filter((p) => p.date > now);

    expect(future.length).toBeGreaterThan(0);
    expect(future.every((p) => p.actual === null)).toBe(true);
  });

  it('anchors the last observed point to the authoritative current percentage', () => {
    // The chart must not disagree with the number in the header above it.
    const points = paceCurve({ sessions: [], startedAt, deadline, currentPct: 37.5, now });
    const observed = points.filter((p) => p.actual !== null);

    expect(observed[observed.length - 1].actual).toBe(37.5);
  });

  it('always produces at least one week even for a zero-length window', () => {
    const points = paceCurve({
      sessions: [],
      startedAt,
      deadline: startedAt,
      currentPct: 0,
      now,
    });

    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(points.every((p) => Number.isFinite(p.expected))).toBe(true);
  });
});

describe('rankBottlenecks', () => {
  const rows: CourseBottleneck[] = [
    { courseCode: 'A', courseName: 'A', stage: 'REBOOT', completionPct: 80, enrolledCount: 10, atRiskCount: 1 },
    { courseCode: 'B', courseName: 'B', stage: 'REBOOT', completionPct: 20, enrolledCount: 10, atRiskCount: 8 },
    { courseCode: 'C', courseName: 'C', stage: 'EXCEL', completionPct: 50, enrolledCount: 10, atRiskCount: 4 },
  ];

  it('puts the least-completed course first', () => {
    expect(rankBottlenecks(rows)[0].courseCode).toBe('B');
    expect(rankBottlenecks(rows).map((r) => r.courseCode)).toEqual(['B', 'C', 'A']);
  });

  it('does not mutate the array it was given', () => {
    const original = rows.map((r) => r.courseCode);
    rankBottlenecks(rows);

    expect(rows.map((r) => r.courseCode)).toEqual(original);
  });

  it('honours the limit', () => {
    expect(rankBottlenecks(rows, 2)).toHaveLength(2);
  });

  it('returns everything when the limit exceeds the input', () => {
    expect(rankBottlenecks(rows, 99)).toHaveLength(3);
  });

  it('handles an empty input', () => {
    expect(rankBottlenecks([])).toEqual([]);
  });
});

describe('courseAllocation', () => {
  it('returns nothing for a student with no courses', () => {
    expect(courseAllocation([], [])).toEqual([]);
  });

  it('attributes logged hours to the course they were logged against', () => {
    const courses = [
      { code: 'REE101', name: 'One', teachingHours: 10, selfLearningHoursRequired: 10 },
      { code: 'REE202', name: 'Two', teachingHours: 10, selfLearningHoursRequired: 10 },
    ];
    const sessions = [
      makeSession({ courseCode: 'REE101', durationMin: 120 }),
      makeSession({ courseCode: 'REE202', durationMin: 60 }),
    ];
    const allocation = courseAllocation(
      sessions,
      courses as Parameters<typeof courseAllocation>[1],
    );
    const byCode = new Map(allocation.map((a) => [a.courseCode, a]));

    expect(byCode.get('REE101')!.loggedHours).toBe(2);
    expect(byCode.get('REE202')!.loggedHours).toBe(1);
  });
});
