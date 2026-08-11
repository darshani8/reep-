'use client';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { ProgressMeter, StatusChip, type Tone } from '@/components/kit';

/**
 * The handful of cell renderers the four director grids share.
 *
 * They live in a client module because a `renderCell` is a function, and a
 * function cannot be handed to the grid from a Server Component. Every director
 * grid imports from here so a completion bar means the same thing on every
 * screen.
 */

/// One ramp for "how healthy is this percentage", used by every meter cell.
export function completionTone(pct: number): Tone {
  if (pct >= 70) return 'good';
  if (pct >= 50) return 'warning';
  return 'critical';
}

/// Bar plus the number. The number is always printed — nobody should have to
/// measure a bar to find out what it says. The bar is 4px: at that weight it
/// reads as a measurement rather than as a piece of decoration in the row.
export function MeterCell({ value }: { value: number }) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', width: '100%' }}>
      <ProgressMeter value={value} tone={completionTone(value)} sx={{ flex: 1 }} decorative />
      <Typography
        className="tabular"
        variant="body2"
        sx={{ width: 40, textAlign: 'right', fontWeight: 500, flexShrink: 0 }}
      >
        {value.toFixed(0)}%
      </Typography>
    </Stack>
  );
}

/// A headline with a quieter line underneath, for cells that would otherwise
/// need two columns.
export function TwoLineCell({
  primary,
  secondary,
  chip,
}: {
  primary: string;
  secondary?: string | null;
  chip?: { tone: Tone; label: string } | null;
}) {
  return (
    <Box sx={{ minWidth: 0, py: 0.5 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography variant="subtitle2" noWrap sx={{ minWidth: 0 }}>
          {primary}
        </Typography>
        {chip ? <StatusChip tone={chip.tone} label={chip.label} /> : null}
      </Stack>
      {secondary ? (
        <Typography variant="caption" color="text.secondary" noWrap component="div">
          {secondary}
        </Typography>
      ) : null}
    </Box>
  );
}

/**
 * One criterion, judged. A pass prints the plain figure; only a failure is
 * marked. Chipping both states paints two hundred cells on the placement table
 * and the eye then has to search a field of colour for the red ones — printing
 * the exception is what makes the gaps findable.
 */
export function CriterionCell({ passed, actual }: { passed: boolean; actual: string }) {
  if (passed) {
    return (
      <Typography variant="body2" className="tabular" color="text.secondary">
        {actual}
      </Typography>
    );
  }
  return <StatusChip tone="critical" label={actual} />;
}

/// A count that is only worth noticing when it is not zero.
export function CountCell({ value, tone = 'warning' }: { value: number; tone?: Tone }) {
  if (value === 0) {
    return (
      <Typography variant="body2" color="text.disabled">
        —
      </Typography>
    );
  }
  return <StatusChip tone={tone} label={String(value)} />;
}

/// Plain right-aligned number, so the numeric columns line up with each other.
export function NumberCell({ value, suffix = '' }: { value: string | number; suffix?: string }) {
  return (
    <Typography variant="body2" className="tabular">
      {value}
      {suffix}
    </Typography>
  );
}
