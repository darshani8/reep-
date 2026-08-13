'use client';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { BarChart } from '@mui/x-charts/BarChart';

import { ChartFrame, useReepSeriesColors } from '@/components/reep-charts';

/**
 * Mocks taken: group discussion, interview, aptitude test.
 *
 * The failure mode here is arithmetic, not design. Hand a bar chart a list of
 * attempts and it draws whatever types are in the list — so a student who has
 * never sat an aptitude paper gets a two-bar chart, and the missing third is
 * indistinguishable from a rehearsal the placement cell does not run. The one
 * number a student needs from this tile is precisely the zero.
 *
 * So all three are *series* rather than categories: each carries its own label,
 * its own colour and its own legend entry, and a legend entry exists whether or
 * not there is a bar under it. `mockTile` builds the fixed triple; this file
 * renders it without filtering. Every bar is labelled with its count, including
 * `0`, so the value is readable without measuring a bar of no height.
 *
 * Scores are deliberately not on this chart. A GD is often run as a debrief
 * with no mark, aptitude papers are out of 100 and interviews out of 10, and
 * plotting attempts against normalised percentages on one axis would put "three
 * attempts" and "seventy per cent" on the same scale. The scores are printed
 * underneath instead, each against its own denominator.
 */

export type MockChartRow = {
  type: 'GD' | 'INTERVIEW' | 'APTITUDE';
  label: string;
  attempts: number;
  bestPct: number | null;
  lastTakenOn: Date | null;
};

export function MocksChart({ data, height = 230 }: { data: MockChartRow[]; height?: number }) {
  const colors = useReepSeriesColors();
  const tone: Record<MockChartRow['type'], string> = {
    GD: colors[1],
    INTERVIEW: colors[2],
    APTITUDE: colors[3],
  };

  return (
    <ChartFrame
      height={height}
      caption="Rehearsals sat in each format. All three are shown whether or not you have sat one — a zero here is the thing to act on."
    >
      <BarChart
        // A single band category, with the three formats as series rather than
        // as ticks. That is what guarantees a legend entry for a format with no
        // attempts: a category with no data simply would not be drawn.
        xAxis={[{ scaleType: 'band', data: ['Rehearsals sat'] }]}
        // With no attempts at all the domain would be 0–0, which is not an
        // axis. A fixed small ceiling keeps the empty tile drawn as a real
        // chart with three labelled zeroes rather than as a blank rectangle.
        yAxis={[{ label: 'attempts', width: 46, min: 0, max: ceiling(data), tickMinStep: 1 }]}
        series={data.map((row) => ({
          id: row.type,
          data: [row.attempts],
          label: row.label,
          color: tone[row.type],
          valueFormatter: (v: number | null) =>
            Number(v ?? 0) === 1 ? '1 attempt' : `${Number(v ?? 0)} attempts`,
          // Printed on every bar including the zeroes, so the count never has
          // to be read off a bar's height.
          barLabel: (item: { value: number | null }) => String(Number(item.value ?? 0)),
        }))}
        borderRadius={3}
        grid={{ horizontal: true }}
        margin={{ top: 16, right: 12, bottom: 4, left: 4 }}
        sx={{
          '& .MuiChartsBarLabel-root': {
            fill: 'var(--mui-palette-text-secondary)',
            fontSize: 11,
            fontWeight: 600,
          },
        }}
      />
    </ChartFrame>
  );
}

function ceiling(data: MockChartRow[]): number | undefined {
  const top = Math.max(0, ...data.map((row) => row.attempts));
  return top === 0 ? 3 : undefined;
}

/// The numbers the chart deliberately leaves off: best score against its own
/// denominator, and when the last one was sat.
export function MocksKey({ data }: { data: MockChartRow[] }) {
  const colors = useReepSeriesColors();
  const tone: Record<MockChartRow['type'], string> = {
    GD: colors[1],
    INTERVIEW: colors[2],
    APTITUDE: colors[3],
  };

  return (
    <Stack spacing={1.25} sx={{ mt: 2 }}>
      {data.map((row) => (
        <Stack key={row.type} direction="row" spacing={1.5} sx={{ alignItems: 'baseline' }}>
          <Box
            sx={{
              width: 9,
              height: 9,
              borderRadius: '2px',
              bgcolor: tone[row.type],
              flexShrink: 0,
              transform: 'translateY(1px)',
            }}
          />
          <Typography variant="body2" color="text.secondary" sx={{ flex: 1, minWidth: 0 }}>
            {row.label}
          </Typography>
          <Typography
            variant="caption"
            className="tabular"
            color={row.attempts > 0 ? 'text.secondary' : 'text.disabled'}
            sx={{ textAlign: 'right', flexShrink: 0 }}
          >
            {describe(row)}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}

function describe(row: MockChartRow): string {
  if (row.attempts === 0) return 'not sat yet';

  const parts: string[] = [row.attempts === 1 ? '1 sat' : `${row.attempts} sat`];
  // A GD run as a debrief has no mark, and printing "0%" for it would report a
  // failure that never happened.
  parts.push(row.bestPct == null ? 'no score given' : `best ${row.bestPct}%`);
  if (row.lastTakenOn) {
    parts.push(
      row.lastTakenOn.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
    );
  }
  return parts.join(' · ');
}
