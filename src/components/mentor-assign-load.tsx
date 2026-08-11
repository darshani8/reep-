import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { ProgressMeter } from '@/components/kit';

/**
 * Who is carrying what, before anybody is moved.
 *
 * The bar measures *caseload*, not progress — that is the imbalance this screen
 * exists to fix, and a mentor with twenty-two mentees should be visible from
 * across the room. Mean completion sits beside it as a number rather than a
 * second bar: it is a different quantity, and two bars per row would invite
 * reading them against each other.
 *
 * No 'use client' — this is plain composition, so the director page renders it
 * on the server.
 */

export type MentorLoadRow = {
  id: string;
  /// "Prof. Anita Desai"
  name: string;
  group: string;
  menteeCount: number;
  meanPct: number;
};

/// Same ramp the director grids use, resolved straight to an ink token.
/// Duplicated rather than imported from `director-cells`, which is a client
/// module: a server page cannot call a function across that boundary.
function completionInk(pct: number): string {
  if (pct >= 70) return 'success.dark';
  if (pct >= 50) return 'warning.dark';
  return 'error.dark';
}

function LoadRow({
  primary,
  secondary,
  count,
  meanPct,
  max,
  muted = false,
}: {
  primary: string;
  secondary: string;
  count: number;
  meanPct: number;
  max: number;
  muted?: boolean;
}) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={{ xs: 0.75, sm: 2.5 }}
      sx={{ alignItems: { sm: 'center' } }}
    >
      <Box sx={{ width: { sm: 230 }, flexShrink: 0, minWidth: 0 }}>
        <Typography variant="subtitle2" noWrap color={muted ? 'text.secondary' : 'text.primary'}>
          {primary}
        </Typography>
        <Typography variant="caption" color="text.disabled" noWrap component="div">
          {secondary}
        </Typography>
      </Box>

      <ProgressMeter
        value={max > 0 ? (count / max) * 100 : 0}
        tone={muted ? 'warning' : 'neutral'}
        height={6}
        sx={{ flex: 1, minWidth: 80 }}
        label={`${primary} caseload`}
      />

      <Typography
        className="tabular"
        variant="body2"
        sx={{ width: { sm: 96 }, flexShrink: 0, fontWeight: 500 }}
      >
        {count} {count === 1 ? 'mentee' : 'mentees'}
      </Typography>

      <Typography
        className="tabular"
        variant="body2"
        sx={{ width: { sm: 104 }, flexShrink: 0 }}
        color={count === 0 ? 'text.disabled' : completionInk(meanPct)}
      >
        {count === 0 ? '—' : `${meanPct}% mean`}
      </Typography>
    </Stack>
  );
}

export function MentorAssignLoad({
  mentors,
  unassignedCount,
  unassignedMeanPct,
}: {
  mentors: MentorLoadRow[];
  unassignedCount: number;
  unassignedMeanPct: number;
}) {
  const max = Math.max(1, unassignedCount, ...mentors.map((m) => m.menteeCount));

  return (
    <Stack spacing={2.25}>
      {mentors.map((mentor) => (
        <LoadRow
          key={mentor.id}
          primary={mentor.name}
          secondary={mentor.group}
          count={mentor.menteeCount}
          meanPct={mentor.meanPct}
          max={max}
        />
      ))}

      {unassignedCount > 0 ? (
        <LoadRow
          primary="Unassigned"
          secondary="Nobody is watching these students"
          count={unassignedCount}
          meanPct={unassignedMeanPct}
          max={max}
          muted
        />
      ) : null}
    </Stack>
  );
}
