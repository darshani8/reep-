'use client';

import Box from '@mui/material/Box';
import { BarChart } from '@mui/x-charts/BarChart';
import { LineChart } from '@mui/x-charts/LineChart';

import { ChartFrame, useReepSeriesColors } from '@/components/reep-charts';
import { EmptyState } from '@/components/kit';

/**
 * University marks, drawn as the two different questions they answer.
 *
 * SGPA per semester is a trajectory: one point per published result, and the
 * only honest thing to do with a semester still in progress is to leave it off
 * the line. Plotting a null as zero draws a collapse the student has not
 * suffered, and on a first-semester student it draws the entire chart as a
 * crash from nowhere — which is why the filtering happens in `marksTile` and
 * this file simply trusts the series it is handed.
 *
 * The subject breakdown is a diagnosis, and it is stacked rather than totalled
 * for the reason the schema stores the two columns separately: 42/50 internal
 * against 18/50 external is exam technique, and the reverse is coursework
 * discipline. A single "total" bar hides both. The 40-mark pass line is drawn
 * on the same axis so a bar that is short is also visibly *below* something.
 *
 * Neither chart is given its own palette. Colours come from
 * `useReepSeriesColors`, the same hook `reep-charts.tsx` uses, so a marks chart
 * cannot become the one screen with a different green.
 */

/// VTU grades out of 10, so the axis is fixed rather than fitted. An SGPA of
/// 8.1 in a chart auto-scaled to 7.9–8.3 looks like a triumph; against the real
/// ceiling it looks like what it is.
const SGPA_MAX = 10;

/// Internal + external, each out of 50.
const SUBJECT_MAX = 100;

/// VTU needs 40% overall to pass a subject.
const PASS_TOTAL = 40;

export function SgpaChart({
  data,
  height = 240,
}: {
  data: { label: string; semester: number; sgpa: number; cgpa: number | null }[];
  height?: number;
}) {
  const colors = useReepSeriesColors();

  if (data.length === 0) {
    return (
      <EmptyState
        title="No published results yet."
        hint="Your SGPA appears here once the university publishes the semester you are sitting."
      />
    );
  }

  // One published semester is a dot, not a trend, and a line chart of a single
  // point draws nothing at all unless the mark is forced on.
  const single = data.length === 1;

  return (
    <ChartFrame
      height={height}
      caption={`SGPA for each published semester${
        data.some((point) => point.cgpa != null) ? ', with the cumulative CGPA alongside' : ''
      }. Both are out of ${SGPA_MAX}.`}
    >
      <LineChart
        dataset={data as unknown as Record<string, number | string | null>[]}
        xAxis={[{ scaleType: 'point', dataKey: 'label' }]}
        yAxis={[{ min: 0, max: SGPA_MAX, label: 'grade point', width: 52 }]}
        series={[
          {
            dataKey: 'sgpa',
            label: 'SGPA — this semester',
            color: colors[3],
            curve: 'monotoneX',
            showMark: true,
            valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(2)),
          },
          {
            dataKey: 'cgpa',
            label: 'CGPA — cumulative',
            color: colors[1],
            curve: 'monotoneX',
            showMark: single,
            connectNulls: false,
            valueFormatter: (v) => (v == null ? 'not published' : Number(v).toFixed(2)),
          },
        ]}
        grid={{ horizontal: true }}
        margin={{ top: 12, right: 16, bottom: 4, left: 4 }}
        sx={{
          '& .MuiLineElement-root': { strokeWidth: 2 },
          '& .MuiLineElement-series-cgpa': { strokeDasharray: '6 5' },
          '& .MuiMarkElement-root': {
            strokeWidth: 2,
            stroke: 'var(--mui-palette-background-paper)',
            r: 4,
          },
        }}
      />
    </ChartFrame>
  );
}

export function SubjectMarksChart({
  data,
  height,
}: {
  data: {
    label: string;
    subjectName: string;
    internal: number;
    external: number;
    total: number;
    passed: boolean;
  }[];
  height?: number;
}) {
  const colors = useReepSeriesColors();

  if (data.length === 0) {
    return (
      <EmptyState
        title="No subjects recorded for this semester yet."
        hint="Subject marks appear as soon as the department uploads the internal assessment sheet."
      />
    );
  }

  const anyExternal = data.some((subject) => subject.external > 0);
  const resolved = height ?? Math.max(data.length * 34 + 60, 200);

  return (
    <ChartFrame
      height={resolved}
      caption={
        anyExternal
          ? `Internal and external marks stacked, each out of 50. ${PASS_TOTAL} of ${SUBJECT_MAX} is the pass mark.`
          : `Internal assessment only — the external paper for this semester has not been sat. Each internal is out of 50.`
      }
    >
      <BarChart
        dataset={data}
        layout="horizontal"
        yAxis={[{ scaleType: 'band', dataKey: 'label', width: 78 }]}
        xAxis={[{ min: 0, max: SUBJECT_MAX }]}
        series={[
          {
            dataKey: 'internal',
            label: 'Internal (of 50)',
            stack: 'marks',
            color: colors[1],
            valueFormatter: (v, { dataIndex }) =>
              `${Number(v ?? 0)}/50 · ${data[dataIndex]?.subjectName ?? ''}`,
          },
          {
            dataKey: 'external',
            label: 'External (of 50)',
            stack: 'marks',
            color: colors[3],
            // A zero here is a real state — the paper has not been sat — so the
            // formatter says so rather than printing "0/50", which reads as a
            // failed exam.
            valueFormatter: (v, { dataIndex }) =>
              Number(v ?? 0) === 0
                ? `not sat · ${data[dataIndex]?.subjectName ?? ''}`
                : `${Number(v ?? 0)}/50 · ${data[dataIndex]?.subjectName ?? ''}`,
          },
        ]}
        borderRadius={3}
        grid={{ vertical: true }}
        margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
      />
    </ChartFrame>
  );
}

/// The subject list as text, for the marks the chart cannot label. Rendered
/// beside the chart rather than inside it because a bar wide enough to hold
/// "Financial Management 78/100" is a table pretending to be a chart.
export function SubjectMarksKey({
  data,
}: {
  data: { label: string; subjectName: string; total: number; passed: boolean }[];
}) {
  if (data.length === 0) return null;

  return (
    <Box component="dl" sx={{ m: 0, mt: 2.5, display: 'grid', gap: 1 }}>
      {data.map((subject) => (
        <Box
          key={subject.label}
          sx={{ display: 'flex', gap: 1.5, alignItems: 'baseline', minWidth: 0 }}
        >
          <Box
            component="dt"
            sx={{
              width: 78,
              flexShrink: 0,
              fontSize: '0.75rem',
              color: 'text.disabled',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {subject.label}
          </Box>
          <Box
            component="dd"
            sx={{ m: 0, flex: 1, minWidth: 0, fontSize: '0.8125rem', color: 'text.secondary' }}
          >
            {subject.subjectName}
          </Box>
          <Box
            component="span"
            className="tabular"
            sx={{
              flexShrink: 0,
              fontSize: '0.8125rem',
              fontWeight: 600,
              // The word does the work; the colour only ranks it. A failed
              // subject also carries "backlog" in the text beside the number.
              color: subject.passed ? 'text.primary' : 'error.dark',
            }}
          >
            {subject.total}/{SUBJECT_MAX}
            {subject.passed ? '' : ' · backlog'}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
