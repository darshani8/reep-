import { notFound } from 'next/navigation';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ChevronLeftRounded from '@mui/icons-material/ChevronLeftRounded';
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded';

import {
  EmptyState,
  Fact,
  PageIntro,
  ProgressMeter,
  SectionCard,
  TechNote,
  type Tone,
} from '@/components/kit';
import { HoursVsTargetChart, RankedBarChart, StackedModeChart } from '@/components/reep-charts';
import { earliestLoggableDay, isBackdated, isoDay, loggedAfterDays } from '@/lib/activity-rules';
import { requireStudent } from '@/lib/auth';
import { getStudentTimeLog } from '@/lib/queries';
import {
  ACTIVITY_LABEL,
  ACTIVITY_ORDER,
  addDays,
  formatDuration,
  formatHours,
} from '@/lib/reep';
import type { ActivityType, LearningMode } from '@prisma/client';

import {
  ActivityEntryGrid,
  type EntryActivityOption,
  type EntryCourseOption,
  type EntryDay,
} from './activity-entry-grid';
import { ActivitySessionGrid, type ActivitySessionRow } from './activity-session-grid';
import { ModeLegend } from './mode-legend';

/**
 * The course-linked session log.
 *
 * This screen was `/student/time-log` until the five-bucket day sheet took that
 * URL as the default view. **Nothing about what it records has changed** — it is
 * the same `LabSession` rows against the same fifteen-value `ActivityType`, and
 * it is still what pace, focus quality and the LOW_FOCUS_QUALITY alert are
 * computed from. The grids below were moved, not rewritten.
 *
 * The two views answer different questions and are kept apart for that reason.
 * The day sheet asks "where did your 24 hours go?" in five buckets a student can
 * fill before bed. This one asks "what did you study, on which course, for how
 * long?" — the record a mentor reads and the programme reports on. Folding them
 * together would mean either asking for course codes against sleep or letting
 * self-reported leisure into the pace calculation.
 */

export const metadata = { title: 'Study sessions — Student' };
export const dynamic = 'force-dynamic';

/// How many days the entry grid lays out. A month is the unit a student
/// actually falls behind by, and it is short enough that every row still fits
/// one screen of scrolling.
const ENTRY_WINDOW_DAYS = 30;

/// Short, friendly names for the learning modes. The formal wording in
/// MODE_LABEL is too long to sit next to a number.
const MODE_TEXT: Record<LearningMode, string> = {
  INSTRUCTOR_LED: 'Instructor-led',
  SUPERVISED_LAB: 'Supervised lab',
  INDEPENDENT: 'Independent',
};

/// Keyed by the band's start hour rather than its label, so the en-dash in
/// analytics.ts can never silently break the lookup.
const BAND_WORDS: Record<number, string> = {
  6: 'early mornings, before 9am',
  9: 'late mornings, between 9am and noon',
  12: 'early afternoons, between noon and 3pm',
  15: 'late afternoons, between 3pm and 6pm',
  18: 'evenings, between 6pm and 9pm',
  21: 'late nights, after 9pm',
};

const BAND_SHORT: Record<number, string> = {
  6: '6–9 am',
  9: '9 am–12',
  12: '12–3 pm',
  15: '3–6 pm',
  18: '6–9 pm',
  21: 'After 9 pm',
};

