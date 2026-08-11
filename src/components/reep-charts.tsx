'use client';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useColorScheme } from '@mui/material/styles';
import { BarChart } from '@mui/x-charts/BarChart';
import { LineChart } from '@mui/x-charts/LineChart';
import { PieChart } from '@mui/x-charts/PieChart';

import { CHART_SERIES_DARK, CHART_SERIES_LIGHT, STATUS } from '@/theme';

/**
 * Chart wrappers.
 *
 * MUI X Charts does the drawing; this file fixes the things that must not vary
 * between screens — the series palette, thin marks, a legend whenever there is
 * more than one series, and value labels only where they help. Charts read as
 * one system because no screen passes its own colours.
 */

function useSeriesColors() {
  const { mode, systemMode } = useColorScheme();
  const resolved = mode === 'system' ? systemMode : mode;
  return resolved === 'dark' ? CHART_SERIES_DARK : CHART_SERIES_LIGHT;
}

const AXIS_SX = {
  '& .MuiChartsAxis-line': { stroke: 'var(--mui-palette-divider)' },
  '& .MuiChartsAxis-tick': { stroke: 'var(--mui-palette-divider)' },
  '& .MuiChartsAxis-tickLabel': {
    fill: 'var(--mui-palette-text-secondary)',
    fontSize: 11,
  },
  '& .MuiChartsGrid-line': { stroke: 'var(--mui-palette-divider)' },
} as const;

