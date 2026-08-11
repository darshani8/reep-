/**
 * Analytics over the time-filled data.
 *
 * Every function here takes already-fetched rows and returns plain objects, so
 * it runs identically in a server component, an API route, or a test. Nothing
 * in this file touches Prisma.
 *
 * The guiding question is the one the wireframes ask: *did logged time convert
 * into real progress?* Hours alone are an attendance metric; hours divided by
 * provider-reported progress delta is a learning metric.
 */

import type { Course, LearningMode, Stage } from '@prisma/client';

import { MODE_LABEL, addDays, clamp, startOfWeek } from './reep';

export type SessionRow = {
  id: string;
  courseCode: string;
  module: string;
  mode: LearningMode;
  checkInAt: Date;
  checkOutAt: Date | null;
  durationMin: number | null;
  progressAtCheckIn: number | null;
  progressAtCheckOut: number | null;
  progressDeltaPct: number | null;
};

export const MINUTES_PER_HOUR = 60;

const hours = (minutes: number | null | undefined) => (minutes ?? 0) / MINUTES_PER_HOUR;

// ---------------------------------------------------------------------------
// Daily / weekly time series (Screen 3 "Hours This Week vs. Target")
// ---------------------------------------------------------------------------

export type DayBucket = {
  date: Date;
  label: string;
  hours: number;
  targetHours: number;
  byMode: Record<LearningMode, number>;
  metTarget: boolean;
};

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function dailyBuckets(
  sessions: SessionRow[],
  weekStart: Date,
  weeklyTargetHours: number,
  days = 6,
): DayBucket[] {
  // The programme runs Mon–Sat; the weekly target spreads across those days.
  const perDayTarget = weeklyTargetHours / days;

  return Array.from({ length: days }, (_, i) => {
    const date = addDays(weekStart, i);
    const next = addDays(weekStart, i + 1);
    const inDay = sessions.filter(
      (s) => s.checkInAt >= date && s.checkInAt < next,
    );

    const byMode: Record<LearningMode, number> = {
      INSTRUCTOR_LED: 0,
      SUPERVISED_LAB: 0,
      INDEPENDENT: 0,
    };
    for (const s of inDay) byMode[s.mode] += hours(s.durationMin);

    const total = byMode.INSTRUCTOR_LED + byMode.SUPERVISED_LAB + byMode.INDEPENDENT;

    return {
      date,
      label: DAY_LABELS[i] ?? '',
      hours: round1(total),
      targetHours: round1(perDayTarget),
      byMode,
      metTarget: total >= perDayTarget,
    };
  });
}

export type ModeBreakdown = {
  mode: LearningMode;
  label: string;
  hours: number;
  pct: number;
  sessionCount: number;
};

export function modeBreakdown(sessions: SessionRow[]): ModeBreakdown[] {
  const modes: LearningMode[] = ['INSTRUCTOR_LED', 'SUPERVISED_LAB', 'INDEPENDENT'];
  const totals = new Map<LearningMode, { h: number; n: number }>();
  for (const m of modes) totals.set(m, { h: 0, n: 0 });

  for (const s of sessions) {
    const entry = totals.get(s.mode)!;
    entry.h += hours(s.durationMin);
    entry.n += 1;
  }

  const grand = [...totals.values()].reduce((sum, v) => sum + v.h, 0);

  return modes.map((mode) => {
    const { h, n } = totals.get(mode)!;
    return {
      mode,
      label: MODE_LABEL[mode],
      hours: round1(h),
      pct: grand > 0 ? round1((h / grand) * 100) : 0,
      sessionCount: n,
    };
  });
}

export type WeekPoint = {
  weekStart: Date;
  label: string;
  hours: number;
  targetHours: number;
  progressGainedPct: number;
  sessions: number;
};

