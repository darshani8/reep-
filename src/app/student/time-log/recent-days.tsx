'use client';

import Link from 'next/link';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import { useReepSeriesColors } from '@/components/reep-charts';
import { MINUTES_IN_DAY } from '@/lib/timesheet/rules';

/**
 * The fortnight, one bar per day.
 *
 * A table of five numbers a day is fourteen rows of arithmetic nobody performs.
 * The same fortnight as stacked bars is read in a second: how much of each day
 * was slept, how much was study, and — the thing the sheet is actually for —
 * how much of it the student could not account for at all, which shows as the
 * empty tail of the bar rather than as an absence.
 *
 * It is a client component only because the segment colours come from the same
 * hook the charts use, so a bucket is the same hue here, in the 24-hour bar on
 * the editor, and in the ranked chart beside it. Every string it renders was
 * formatted on the server; no Date crosses the boundary.
 *
 * Each row is a link to that day, because the commonest reason to look at this
 * strip is to notice a day that is wrong and fix it.
 */

export type RecentDayRow = {
  key: string;
  /// "Tue 11 Aug", formatted on the server.
  label: string;
  /// Minutes per bucket, in `DAY_ACTIVITIES` order — the same order the colours
  /// are indexed by, which is what keeps the two in step without passing a map.
  minutes: number[];
  totalMinutes: number;
  totalWords: string;
  /// Null once the day adds up to 24 hours.
  unaccountedWords: string | null;
  href: string;
};

export function RecentDaysStrip({
  days,
  labels,
}: {
  days: RecentDayRow[];
  /// Bucket names, same order as `minutes`. Passed rather than imported so this
  /// component has no opinion about how many buckets there are.
  labels: string[];
}) {
  const colors = useReepSeriesColors();

  return (
    <Stack spacing={0.25}>
      {days.map((day) => {
        // A day that has been over-filled is scaled to itself so no segment is
        // clipped; a normal day is scaled to 24 hours so the empty tail means
        // "unaccounted for" rather than "shorter day".
        const basis = Math.max(day.totalMinutes, MINUTES_IN_DAY);

        return (
          <Stack
            key={day.key}
            component={Link}
            href={day.href}
            direction="row"
            spacing={1.5}
            sx={{
              alignItems: 'center',
              py: 0.75,
              px: 1,
              mx: -1,
              borderRadius: 1,
              textDecoration: 'none',
              color: 'inherit',
              '&:hover': { bgcolor: 'action.hover' },
              '&:focus-visible': { outline: '2px solid', outlineColor: 'secondary.main' },
            }}
            aria-label={`${day.label}: ${day.totalWords} logged${
              day.unaccountedWords ? `, ${day.unaccountedWords} unaccounted for` : ''
            }. Open this day.`}
          >
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ width: 84, flexShrink: 0 }}
            >
              {day.label}
            </Typography>

            <Stack
              direction="row"
              aria-hidden
              sx={{
                flex: 1,
                height: 12,
                borderRadius: 0.75,
                overflow: 'hidden',
                bgcolor: 'action.hover',
              }}
            >
              {day.minutes.map((minutes, index) => (
                <Tooltip key={labels[index]} title={`${labels[index]} · ${minutes} min`}>
                  <Box
                    sx={{
                      width: `${(minutes / basis) * 100}%`,
                      bgcolor: colors[index % colors.length],
                    }}
                  />
                </Tooltip>
              ))}
            </Stack>

            <Typography
              variant="caption"
              className="tabular"
              color={day.unaccountedWords ? 'text.disabled' : 'text.secondary'}
              sx={{ width: 62, textAlign: 'right', flexShrink: 0 }}
            >
              {day.totalWords}
            </Typography>
          </Stack>
        );
      })}
    </Stack>
  );
}