export function ChartFrame({
  height = 240,
  children,
  caption,
}: {
  height?: number;
  children: React.ReactNode;
  caption?: string;
}) {
  return (
    <Box>
      <Box sx={{ width: '100%', height, ...AXIS_SX }}>{children}</Box>
      {caption && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {caption}
        </Typography>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Hours vs target — Screen 3
// ---------------------------------------------------------------------------

export function HoursVsTargetChart({
  data,
  height = 240,
}: {
  data: { label: string; hours: number; targetHours: number }[];
  height?: number;
}) {
  const target = data[0]?.targetHours ?? 0;

  return (
    <ChartFrame
      height={height}
      // The caption used to promise a dashed target line. No ChartsReferenceLine
      // is drawn here and never was, so the only textual description of this
      // chart described something that is not on screen — which for a
      // screen-reader user was the entire chart.
      caption={`Hours logged each day against a ${target.toFixed(1)}h daily target.`}
    >
      <BarChart
        dataset={data}
        xAxis={[{ scaleType: 'band', dataKey: 'label' }]}
        yAxis={[{ label: 'hours', width: 46 }]}
        series={[
          {
            dataKey: 'hours',
            label: 'Hours logged',
            valueFormatter: (v) => `${Number(v ?? 0).toFixed(1)}h`,
            // v9 moved barLabel from the chart onto the series. The value is
            // printed on every bar, so colour is never the only signal.
            barLabel: (item) => {
              const hours = Number(item.value ?? 0);
              return hours > 0 ? hours.toFixed(1) : null;
            },
          },
        ]}
        colors={[STATUS.good]}
        borderRadius={3}
        grid={{ horizontal: true }}
        hideLegend
        margin={{ top: 16, right: 12, bottom: 4, left: 4 }}
        sx={{
          '& .MuiBarElement-root': { rx: 6 },
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

// ---------------------------------------------------------------------------
// Actual vs expected pace — Screen 5
// ---------------------------------------------------------------------------

export function PaceCurveChart({
  data,
  behind,
  height = 280,
}: {
  data: { label: string; expected: number; actual: number | null }[];
  behind: boolean;
  height?: number;
}) {
  const colors = useSeriesColors();
  const actualColor = behind ? STATUS.critical : STATUS.good;

  return (
    <ChartFrame
      height={height}
      // The series label, not the caption, carries the verdict. This is the one
      // place the product tells a student they are falling behind, and it used
      // to say "Red means behind the curve" — instructing the reader to decode
      // a hue, which is unavailable to a colour-blind student and gone entirely
      // in the printable record. The colour now reinforces a word rather than
      // replacing it.
      caption="Expected pace is the dashed line; the solid line is this student's actual completion, labelled with where it stands."
    >
      <LineChart
        dataset={data as unknown as Record<string, number | string | null>[]}
        xAxis={[{ scaleType: 'point', dataKey: 'label' }]}
        yAxis={[{ min: 0, max: 100, label: '%', width: 46 }]}
        series={[
          {
            dataKey: 'expected',
            label: 'Expected pace',
            color: colors[1],
            showMark: false,
            curve: 'monotoneX',
            valueFormatter: (v) => (v == null ? '—' : `${Number(v).toFixed(0)}%`),
          },
          {
            dataKey: 'actual',
            label: behind ? 'Actual completion — behind pace' : 'Actual completion — on track',
            color: actualColor,
            showMark: false,
            curve: 'monotoneX',
            connectNulls: false,
            valueFormatter: (v) => (v == null ? '—' : `${Number(v).toFixed(0)}%`),
          },
        ]}
        grid={{ horizontal: true }}
        margin={{ top: 12, right: 16, bottom: 4, left: 4 }}
        sx={{
          // 2px marks, and the reference series reads as a projection.
          '& .MuiLineElement-root': { strokeWidth: 2 },
          '& .MuiLineElement-series-expected': { strokeDasharray: '6 5' },
        }}
      />
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------
// Trend — Screen 6
// ---------------------------------------------------------------------------

export function TrendChart({
  data,
  height = 240,
  color = STATUS.critical,
  label = 'Value',
  area = true,
}: {
  data: { label: string; value: number }[];
  height?: number;
  color?: string;
  label?: string;
  area?: boolean;
}) {
  return (
    <ChartFrame height={height}>
      <LineChart
        dataset={data as unknown as Record<string, number | string>[]}
        xAxis={[{ scaleType: 'point', dataKey: 'label' }]}
        yAxis={[{ min: 0, width: 46 }]}
        series={[
          {
            dataKey: 'value',
            label,
            color,
            area,
            curve: 'monotoneX',
            showMark: true,
          },
        ]}
        grid={{ horizontal: true }}
        hideLegend
        margin={{ top: 16, right: 16, bottom: 4, left: 4 }}
        sx={{
          '& .MuiLineElement-root': { strokeWidth: 2 },
          '& .MuiAreaElement-root': { fillOpacity: 0.12 },
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

// ---------------------------------------------------------------------------
// Ranked horizontal bars — bottlenecks, time-of-day yield
// ---------------------------------------------------------------------------

export function RankedBarChart({
  data,
  height,
  unit = '%',
  colorFor,
  scale = 'relative',
}: {
  data: { label: string; value: number }[];
  height?: number;
  unit?: string;
  /// Only pass this from a Client Component — a function cannot cross the
  /// server/client boundary.
  colorFor?: (value: number) => string;
  /// Set for 0–100 completion data, where 70/50 are meaningful thresholds.
  /// Left off, the ramp is relative to the largest bar, so it works on any
  /// scale (progress-points per hour, counts, hours) instead of painting every
  /// bar "critical" just because the numbers are small.
  scale?: 'percentage' | 'relative';
}) {
  const max = Math.max(...data.map((d) => d.value), 0);

  const pick =
    colorFor ??
    (scale === 'percentage'
      ? (v: number) => (v >= 70 ? STATUS.good : v >= 50 ? STATUS.warning : STATUS.critical)
      : (v: number) => {
          if (max <= 0) return STATUS.warning;
          const share = v / max;
          return share >= 0.75 ? STATUS.good : share >= 0.4 ? STATUS.warning : STATUS.critical;
        });

  const resolved = height ?? Math.max(data.length * 46 + 40, 160);

  return (
    <ChartFrame height={resolved}>
      <BarChart
        dataset={data}
        layout="horizontal"
        yAxis={[{ scaleType: 'band', dataKey: 'label', width: 108 }]}
        xAxis={[{ min: 0 }]}
        series={[
          {
            dataKey: 'value',
            label: 'Value',
            valueFormatter: (v) => `${Number(v ?? 0)}${unit}`,
            barLabel: (item) => `${Number(item.value ?? 0)}${unit}`,
          },
        ]}
        colors={data.map((d) => pick(d.value))}
        borderRadius={3}
        grid={{ vertical: true }}
        hideLegend
        margin={{ top: 4, right: 44, bottom: 4, left: 4 }}
        sx={{
          '& .MuiChartsBarLabel-root': {
            // The label sits *inside* the bar, so it contrasts with the fill,
            // not with the page — and the fill here comes from the `STATUS`
            // constant, which is a fixed object rather than a palette entry.
            // That makes the bars the same three dark ambers in both colour
            // schemes, so the label is white in both. `text.primary` was ink
            // (dark on dark once the ramp darkened) and `primary.contrastText`
            // would be wrong the other way, flipping to near-black in dark mode
            // over a bar that never lightened: 3.78:1.
            //
            // This is the one white in the product, and it is a foreground on a
            // dark fill rather than a background — 5.62:1 on the lightest of the
            // three (#8b5f1c).
            fill: '#ffffff',
            fontSize: 12,
            fontWeight: 600,
          },
        }}
      />
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------
// Stacked hours by learning mode
// ---------------------------------------------------------------------------

export function StackedModeChart({
  data,
  height = 260,
}: {
  data: {
    label: string;
    INSTRUCTOR_LED: number;
    SUPERVISED_LAB: number;
    INDEPENDENT: number;
  }[];
  height?: number;
}) {
  const colors = useSeriesColors();

  return (
    <ChartFrame height={height}>
      <BarChart
        dataset={data}
        xAxis={[{ scaleType: 'band', dataKey: 'label' }]}
        yAxis={[{ label: 'hours', width: 46 }]}
        series={[
          { dataKey: 'INSTRUCTOR_LED', label: 'Instructor-led', stack: 'h', color: colors[1] },
          { dataKey: 'SUPERVISED_LAB', label: 'Supervised lab', stack: 'h', color: colors[2] },
          { dataKey: 'INDEPENDENT', label: 'Independent', stack: 'h', color: colors[3] },
        ].map((s) => ({
          ...s,
          valueFormatter: (v: number | null) => `${Number(v ?? 0).toFixed(1)}h`,
        }))}
        borderRadius={3}
        grid={{ horizontal: true }}
        margin={{ top: 12, right: 12, bottom: 4, left: 4 }}
      />
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------
// Donut — mode split, quality split
// ---------------------------------------------------------------------------

export function DonutChart({
  data,
  height = 230,
  unit = '',
  centreLabel,
  centreValue,
}: {
  data: { label: string; value: number; color?: string }[];
  height?: number;
  unit?: string;
  centreLabel?: string;
  centreValue?: string;
}) {
  const colors = useSeriesColors();
  const withColor = data.map((d, i) => ({
    id: d.label,
    label: d.label,
    value: d.value,
    color: d.color ?? colors[i % colors.length],
  }));

  return (
    <Box sx={{ position: 'relative' }}>
      <ChartFrame height={height}>
        <PieChart
          series={[
            {
              data: withColor,
              innerRadius: 62,
              outerRadius: 96,
              paddingAngle: 2,
              cornerRadius: 4,
              highlightScope: { fade: 'global', highlight: 'item' },
              valueFormatter: (item) => `${item.value}${unit}`,
            },
          ]}
          hideLegend
          margin={{ top: 6, right: 6, bottom: 6, left: 6 }}
        />
      </ChartFrame>

      {centreValue && (
        <Stack
          sx={{
            position: 'absolute',
            inset: 0,
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <Typography sx={{ fontSize: '1.5rem', fontWeight: 600, lineHeight: 1 }}>
            {centreValue}
          </Typography>
          {centreLabel && (
            <Typography variant="caption" color="text.secondary">
              {centreLabel}
            </Typography>
          )}
        </Stack>
      )}
    </Box>
  );
}

/// Legend rendered as rows with values — more readable than a chart legend when
/// the numbers matter as much as the split.
export function LegendList({
  items,
}: {
  items: { label: string; value: string; color: string }[];
}) {
  return (
    <Stack spacing={1.25}>
      {items.map((item) => (
        <Stack key={item.label} direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
          <Box
            sx={{ width: 9, height: 9, borderRadius: '2px', bgcolor: item.color, flexShrink: 0 }}
          />
          <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
            {item.label}
          </Typography>
          <Typography variant="body2" className="tabular" sx={{ fontWeight: 600 }}>
            {item.value}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}

export function useReepSeriesColors() {
  return useSeriesColors();
}
