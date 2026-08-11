import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { Fact, ProgressMeter, type Tone } from '@/components/kit';
import {
  SHALLOW_PROGRESS_PER_HOUR,
  type Consistency,
  type FocusQuality,
} from '@/lib/analytics';
import { formatDuration, formatHours, relativeDay } from '@/lib/reep';

/**
 * "Focus quality" — the one panel that answers *did the logged hours turn into
 * anything?*
 *
 * The score is printed, not drawn, and every input to it is printed beside it,
 * so a mentor can explain the number to the student in one sentence.
 */

export function FocusQualityPanel({
  focus,
  consistency,
  firstName,
}: {
  focus: FocusQuality;
  consistency: Consistency;
  firstName: string;
}) {
  const tone: Tone =
    focus.focusScore >= 70 ? 'good' : focus.focusScore >= 45 ? 'warning' : 'critical';

  return (
    <Stack spacing={2.5}>
      <Box>
        <Stack
          direction="row"
          spacing={1.5}
          sx={{ alignItems: 'baseline', justifyContent: 'space-between' }}
        >
          <Typography
            className="tabular"
            sx={{
              fontSize: '2.25rem',
              fontWeight: 600,
              lineHeight: 1.05,
              letterSpacing: '-0.028em',
            }}
          >
            {focus.focusScore}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            out of 100
          </Typography>
        </Stack>
        <ProgressMeter
          value={focus.focusScore}
          tone={tone}
          sx={{ mt: 1.5 }}
          label="Focus score"
        />
      </Box>

      <Typography variant="body2">{verdict(focus, firstName)}</Typography>

      <Grid container spacing={2.5}>
        <Grid size={6}>
          <Fact
            label="Progress per hour"
            value={`${focus.progressPerHour.toFixed(2)} pts`}
            tone={focus.progressPerHour >= SHALLOW_PROGRESS_PER_HOUR ? 'good' : 'warning'}
          />
        </Grid>
        <Grid size={6}>
          <Fact label="Typical session" value={formatDuration(focus.medianSessionMin)} />
        </Grid>
        <Grid size={6}>
          <Fact
            label="Left early"
            value={`${focus.abandonedRatePct.toFixed(0)}%`}
            tone={focus.abandonedRatePct >= 25 ? 'critical' : 'neutral'}
          />
        </Grid>
        <Grid size={6}>
          <Fact
            label="Time logged"
            value={formatHours(focus.totalHours)}
          />
        </Grid>
      </Grid>

      <Typography variant="caption" color="text.secondary">
        Active on {consistency.activeDays} of the last {consistency.windowDays} days ·
        longest quiet spell {consistency.longestGapDays} days · last check-in{' '}
        {relativeDay(consistency.lastActiveAt).toLowerCase()}.
      </Typography>
    </Stack>
  );
}

/// One sentence, no jargon. This is the line a mentor repeats in the 1:1.
function verdict(focus: FocusQuality, firstName: string): string {
  if (focus.totalSessions === 0) {
    return `No closed lab sessions yet, so there is nothing to score. The first check-in starts this off.`;
  }

  const rate = focus.progressPerHour.toFixed(2);

  if (focus.progressPerHour >= SHALLOW_PROGRESS_PER_HOUR) {
    return `The hours are working. Every logged hour is producing about ${rate} progress points, which is above the ${SHALLOW_PROGRESS_PER_HOUR} we treat as healthy.`;
  }

  if (focus.abandonedRatePct >= 25) {
    return `${firstName} is checking in and leaving again — ${focus.abandonedRatePct.toFixed(0)}% of sessions ended inside 20 minutes, and the hours that do get logged only return about ${rate} progress points each.`;
  }

  return `The time is being spent but little is coming out of it: about ${rate} progress points per logged hour, against ${SHALLOW_PROGRESS_PER_HOUR} for a healthy session.`;
}
