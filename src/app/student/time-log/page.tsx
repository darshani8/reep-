import { notFound } from 'next/navigation';

import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import ChevronLeftRounded from '@mui/icons-material/ChevronLeftRounded';
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded';

import { EmptyState, PageIntro, SectionCard, TechNote } from '@/components/kit';
import { RankedBarChart } from '@/components/reep-charts';
import { requireStudent } from '@/lib/auth';
import { getTimeSheetScreen } from '@/lib/timesheet/queries';
import { DAY_ACTIVITIES, MINUTES_IN_DAY, durationWords } from '@/lib/timesheet/rules';

import { DaySheetEditor } from './day-sheet';
import { RecentDaysStrip } from './recent-days';

/**
 * The day sheet — the default view of the time log.
 *
 * **The acceptance bar, written here so it cannot be rationalised away later:**
 * one screen, five steppers in 30-minute increments, a live "X h remaining of
 * 24", one tap to copy yesterday, and a whole day saveable in under 30 seconds
 * without scrolling on a 1366×768 laptop. Anything added to this page is
 * measured against that sentence; if it costs a scroll on that laptop, it
 * belongs below the sheet or on the sessions view, not above it.
 *
 * Why five buckets at all, when `/student/time-log/sessions` already records
 * study time in fifteen activity types against courses: because that record only
 * describes the hours a student was studying, and the question the programme
 * actually asks — where does the day go? — is mostly about the other sixteen
 * hours. A student who is not progressing is rarely one who does not know what
 * `ActivityType` to pick; they are one who cannot see that eleven hours a day
 * are going somewhere they would not choose. Five buckets is the coarsest split
 * that can show that, and coarse is what makes it get filled in.
 *
 * The two views are linked in both directions and share nothing but the URL
 * prefix. The sessions view still drives pace, focus quality and the
 * LOW_FOCUS_QUALITY alert; this one writes `TimeSheetEntry` and drives none of
 * them.
 *
 * Both halves render for a brand-new student: an unfilled day is five zeroes
 * rather than an absence, and the strip below has an empty state rather than a
 * gap.
 */

export const metadata = { title: 'Time Sheet — Student' };
export const dynamic = 'force-dynamic';

