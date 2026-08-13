'use client';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { BarChart } from '@mui/x-charts/BarChart';

import { ChartFrame, useReepSeriesColors } from '@/components/reep-charts';

/**
 * SWOC, with the three desks kept visibly apart.
 *
 * This is the tile that wants to collapse. The path of least resistance is a
 * box of quotations under a heading, and the moment it becomes that, the whole
 * point of the table is gone: the placement cell's "weak at structured problem
 * solving" and the mentor's "strongest analyst in the group" are *both* true
 * about the same student, and the disagreement is the finding. Averaging them,
 * merging them, or drawing one bar per quadrant all destroy it identically.
 *
 * So the chart is grouped, not stacked. Stacking would give a taller bar for a
 * quadrant three desks agree on, which reads as "more strength" when it
 * actually means "more agreement" — and it would hide a source that wrote
 * nothing inside a segment of height zero. Grouped bars put three separate
 * marks side by side in every quadrant, so a desk that has said nothing about
 * this student is a visible gap at a labelled position rather than an absence
 * nobody can see. `swocTile` guarantees the matrix is complete before it gets
 * here; this component never filters a source out.
 *
 * The colours are positional — first, third and fourth of the shared ramp —
 * and the legend is always on, because three series that are told apart only by
 * hue would be one series to a colour-blind reader. Underneath, `SwocHighlights`
 * prints the actual sentences: a count with no words is a tally, not a reading.
 */

export type SwocChartRow = {
  label: string;
  PLACEMENT: number;
  MENTOR: number;
  PM: number;
};

export function SwocChart({
  data,
  height = 260,
}: {
  data: SwocChartRow[];
  height?: number;
}) {
  const colors = useReepSeriesColors();

  return (
    <ChartFrame
      height={height}
      caption="Entries recorded in each quadrant by each of the three desks. The three are never merged — where they disagree about you, both readings stand."
    >
      <BarChart
        dataset={data}
        xAxis={[{ scaleType: 'band', dataKey: 'label' }]}
        // A count axis with fractional ticks is nonsense, and with two entries
        // in a quadrant the default ramp is 0, 0.5, 1, 1.5, 2. The ceiling
        // guards the all-zero case, where a 0–0 domain is not an axis.
        yAxis={[{ label: 'entries', width: 46, min: 0, max: ceiling(data), tickMinStep: 1 }]}
        series={[
          {
            dataKey: 'PLACEMENT',
            label: 'Placement cell',
            color: colors[1],
            valueFormatter: countLabel,
          },
          {
            dataKey: 'MENTOR',
            label: 'Your mentor',
            color: colors[2],
            valueFormatter: countLabel,
          },
          {
            dataKey: 'PM',
            label: 'Programme manager',
            color: colors[3],
            valueFormatter: countLabel,
          },
        ]}
        borderRadius={3}
        grid={{ horizontal: true }}
        margin={{ top: 12, right: 12, bottom: 4, left: 4 }}
      />
    </ChartFrame>
  );
}

function countLabel(value: number | null): string {
  const n = Number(value ?? 0);
  return n === 1 ? '1 entry' : `${n} entries`;
}

function ceiling(data: SwocChartRow[]): number | undefined {
  const top = Math.max(0, ...data.flatMap((row) => [row.PLACEMENT, row.MENTOR, row.PM]));
  return top === 0 ? 3 : undefined;
}

/**
 * The sentences behind the bars, grouped by desk.
 *
 * Kept in this file rather than the page so the chart and its quotations
 * cannot end up disagreeing about which source is which colour: the swatch
 * beside each group is pulled from the same array, by the same index, as the
 * series above.
 */
export function SwocHighlights({
  highlights,
}: {
  highlights: {
    source: 'PLACEMENT' | 'MENTOR' | 'PM';
    sourceLabel: string;
    kindLabel: string;
    text: string;
    weight: number;
  }[];
}) {
  const colors = useReepSeriesColors();
  const swatch: Record<'PLACEMENT' | 'MENTOR' | 'PM', string> = {
    PLACEMENT: colors[1],
    MENTOR: colors[2],
    PM: colors[3],
  };

  const sources: ('PLACEMENT' | 'MENTOR' | 'PM')[] = ['PLACEMENT', 'MENTOR', 'PM'];

  return (
    <Stack spacing={2.5} sx={{ mt: 1 }}>
      {sources.map((source) => {
        const rows = highlights.filter((row) => row.source === source);
        const label = rows[0]?.sourceLabel ?? SOURCE_FALLBACK[source];

        return (
          <Box key={source}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.75 }}>
              <Box
                sx={{
                  width: 9,
                  height: 9,
                  borderRadius: '2px',
                  bgcolor: swatch[source],
                  flexShrink: 0,
                }}
              />
              <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: '0.08em' }}>
                {label}
              </Typography>
            </Stack>

            {rows.length === 0 ? (
              // Named, not omitted. "Nothing recorded" from the placement cell
              // is information; a missing heading is a bug the reader has to
              // guess at.
              <Typography variant="body2" color="text.disabled">
                Nothing recorded yet.
              </Typography>
            ) : (
              <Stack spacing={1}>
                {rows.map((row) => (
                  <Stack
                    key={`${row.source}-${row.text}`}
                    direction="row"
                    spacing={1.5}
                    sx={{ alignItems: 'baseline' }}
                  >
                    <Typography
                      variant="caption"
                      color="text.disabled"
                      sx={{ width: 82, flexShrink: 0 }}
                    >
                      {row.kindLabel}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                      {row.text}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            )}
          </Box>
        );
      })}
    </Stack>
  );
}

/// Only reached when a desk has written nothing at all, so there is no row to
/// take the label from.
const SOURCE_FALLBACK: Record<'PLACEMENT' | 'MENTOR' | 'PM', string> = {
  PLACEMENT: 'Placement cell',
  MENTOR: 'Your mentor',
  PM: 'Programme manager',
};