export default async function StudentTimeLogPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const { studentId } = await requireStudent();
  const { week } = await searchParams;

  // Only the past is navigable, and never further back than a year.
  const requested = Number.parseInt(week ?? '0', 10);
  const weekOffset = Number.isFinite(requested) ? Math.min(0, Math.max(-51, requested)) : 0;

  const data = await getStudentTimeLog(studentId, weekOffset);
  if (!data) notFound();

  const {
    student,
    weekStart,
    courses,
    recentSessions,
    daily,
    modes,
    weekly,
    focus,
    consistency,
    timeOfDay,
    forecast,
    weekTotalHours,
  } = data;

  const firstName = student.user.name.split(' ')[0];
  const weeklyTarget = student.weeklyHourTarget;

  const courseOptions: EntryCourseOption[] = courses.map((course) => ({
    code: course.code,
    name: course.name,
  }));

  // --- log-an-activity panel ----------------------------------------------
  // Both bounds are computed here so the form's first paint agrees with the
  // server about what "today" is, and the floor comes from the same function
  // /api/activity validates against, so the picker cannot offer a day the
  // server will then refuse.
  const today = new Date();
  const earliestDay = earliestLoggableDay(student);
  const activityOptions: EntryActivityOption[] = ACTIVITY_ORDER.map((activity) => ({
    value: activity,
    label: ACTIVITY_LABEL[activity],
  }));

  /**
   * The month the entry grid lays out: one row per day, newest first.
   *
   * Built here rather than in the client so the row set cannot disagree with
   * the server about what "today" is, and so it stops at the same floor
   * `/api/activity` validates against — the grid never offers a day the save
   * would refuse.
   *
   * Each day carries what is already on the record for it, from any source:
   * earlier self-reported entries, a lab check-in, a row a mentor added. That
   * is the difference between a blank month and a useful one — the student can
   * see which days are accounted for instead of guessing and double-entering.
   */
  const loggedByDay = new Map<string, number>();
  for (const session of student.labSessions) {
    const key = isoDay(session.checkInAt);
    loggedByDay.set(key, (loggedByDay.get(key) ?? 0) + (session.durationMin ?? 0));
  }

  const entryDays: EntryDay[] = [];
  for (let back = 0; back < ENTRY_WINDOW_DAYS; back += 1) {
    const day = addDays(today, -back);
    if (day < earliestDay) break;
    const iso = isoDay(day);
    entryDays.push({
      iso,
      label: dayLabel(day),
      weekend: day.getDay() === 0 || day.getDay() === 6,
      alreadyMin: loggedByDay.get(iso) ?? 0,
    });
  }

  // --- this week ----------------------------------------------------------
  const weekEnd = addDays(weekStart, 5); // the programme week runs Mon–Sat
  const rangeLabel = `${shortDate(weekStart)} – ${shortDate(weekEnd)}`;
  const weekName =
    weekOffset === 0
      ? 'This week'
      : weekOffset === -1
        ? 'Last week'
        : `${Math.abs(weekOffset)} weeks ago`;

  const dailyRows = daily.map((day) => ({
    label: day.label,
    hours: day.hours,
    targetHours: day.targetHours,
  }));

  const legendItems = modes.map((entry) => ({
    label: MODE_TEXT[entry.mode],
    value: formatHours(entry.hours),
  }));

  const targetPct = weeklyTarget > 0 ? (weekTotalHours / weeklyTarget) * 100 : 0;
  const gapHours = weeklyTarget - weekTotalHours;

  // --- this week, by activity ---------------------------------------------
  // Grouped here rather than in the query layer: it is the only screen that
  // needs it, and the week's sessions are already loaded.
  const weekEndExclusive = addDays(weekStart, 7);
  const minutesByActivity = new Map<ActivityType, number>();
  for (const session of student.labSessions) {
    if (session.checkInAt < weekStart || session.checkInAt >= weekEndExclusive) continue;
    minutesByActivity.set(
      session.activity,
      (minutesByActivity.get(session.activity) ?? 0) + (session.durationMin ?? 0),
    );
  }

  const activityHours = [...minutesByActivity.entries()]
    .map(([activity, minutes]) => ({ label: ACTIVITY_LABEL[activity], value: round1(minutes / 60) }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 6); // a ranked chart stops being readable much past this

  // --- session table ------------------------------------------------------
  const sessionRows: ActivitySessionRow[] = recentSessions.map((session) => ({
    id: session.id,
    date: isoDay(session.checkInAt),
    dateLabel: dayLabel(session.checkInAt),
    // "Something else" only means anything in the student's own words.
    activityLabel:
      session.activity === 'OTHER' && session.activityNote
        ? session.activityNote
        : ACTIVITY_LABEL[session.activity],
    selfReported: session.source === 'SELF_REPORTED',
    enteredForYou: session.source === 'MANUAL' && session.mentorConfirmed,
    // Written well after the studying happened. Shown to the student too, not
    // only to the mentor: the mark is on their record, so it should not be
    // something they can only find out about from someone else.
    backdated: isBackdated(session),
    backdatedLabel: `Entered ${plural(loggedAfterDays(session), 'day')} later`,
    courseCode: session.courseCode,
    courseName: courses.find((course) => course.code === session.courseCode)?.name ?? '',
    module: session.module,
    checkIn: timeLabel(session.checkInAt),
    checkOut: session.checkOutAt ? timeLabel(session.checkOutAt) : '—',
    durationMin: session.durationMin,
    progressPct: session.progressAtCheckOut,
    deltaPct: session.progressDeltaPct,
  }));

  // --- insights -----------------------------------------------------------
  const focusTone: Tone =
    focus.focusScore >= 70 ? 'good' : focus.focusScore >= 45 ? 'warning' : 'critical';

  const activeBands = timeOfDay
    .filter((band) => band.hours > 0)
    .sort((a, b) => b.progressPerHour - a.progressPerHour);
  const bestBand = activeBands[0] ?? null;
  const showBandChart = Boolean(bestBand && bestBand.progressPerHour > 0);

  const deadlineLabel = longDate(student.cohort.endDate);
  const hasVelocity = forecast.velocityPctPerWeek > 0.01;

  // --- eight-week trend ---------------------------------------------------
  const trend = weekly.map((point) => {
    const end = addDays(point.weekStart, 7);
    const inWeek = student.labSessions.filter(
      (session) => session.checkInAt >= point.weekStart && session.checkInAt < end,
    );
    const modeHours = (mode: LearningMode) =>
      round1(
        inWeek
          .filter((session) => session.mode === mode)
          .reduce((sum, session) => sum + (session.durationMin ?? 0), 0) / 60,
      );

    return {
      label: shortDate(point.weekStart),
      INSTRUCTOR_LED: modeHours('INSTRUCTOR_LED'),
      SUPERVISED_LAB: modeHours('SUPERVISED_LAB'),
      INDEPENDENT: modeHours('INDEPENDENT'),
    };
  });

  const trendTotal = weekly.reduce((sum, point) => sum + point.hours, 0);
  const trendAverage = weekly.length > 0 ? trendTotal / weekly.length : 0;

  return (
    <>
      <PageIntro
        title="Study sessions"
        subtitle={`${firstName}, this is where your study hours are recorded against a course — and what they added up to. For where the rest of the day went, fill in the day sheet.`}
        action={
          <Button
            href="/student/time-log"
            variant="outlined"
            startIcon={<ChevronLeftRounded />}
          >
            Day sheet
          </Button>
        }
      />

      {/* 1 — the one thing this page asks you to do ----------------------- */}
      {/* The live check-in/check-out panel used to sit above this. It was the
          only way to record time as it happened; the grid records the day it
          happened on, which is the same information without asking a student to
          remember to come back and stop a timer. Lab-PC and badge check-ins
          still arrive through /api/checkin and still appear below — the panel
          was the manual version of a thing the lab does by itself. */}
      <ActivityEntryGrid
        activities={activityOptions}
        courses={courseOptions}
        days={entryDays}
        todayISO={isoDay(today)}
        earliestISO={isoDay(earliestDay)}
        earliestLabel={longDate(entryDays[entryDays.length - 1]
          ? addDays(today, -(entryDays.length - 1))
          : earliestDay)}
      />

      {/* 2 — this week ---------------------------------------------------- */}
      <SectionCard
        title={weekName}
        subtitle={`${rangeLabel} · target ${formatHours(weeklyTarget)} a week`}
        action={
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }} className="no-print">
            <Button
              size="small"
              href={`/student/time-log/sessions?week=${weekOffset - 1}`}
              startIcon={<ChevronLeftRounded />}
            >
              Earlier
            </Button>
            {weekOffset < 0 && (
              <Button
                size="small"
                href={`/student/time-log/sessions?week=${weekOffset + 1}`}
                endIcon={<ChevronRightRounded />}
              >
                Later
              </Button>
            )}
          </Stack>
        }
      >
        <Typography variant="body1" sx={{ mb: 2.5, maxWidth: 720 }}>
          {weekTotalHours <= 0
            ? `No study time recorded ${weekOffset === 0 ? 'yet this week' : 'in this week'}. The target is ${formatHours(weeklyTarget)}.`
            : `You logged ${formatHours(weekTotalHours)} of a ${formatHours(weeklyTarget)} target — ${
                gapHours > 0.05
                  ? `${formatHours(gapHours)} short.`
                  : `${formatHours(Math.abs(gapHours))} past it.`
              }`}
        </Typography>

        <Grid container spacing={3}>
          <Grid size={{ xs: 12, md: 8 }}>
            <HoursVsTargetChart data={dailyRows} />
          </Grid>

          <Grid size={{ xs: 12, md: 4 }}>
            <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5 }}>
              How the week was spent
            </Typography>
            <ModeLegend items={legendItems} />

            <Box sx={{ mt: 3 }}>
              <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                Against target
              </Typography>
              <ProgressMeter
                value={targetPct}
                tone={targetPct >= 100 ? 'good' : targetPct >= 60 ? 'warning' : 'critical'}
                label="Hours logged against the weekly target"
              />
              <Typography
                variant="caption"
                color="text.secondary"
                className="tabular"
                sx={{ mt: 1, display: 'block' }}
              >
                {formatHours(weekTotalHours)} of {formatHours(weeklyTarget)} ·{' '}
                {targetPct.toFixed(0)}%
              </Typography>
            </Box>
          </Grid>
        </Grid>
      </SectionCard>

      {/* 3 — what the week was spent doing -------------------------------- */}
      {activityHours.length > 0 ? (
        <Box sx={{ mt: 2.5 }}>
          <SectionCard
            title="This week by activity"
            subtitle={`Hours by what you were actually doing · ${rangeLabel}`}
          >
            <Box sx={{ maxWidth: 620 }}>
              <RankedBarChart data={activityHours} unit=" h" />
            </Box>
          </SectionCard>
        </Box>
      ) : null}

      {/* 4 — every session ------------------------------------------------ */}
      <Box sx={{ mt: 2.5 }}>
        <SectionCard
          title="Your sessions"
          subtitle={
            sessionRows.length > 0
              ? `The last ${sessionRows.length} sessions, newest first`
              : 'Nothing recorded yet'
          }
        >
          <ActivitySessionGrid rows={sessionRows} />
        </SectionCard>
      </Box>

      {/* 5 — what the time actually produced ------------------------------ */}
      <Typography variant="h3" component="h2" sx={{ mt: 4, mb: 2 }}>
        What your time is producing
      </Typography>

      <Grid container spacing={2.5}>
        {/* Focus ----------------------------------------------------------- */}
        <Grid size={{ xs: 12, md: 6 }}>
          <SectionCard
            title="Focus score"
            subtitle="How much progress each logged hour turns into"
          >
            {focus.totalSessions === 0 ? (
              <EmptyState
                title="No finished sessions yet."
                hint="This fills in on its own once a lab session has been checked out, or once a logged day carries measured progress."
              />
            ) : (
              <>
                <Typography variant="body1" sx={{ maxWidth: 620 }}>
                  Your focus score is {focus.focusScore} out of 100. You gain{' '}
                  {focus.progressPerHour.toFixed(1)} progress points for every hour you log.
                </Typography>

                <ProgressMeter
                  value={focus.focusScore}
                  tone={focusTone}
                  sx={{ mt: 2 }}
                  label="Focus score"
                />

                <Grid container spacing={2} sx={{ mt: 2 }}>
                  <Grid size={{ xs: 6, sm: 4 }}>
                    <Fact
                      label="Typical session"
                      value={formatDuration(focus.medianSessionMin)}
                    />
                  </Grid>
                  <Grid size={{ xs: 6, sm: 4 }}>
                    <Fact
                      label="Left inside 20 min"
                      value={`${focus.abandonedRatePct.toFixed(0)}%`}
                      tone={focus.abandonedRatePct >= 20 ? 'warning' : 'neutral'}
                    />
                  </Grid>
                  <Grid size={{ xs: 6, sm: 4 }}>
                    <Fact label="Sessions counted" value={focus.totalSessions} />
                  </Grid>
                </Grid>
              </>
            )}
          </SectionCard>
        </Grid>

        {/* Consistency ----------------------------------------------------- */}
        <Grid size={{ xs: 12, md: 6 }}>
          <SectionCard title="Consistency" subtitle={`Your last ${consistency.windowDays} days`}>
            <Typography variant="body1" sx={{ maxWidth: 620 }}>
              {consistency.currentStreakDays > 0
                ? `You have studied on ${plural(consistency.currentStreakDays, 'day')} in a row.`
                : consistency.activeDays > 0
                  ? 'Your streak has broken — there is nothing logged in the last day or two.'
                  : `Nothing has been logged in the last ${consistency.windowDays} days.`}
            </Typography>

            <Grid container spacing={2} sx={{ mt: 2 }}>
              <Grid size={{ xs: 6, sm: 4 }}>
                <Fact
                  label="Days studied"
                  value={`${consistency.activeDays} of ${consistency.windowDays}`}
                  tone={consistency.activeDayRatePct >= 50 ? 'good' : 'warning'}
                />
              </Grid>
              <Grid size={{ xs: 6, sm: 4 }}>
                <Fact label="Best run" value={plural(consistency.longestStreakDays, 'day')} />
              </Grid>
              <Grid size={{ xs: 6, sm: 4 }}>
                <Fact
                  label="Longest gap"
                  value={plural(consistency.longestGapDays, 'day')}
                  tone={consistency.longestGapDays >= 7 ? 'critical' : 'neutral'}
                />
              </Grid>
            </Grid>

            <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
              That is {consistency.activeDayRatePct.toFixed(0)}% of days with at least one
              check-in.
            </Typography>
          </SectionCard>
        </Grid>

        {/* Time of day ----------------------------------------------------- */}
        <Grid size={{ xs: 12, md: 6 }}>
          <SectionCard
            title="Your best time of day"
            subtitle="Progress points gained per hour, by when you started"
          >
            <Typography variant="body1" sx={{ maxWidth: 620 }}>
              {bestBand && bestBand.progressPerHour > 0
                ? `You get the most out of ${BAND_WORDS[bestBand.startHour] ?? 'that slot'} — ${bestBand.progressPerHour.toFixed(1)} progress points an hour.`
                : bestBand
                  ? 'Your sessions have not produced measurable progress yet, so there is no best time to name.'
                  : 'Once you have a few sessions logged, this will tell you when you learn best.'}
            </Typography>

            {showBandChart ? (
              <Box sx={{ mt: 2 }}>
                <RankedBarChart
                  data={activeBands.map((band) => ({
                    label: BAND_SHORT[band.startHour] ?? band.band,
                    value: band.progressPerHour,
                  }))}
                  unit=" pts/h"
                />
              </Box>
            ) : null}
          </SectionCard>
        </Grid>

        {/* Forecast -------------------------------------------------------- */}
        <Grid size={{ xs: 12, md: 6 }}>
          <SectionCard
            title="Where this pace lands you"
            subtitle={`Your cohort finishes on ${deadlineLabel}`}
          >
            <Typography variant="body1" sx={{ maxWidth: 620 }}>
              {!hasVelocity
                ? 'Your last four weeks show no measured progress, so there is nothing honest to project from yet. Log the days you study and a forecast will appear here.'
                : forecast.willFinishOnTime
                  ? `At your current pace you will finish the programme before ${deadlineLabel}. Keep going.`
                  : `At your current pace you will reach ${forecast.projectedCompletionPct.toFixed(0)}% by ${deadlineLabel}.${
                      forecast.extraHoursPerWeekNeeded > 0
                        ? ` Add about ${formatHours(forecast.extraHoursPerWeekNeeded)} a week to finish on time.`
                        : ' Your hours are not converting into measured progress yet, so more hours alone may not close the gap — talk to your mentor.'
                    }`}
            </Typography>

            <Grid container spacing={2} sx={{ mt: 2 }}>
              <Grid size={{ xs: 6, sm: 4 }}>
                <Fact label="Weeks left" value={forecast.weeksRemaining.toFixed(0)} />
              </Grid>
              <Grid size={{ xs: 6, sm: 4 }}>
                <Fact
                  label="Your pace"
                  value={`${forecast.velocityPctPerWeek.toFixed(1)} pts/wk`}
                  tone={hasVelocity ? 'neutral' : 'critical'}
                />
              </Grid>
              <Grid size={{ xs: 6, sm: 4 }}>
                <Fact
                  label="Pace needed"
                  value={`${forecast.requiredPctPerWeek.toFixed(1)} pts/wk`}
                  tone={forecast.willFinishOnTime ? 'good' : 'warning'}
                />
              </Grid>
            </Grid>
          </SectionCard>
        </Grid>
      </Grid>

      {/* 6 — eight-week trend --------------------------------------------- */}
      <Box sx={{ mt: 2.5 }}>
        <SectionCard
          title="The last eight weeks"
          subtitle="Hours logged each week, split by where you studied"
        >
          <Typography variant="body1" sx={{ mb: 2, maxWidth: 720 }}>
            {trendTotal > 0
              ? `You have logged ${formatHours(trendTotal)} over the last eight weeks — an average of ${formatHours(trendAverage)} a week against a ${formatHours(weeklyTarget)} target.`
              : 'Nothing has been logged in the last eight weeks.'}
          </Typography>
          <StackedModeChart data={trend} />
        </SectionCard>
      </Box>

      <TechNote>
        Check-in and check-out now arrive only from a campus-ID badge tap at the lab door or from
        the lab-PC login shim, both posting to <code>/api/checkin</code>, which allows one open
        session at a time — a forgotten check-out would otherwise inflate every hours figure on
        this screen. The manual version of that panel used to sit at the top of this page and has
        been removed: it asked a student to remember to come back and stop a timer, and the grid
        below records the same hours against the day they happened without that. Students on
        campus are still checked in automatically. &ldquo;Log your study time&rdquo; is a
        different path: the grid posts to <code>/api/activity/bulk</code>, records days that
        have already happened rather than opening a session, and derives the learning mode from
        the activity through{' '}
        <code>ACTIVITY_MODE</code> so the mode split stays correct without asking the student a
        question they should not have to answer. Those rows never carry a progress delta, which
        is why they add to the hours on this page but not to the focus or velocity figures below.
        Any day back to the start of your cohort can be logged — the old thirty-day cut-off lost
        real hours after an off-campus week — and anything written more than two days after the
        studying is marked &ldquo;entered N days later&rdquo; in the table above rather than
        refused, so a mentor can tell a contemporaneous record from a backfilled one. A row your
        mentor entered for you is marked too, and counts as confirmed rather than self-reported.
        Rows in the grid succeed and fail <em>independently</em> — the endpoint answers{' '}
        <code>207</code> with a per-row verdict rather than one for the batch, because rejecting
        nine good entries over a tenth bad one would make the grid worse than the single form it
        replaced. Every row still goes through the same <code>recordActivity()</code>, so there
        is no bulk path that skips a rule.
        &ldquo;Platform progress&rdquo; is the
        completion percentage the course provider reports, captured once at check-in and again at
        check-out; the difference between the two is what confirms the logged time became real
        progress rather than time on a seat, and it is the number every insight on this page is
        built from.
      </TechNote>
    </>
  );
}

// --- server-side formatting -------------------------------------------------
// Cells and labels are strings by the time they reach a client component, so no
// Date object ever crosses the boundary.

function timeLabel(date: Date): string {
  return date.toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function dayLabel(date: Date): string {
  return date.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function shortDate(date: Date): string {
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function longDate(date: Date): string {
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