export default async function StudentTimeSheetPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string }>;
}) {
  const { studentId } = await requireStudent();
  const { day } = await searchParams;

  // A malformed or out-of-range `?day=` is corrected to a day that exists rather
  // than refused — see `getTimeSheetScreen`. `notFound()` here means the student
  // record itself is gone.
  const screen = await getTimeSheetScreen(studentId, day);
  if (!screen) notFound();

  const dayHref = (key: string) => `/student/time-log?day=${key}`;

  const filledDays = screen.recent.length + (screen.alreadySaved ? 1 : 0);
  const strip = screen.recent;

  return (
    <>
      <PageIntro
        title="Time Sheet"
        subtitle={`${screen.firstName}, five numbers and your day is on the record. Nothing here needs a course code or a clock time.`}
        action={
          <Button href="/student/time-log/sessions" variant="outlined" endIcon={<ChevronRightRounded />}>
            Study sessions
          </Button>
        }
        // Tighter than the default so the five rows, the counter and the save
        // button all clear the fold on a 1366×768 laptop. See the docstring.
        sx={{ mb: 3 }}
      />

      <SectionCard
        title={`${screen.dayLabel} · ${screen.dayRelative.toLowerCase()}`}
        subtitle="Half-hour steps. It does not have to add up to 24 to be worth saving."
        action={
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }} className="no-print">
            <Button
              size="small"
              startIcon={<ChevronLeftRounded />}
              href={screen.previousKey ? dayHref(screen.previousKey) : undefined}
              disabled={!screen.previousKey}
            >
              Earlier
            </Button>
            <Button
              size="small"
              endIcon={<ChevronRightRounded />}
              href={screen.nextKey ? dayHref(screen.nextKey) : undefined}
              disabled={!screen.nextKey}
            >
              Later
            </Button>
            {screen.dayKey !== screen.todayKey && (
              <Button size="small" href={dayHref(screen.todayKey)}>
                Today
              </Button>
            )}
          </Stack>
        }
        sx={{ mb: 4 }}
      >
        {/*
          Keyed by the day so moving to another date remounts the editor. Without
          it React would keep the previous day's edits in state and lay them over
          a different date's saved values — the one bug on this screen that would
          write a lie to the record rather than merely look wrong.
        */}
        <DaySheetEditor
          key={screen.dayKey}
          dayKey={screen.dayKey}
          dayLabel={screen.dayLabel}
          dayRelative={screen.dayRelative}
          initial={screen.sheet}
          copyFrom={screen.copyFrom}
        />
      </SectionCard>

      {/* Everything below here is the reward for filling it in, and is
          deliberately below the fold. */}
      <Grid container spacing={4}>
        <Grid size={{ xs: 12, md: 7 }}>
          <SectionCard
            title="The days before this one"
            subtitle={
              strip.length > 0
                ? `${strip.length} of your last 14 days are on the record`
                : 'Nothing recorded yet'
            }
          >
            {strip.length > 0 ? (
              <RecentDaysStrip
                days={strip.map((entry) => ({
                  key: entry.key,
                  label: entry.label,
                  totalMinutes: entry.totalMinutes,
                  minutes: DAY_ACTIVITIES.map((def) => entry.sheet[def.activity]),
                  href: dayHref(entry.key),
                  totalWords: durationWords(entry.totalMinutes),
                  unaccountedWords:
                    entry.totalMinutes < MINUTES_IN_DAY
                      ? durationWords(MINUTES_IN_DAY - entry.totalMinutes)
                      : null,
                }))}
                labels={DAY_ACTIVITIES.map((def) => def.label)}
              />
            ) : (
              <EmptyState
                title="No earlier days on the sheet."
                hint="Fill in today above and this fills itself in — a fortnight of days, each one clickable if you need to correct it."
              />
            )}
          </SectionCard>
        </Grid>

        <Grid size={{ xs: 12, md: 5 }}>
          <SectionCard
            title="Where the time went"
            subtitle={`Across the ${filledDays === 1 ? 'one day' : `${filledDays} days`} on this screen`}
          >
            {screen.bucketHours.length > 0 ? (
              <RankedBarChart data={screen.bucketHours} unit=" h" />
            ) : (
              <EmptyState
                title="Nothing to total up yet."
                hint="This appears as soon as one day is saved."
              />
            )}
          </SectionCard>
        </Grid>
      </Grid>

      <TechNote>
        This sheet writes <code>TimeSheetEntry</code> through <code>/api/timesheet</code>, which is
        its own route rather than an extension of <code>/api/activity/bulk</code>. The two are
        deliberately separate records: the bulk endpoint writes <code>LabSession</code> rows
        against the fifteen-value <code>ActivityType</code>, and those rows are what pace, focus
        quality, the <code>LOW_FOCUS_QUALITY</code> alert and the exports are computed from.
        Nothing on this page moves any of those numbers, and nothing here is a study claim — four
        of the five buckets are not study at all. Re-saving a day <em>replaces</em> that day&rsquo;s
        rows in one transaction rather than adding to them, because a sheet is a statement about a
        whole day and a second submission is a correction of the first; that is also why a cleared
        sheet is a legitimate save. A total over 24 hours is refused, a total under it is only
        remarked on — a validator that refused an unbalanced day would teach students to pad it,
        and padded numbers are worse than missing ones. A bucket at zero is stored as no row
        rather than as a row of zero. The day is a <code>@db.Date</code>, so every date on this
        screen travels as a <code>YYYY-MM-DD</code> key and is compared as a string; a local-time
        formatter over that column moves the whole sheet a day for anyone west of Greenwich, and
        only for them. Your course-linked session log has moved to{' '}
        <code>/student/time-log/sessions</code> unchanged.
      </TechNote>
    </>
  );
}