/// Rolling multi-week view used by the mentor Focus Log and the trend charts.
export function weeklySeries(
  sessions: SessionRow[],
  weeks: number,
  weeklyTargetHours: number,
  now = new Date(),
): WeekPoint[] {
  const currentWeek = startOfWeek(now);
  return Array.from({ length: weeks }, (_, i) => {
    const weekStart = addDays(currentWeek, -7 * (weeks - 1 - i));
    const weekEnd = addDays(weekStart, 7);
    const inWeek = sessions.filter(
      (s) => s.checkInAt >= weekStart && s.checkInAt < weekEnd,
    );
    return {
      weekStart,
      label: `W${i + 1}`,
      hours: round1(inWeek.reduce((sum, s) => sum + hours(s.durationMin), 0)),
      targetHours: weeklyTargetHours,
      progressGainedPct: round1(
        inWeek.reduce((sum, s) => sum + (s.progressDeltaPct ?? 0), 0),
      ),
      sessions: inWeek.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Focus quality — the anti-surveillance engagement signal
// ---------------------------------------------------------------------------

export type SessionQuality = 'PRODUCTIVE' | 'SHALLOW' | 'ABANDONED' | 'UNVERIFIED';

/// A session shorter than this reads as "tapped in and left".
export const ABANDONED_SESSION_MIN = 20;
/// Provider progress gained per hour below this reads as time-on-seat only.
export const SHALLOW_PROGRESS_PER_HOUR = 1.5;

export function classifySession(s: SessionRow): SessionQuality {
  if (s.checkOutAt == null || s.durationMin == null) return 'UNVERIFIED';
  if (s.durationMin < ABANDONED_SESSION_MIN) return 'ABANDONED';
  if (s.progressDeltaPct == null) return 'UNVERIFIED';
  const perHour = s.progressDeltaPct / Math.max(hours(s.durationMin), 0.25);
  return perHour >= SHALLOW_PROGRESS_PER_HOUR ? 'PRODUCTIVE' : 'SHALLOW';
}

export const QUALITY_LABEL: Record<SessionQuality, string> = {
  PRODUCTIVE: 'Productive',
  SHALLOW: 'Low yield',
  ABANDONED: 'Left early',
  UNVERIFIED: 'Unverified',
};

export type FocusQuality = {
  totalHours: number;
  totalSessions: number;
  progressGainedPct: number;
  /// Provider progress-points gained per logged hour. The headline number.
  progressPerHour: number;
  /// 0–100. Blends yield, session-length discipline, and consistency.
  focusScore: number;
  counts: Record<SessionQuality, number>;
  medianSessionMin: number;
  abandonedRatePct: number;
};

export function focusQuality(sessions: SessionRow[]): FocusQuality {
  const closed = sessions.filter((s) => s.durationMin != null);
  const totalHours = closed.reduce((sum, s) => sum + hours(s.durationMin), 0);
  const progressGained = closed.reduce((sum, s) => sum + (s.progressDeltaPct ?? 0), 0);

  const counts: Record<SessionQuality, number> = {
    PRODUCTIVE: 0,
    SHALLOW: 0,
    ABANDONED: 0,
    UNVERIFIED: 0,
  };
  for (const s of closed) counts[classifySession(s)] += 1;

  const durations = closed
    .map((s) => s.durationMin as number)
    .sort((a, b) => a - b);
  const medianSessionMin =
    durations.length === 0
      ? 0
      : durations.length % 2 === 1
        ? durations[(durations.length - 1) / 2]
        : Math.round(
            (durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2,
          );

  const progressPerHour = totalHours > 0 ? progressGained / totalHours : 0;
  const abandonedRate = closed.length > 0 ? (counts.ABANDONED / closed.length) * 100 : 0;

  // Yield carries the score; short-session churn drags it down. A student who
  // logs long sessions that produce nothing still scores poorly, which is the
  // whole point of measuring conversion rather than attendance.
  const yieldScore = clamp((progressPerHour / 3) * 100);
  const disciplineScore = clamp(100 - abandonedRate * 1.5);
  const focusScore = clamp(yieldScore * 0.65 + disciplineScore * 0.35);

  return {
    totalHours: round1(totalHours),
    totalSessions: closed.length,
    progressGainedPct: round1(progressGained),
    progressPerHour: round2(progressPerHour),
    focusScore: Math.round(focusScore),
    counts,
    medianSessionMin,
    abandonedRatePct: round1(abandonedRate),
  };
}

// ---------------------------------------------------------------------------
// Consistency & streaks
// ---------------------------------------------------------------------------

export type Consistency = {
  activeDays: number;
  windowDays: number;
  activeDayRatePct: number;
  currentStreakDays: number;
  longestStreakDays: number;
  longestGapDays: number;
  lastActiveAt: Date | null;
};

export function consistency(
  sessions: SessionRow[],
  windowDays = 30,
  now = new Date(),
): Consistency {
  const since = addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), -windowDays + 1);
  const dayKeys = new Set<string>();
  let lastActiveAt: Date | null = null;

  for (const s of sessions) {
    if (s.checkInAt >= since) dayKeys.add(dayKey(s.checkInAt));
    if (!lastActiveAt || s.checkInAt > lastActiveAt) lastActiveAt = s.checkInAt;
  }

  let currentStreak = 0;
  for (let i = 0; i < windowDays; i++) {
    if (dayKeys.has(dayKey(addDays(now, -i)))) currentStreak += 1;
    else if (i > 0) break; // today being empty does not break a streak yet
  }

  let longestStreak = 0;
  let running = 0;
  let longestGap = 0;
  let gap = 0;
  for (let i = windowDays - 1; i >= 0; i--) {
    if (dayKeys.has(dayKey(addDays(now, -i)))) {
      running += 1;
      longestStreak = Math.max(longestStreak, running);
      longestGap = Math.max(longestGap, gap);
      gap = 0;
    } else {
      running = 0;
      gap += 1;
    }
  }
  longestGap = Math.max(longestGap, gap);

  return {
    activeDays: dayKeys.size,
    windowDays,
    activeDayRatePct: round1((dayKeys.size / windowDays) * 100),
    currentStreakDays: currentStreak,
    longestStreakDays: longestStreak,
    longestGapDays: longestGap,
    lastActiveAt,
  };
}

// ---------------------------------------------------------------------------
// Time-of-day profile — when does this student actually learn well?
// ---------------------------------------------------------------------------

export type HourBand = {
  band: string;
  startHour: number;
  hours: number;
  progressPerHour: number;
};

const BANDS: { band: string; start: number; end: number }[] = [
  { band: 'Early (6–9)', start: 6, end: 9 },
  { band: 'Morning (9–12)', start: 9, end: 12 },
  { band: 'Afternoon (12–15)', start: 12, end: 15 },
  { band: 'Late PM (15–18)', start: 15, end: 18 },
  { band: 'Evening (18–21)', start: 18, end: 21 },
  { band: 'Night (21–6)', start: 21, end: 30 },
];

export function timeOfDayProfile(sessions: SessionRow[]): HourBand[] {
  return BANDS.map(({ band, start, end }) => {
    const inBand = sessions.filter((s) => {
      const h = s.checkInAt.getHours();
      const normalised = h < 6 ? h + 24 : h;
      return normalised >= start && normalised < end;
    });
    const h = inBand.reduce((sum, s) => sum + hours(s.durationMin), 0);
    const delta = inBand.reduce((sum, s) => sum + (s.progressDeltaPct ?? 0), 0);
    return {
      band,
      startHour: start,
      hours: round1(h),
      progressPerHour: h > 0 ? round2(delta / h) : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Course-level time allocation
// ---------------------------------------------------------------------------

export type CourseTimeAllocation = {
  courseCode: string;
  courseName: string;
  loggedHours: number;
  requiredHours: number;
  coveragePct: number;
  progressPerHour: number;
  shareOfTimePct: number;
};

export function courseAllocation(
  sessions: SessionRow[],
  courses: Course[],
): CourseTimeAllocation[] {
  const grandHours = sessions.reduce((sum, s) => sum + hours(s.durationMin), 0);

  return courses
    .map((course) => {
      const inCourse = sessions.filter((s) => s.courseCode === course.code);
      const logged = inCourse.reduce((sum, s) => sum + hours(s.durationMin), 0);
      const delta = inCourse.reduce((sum, s) => sum + (s.progressDeltaPct ?? 0), 0);
      const required = course.selfLearningHoursRequired || course.teachingHours || 1;
      return {
        courseCode: course.code,
        courseName: course.name,
        loggedHours: round1(logged),
        requiredHours: required,
        coveragePct: round1(clamp((logged / required) * 100)),
        progressPerHour: logged > 0 ? round2(delta / logged) : 0,
        shareOfTimePct: grandHours > 0 ? round1((logged / grandHours) * 100) : 0,
      };
    })
    .sort((a, b) => b.loggedHours - a.loggedHours);
}

// ---------------------------------------------------------------------------
// Forecast — will they finish?
// ---------------------------------------------------------------------------

export type Forecast = {
  /// Progress points per week, from the trailing window.
  velocityPctPerWeek: number;
  requiredPctPerWeek: number;
  weeksRemaining: number;
  projectedCompletionPct: number;
  projectedFinishDate: Date | null;
  willFinishOnTime: boolean;
  /// Extra hours per week needed to land on time. 0 when already on track.
  extraHoursPerWeekNeeded: number;
};

export function forecastCompletion(opts: {
  sessions: SessionRow[];
  currentPct: number;
  deadline: Date;
  now?: Date;
  trailingWeeks?: number;
}): Forecast {
  const { sessions, currentPct, deadline } = opts;
  const now = opts.now ?? new Date();
  const trailingWeeks = opts.trailingWeeks ?? 4;

  const windowStart = addDays(now, -7 * trailingWeeks);
  const recent = sessions.filter((s) => s.checkInAt >= windowStart);
  const gained = recent.reduce((sum, s) => sum + (s.progressDeltaPct ?? 0), 0);
  const loggedHours = recent.reduce((sum, s) => sum + hours(s.durationMin), 0);

  const velocity = gained / trailingWeeks;
  const msRemaining = deadline.getTime() - now.getTime();
  const weeksRemaining = Math.max(msRemaining / (7 * 86_400_000), 0);
  const remainingPct = Math.max(100 - currentPct, 0);
  const requiredPerWeek = weeksRemaining > 0 ? remainingPct / weeksRemaining : remainingPct;

  const projectedCompletionPct = clamp(currentPct + velocity * weeksRemaining);

  let projectedFinishDate: Date | null = null;
  if (velocity > 0.01 && remainingPct > 0) {
    const weeksNeeded = remainingPct / velocity;
    projectedFinishDate = addDays(now, Math.ceil(weeksNeeded * 7));
  } else if (remainingPct <= 0) {
    projectedFinishDate = now;
  }

  // Convert the shortfall in progress-points into hours using this student's
  // own observed yield, so the ask is personalised rather than a flat number.
  const yieldPerHour = loggedHours > 0 ? gained / loggedHours : 0;
  const shortfallPerWeek = Math.max(requiredPerWeek - velocity, 0);
  const extraHoursPerWeekNeeded =
    yieldPerHour > 0.05 ? round1(shortfallPerWeek / yieldPerHour) : 0;

  return {
    velocityPctPerWeek: round2(velocity),
    requiredPctPerWeek: round2(requiredPerWeek),
    weeksRemaining: round1(weeksRemaining),
    projectedCompletionPct: round1(projectedCompletionPct),
    projectedFinishDate,
    willFinishOnTime: projectedCompletionPct >= 99.5,
    extraHoursPerWeekNeeded,
  };
}

// ---------------------------------------------------------------------------
// Actual-vs-expected curve (mentor Student Detail chart)
// ---------------------------------------------------------------------------

export type CurvePoint = { label: string; date: Date; expected: number; actual: number | null };

/**
 * Rebuilds the student's completion history week by week from their session
 * progress snapshots, so the "solid vs dashed" chart is real data rather than a
 * straight line drawn between two points.
 */
export function paceCurve(opts: {
  sessions: SessionRow[];
  startedAt: Date;
  deadline: Date;
  currentPct: number;
  now?: Date;
}): CurvePoint[] {
  const now = opts.now ?? new Date();
  const { sessions, startedAt, deadline, currentPct } = opts;

  const totalMs = deadline.getTime() - startedAt.getTime();
  const weeks = Math.max(Math.ceil(totalMs / (7 * 86_400_000)), 1);

  const ordered = [...sessions].sort(
    (a, b) => a.checkInAt.getTime() - b.checkInAt.getTime(),
  );

  const points: CurvePoint[] = [];
  for (let w = 0; w <= weeks; w++) {
    const date = addDays(startedAt, w * 7);
    const expected = clamp((w / weeks) * 100);

    let actual: number | null = null;
    if (date <= now) {
      const upTo = ordered.filter((s) => s.checkInAt <= date);
      const cumulative = upTo.reduce((sum, s) => sum + (s.progressDeltaPct ?? 0), 0);
      actual = clamp(cumulative);
    }
    points.push({ label: `W${w}`, date, expected: round1(expected), actual });
  }

  // Anchor the final observed point to the authoritative current percentage so
  // the chart cannot drift away from the number shown in the header.
  const lastObserved = [...points].reverse().find((p) => p.actual != null);
  if (lastObserved) lastObserved.actual = round1(currentPct);

  return points;
}

// ---------------------------------------------------------------------------
// Cohort-level aggregation (director analytics)
// ---------------------------------------------------------------------------

export type CourseBottleneck = {
  courseCode: string;
  courseName: string;
  stage: Stage;
  completionPct: number;
  enrolledCount: number;
  atRiskCount: number;
};

export function rankBottlenecks(rows: CourseBottleneck[], limit = 6): CourseBottleneck[] {
  return [...rows].sort((a, b) => a.completionPct - b.completionPct).slice(0, limit);
}

export type TrendPoint = { label: string; weekStart: Date; value: number };

export function atRiskTrend(
  alerts: { triggeredAt: Date; resolvedAt: Date | null; studentId: string }[],
  weeks = 6,
  now = new Date(),
): TrendPoint[] {
  const currentWeek = startOfWeek(now);
  return Array.from({ length: weeks }, (_, i) => {
    const weekStart = addDays(currentWeek, -7 * (weeks - 1 - i));
    const weekEnd = addDays(weekStart, 7);
    // A student counts for a week if an alert was open at any point in it.
    const open = new Set(
      alerts
        .filter(
          (a) =>
            a.triggeredAt < weekEnd && (a.resolvedAt == null || a.resolvedAt >= weekStart),
        )
        .map((a) => a.studentId),
    );
    return { label: `W${i + 1}`, weekStart, value: open.size };
  });
}

// ---------------------------------------------------------------------------

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
