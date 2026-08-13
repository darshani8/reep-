import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import { EmptyState } from '@/components/kit';
import type { StreakDay } from '@/lib/landing/tiles';
import type { LoginStreak } from '@/lib/streak';

/**
 * The login streak: what it is now, and the best it has ever been.
 *
 * Two numbers rather than one, and the second is the reason this tile is not a
 * call to `consistency()`. That function counts over a fixed 30-day window, so
 * every student who has turned up all term reports the same "30" — a figure
 * that stops distinguishing anybody at exactly the point it would start being
 * worth something. `loginStreak` has no window, so a personal best of 74 days
 * is printed as 74.
 *
 * The rail underneath exists because a streak is a claim about days, and a
 * student whose count looks wrong has no way to check it otherwise. It also
 * carries the rule that makes the count believable: Sunday is drawn as closed
 * rather than as a miss, because campus is shut and the streak steps over it.
 * A rail that showed Sundays as gaps would visibly contradict the number above
 * it, and the reader would believe the picture.
 *
 * No hue is spent here. A streak is a measurement, not a status a student is
 * meant to act on today — the tone budget on this page belongs to pace and to
 * attendance.
 */
export function StreakTile({
  streak,
  rail,
}: {
  streak: LoginStreak;
  rail: StreakDay[];
}) {
  if (streak.activeDays === 0) {
    return (
      <EmptyState
        title="Your streak starts today."
        hint="Every day you sign in is recorded here. Sundays are skipped — campus is closed, so they never break a run."
      />
    );
  }

  return (
    <Box>
      <Stack direction="row" spacing={4} sx={{ alignItems: 'baseline' }}>
        <Box>
          <Typography
            className="tabular"
            sx={{
              fontSize: '2rem',
              fontWeight: 600,
              lineHeight: 1.05,
              letterSpacing: '-0.028em',
            }}
          >
            {streak.current}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
            {streak.current === 1 ? 'day running' : 'days running'}
          </Typography>
        </Box>

        <Box>
          <Typography
            className="tabular"
            color="text.secondary"
            sx={{ fontSize: '1.25rem', fontWeight: 600, lineHeight: 1.05 }}
          >
            {streak.longest}
          </Typography>
          <Typography variant="caption" color="text.disabled" sx={{ mt: 0.5, display: 'block' }}>
            personal best
          </Typography>
        </Box>

        <Box>
          <Typography
            className="tabular"
            color="text.secondary"
            sx={{ fontSize: '1.25rem', fontWeight: 600, lineHeight: 1.05 }}
          >
            {streak.activeDays}
          </Typography>
          <Typography variant="caption" color="text.disabled" sx={{ mt: 0.5, display: 'block' }}>
            days here in total
          </Typography>
        </Box>
      </Stack>

      <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
        {describe(streak)}
      </Typography>

      {rail.length > 0 && (
        <Box sx={{ mt: 2.5 }}>
          <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {rail.map((square) => (
              <Tooltip key={square.key} title={tooltipFor(square)}>
                <Stack
                  spacing={0.5}
                  sx={{ alignItems: 'center', width: 20, flexShrink: 0 }}
                  aria-label={tooltipFor(square)}
                >
                  <Box
                    sx={{
                      width: 18,
                      height: 18,
                      borderRadius: 1,
                      border: 1,
                      // Three states, three drawings — filled for a day signed
                      // in, an outline for one missed, and a hairline dash for
                      // a Sunday, which is neither.
                      borderColor: square.present ? 'secondary.main' : 'divider',
                      borderStyle: square.closed ? 'dashed' : 'solid',
                      bgcolor: square.present ? 'secondary.main' : 'transparent',
                      outline: square.isToday ? '1.5px solid' : 'none',
                      outlineColor: 'text.disabled',
                      outlineOffset: '1.5px',
                    }}
                  />
                  <Typography
                    variant="caption"
                    color="text.disabled"
                    sx={{ fontSize: '0.625rem', lineHeight: 1 }}
                  >
                    {square.weekday}
                  </Typography>
                </Stack>
              </Tooltip>
            ))}
          </Stack>
          <Typography variant="caption" color="text.disabled" sx={{ mt: 1.5, display: 'block' }}>
            The last fortnight. A filled square is a day you signed in; a dashed one is a Sunday,
            which never breaks a run.
          </Typography>
        </Box>
      )}
    </Box>
  );
}

function describe(streak: LoginStreak): string {
  if (streak.current === 0) {
    return streak.lastActive
      ? `Your run ended — you were last here on ${longDay(streak.lastActive)}. Sign in tomorrow to start another.`
      : 'Sign in tomorrow to start a run.';
  }
  if (streak.current >= streak.longest) {
    return streak.current === 1
      ? 'A run of one. Come back tomorrow and it is two.'
      : `This is your best run so far, and it started on ${longDay(streak.currentSince)}.`;
  }
  const short = streak.longest - streak.current;
  return `Started ${longDay(streak.currentSince)} — ${short} more ${
    short === 1 ? 'day' : 'days'
  } to match your best of ${streak.longest}.`;
}

/// `YYYY-MM-DD` read back as a date. The key is a UTC-midnight calendar day, so
/// it is formatted in UTC — reading it in the local zone would print the day
/// before for anyone west of Greenwich.
function longDay(key: string | null): string {
  if (!key) return 'recently';
  return new Date(`${key}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function tooltipFor(square: StreakDay): string {
  if (square.closed) return `${square.label} — campus closed`;
  return `${square.label} — ${square.present ? 'signed in' : 'not seen'}`;
}
