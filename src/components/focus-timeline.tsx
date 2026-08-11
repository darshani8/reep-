import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { EmptyState, StatusChip, type Tone } from '@/components/kit';
import {
  ABANDONED_SESSION_MIN,
  QUALITY_LABEL,
  classifySession,
  type SessionQuality,
  type SessionRow,
} from '@/lib/analytics';
import { SOURCE_LABEL, formatDuration, relativeDay } from '@/lib/reep';
import type { CheckInSource } from '@prisma/client';

/**
 * "Recent lab check-ins" — the middle of the mentor's Focus Log.
 *
 * One line per check-in, in plain English, with a coloured dot for how the
 * session went. A mentor should be able to read the last two weeks of a
 * student's lab life without decoding anything.
 *
 * This is a Server Component: it takes the session rows as they come out of
 * Prisma and does the classifying and the wording itself, so the page stays a
 * layout file.
 */

export type TimelineSession = SessionRow & {
  source: CheckInSource;
  mentorConfirmed: boolean;
};

const QUALITY_TONE: Record<SessionQuality, Tone> = {
  PRODUCTIVE: 'good',
  SHALLOW: 'warning',
  ABANDONED: 'critical',
  UNVERIFIED: 'neutral',
};

/// Dots are theme tokens, never hex, so they follow light/dark with everything
/// else. The quality label sits beside every dot, so colour is never alone.
const QUALITY_DOT: Record<SessionQuality, string> = {
  PRODUCTIVE: 'success.main',
  SHALLOW: 'warning.main',
  ABANDONED: 'error.main',
  UNVERIFIED: 'text.disabled',
};

export function FocusTimeline({ sessions }: { sessions: TimelineSession[] }) {
  if (sessions.length === 0) {
    return (
      <EmptyState
        title="No lab check-ins recorded yet."
        hint="Check-ins arrive from the campus-ID badge reader and the lab PCs. A mentor can also confirm a session by hand."
      />
    );
  }

  return (
    <Stack>
      {sessions.map((session, index) => {
        const quality = classifySession(session);
        const isLast = index === sessions.length - 1;

        return (
          <Stack key={session.id} direction="row" spacing={2}>
            {/* The rail: one dot per check-in, joined by a hairline. */}
            <Box sx={{ position: 'relative', width: 8, flexShrink: 0 }}>
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  mt: '8px',
                  borderRadius: '50%',
                  bgcolor: QUALITY_DOT[quality],
                }}
              />
              {!isLast && (
                <Box
                  sx={{
                    position: 'absolute',
                    left: '3.5px',
                    top: 21,
                    bottom: -4,
                    width: '1px',
                    bgcolor: 'divider',
                  }}
                />
              )}
            </Box>

            <Box sx={{ flex: 1, minWidth: 0, pb: isLast ? 0 : 2.5 }}>
              <Stack
                direction="row"
                spacing={1}
                sx={{ alignItems: 'center', justifyContent: 'space-between' }}
              >
                <Typography variant="subtitle2" sx={{ minWidth: 0 }}>
                  {session.courseCode} · {session.module}
                </Typography>
                <StatusChip tone={QUALITY_TONE[quality]} label={QUALITY_LABEL[quality]} />
              </Stack>

              <Typography variant="body2" sx={{ mt: 0.5 }}>
                {describeSession(session)}
              </Typography>

              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mt: 0.25, display: 'block' }}
              >
                {relativeDay(session.checkInAt)} at {clockTime(session.checkInAt)} ·{' '}
                {SOURCE_LABEL[session.source]}
                {session.mentorConfirmed ? ' · confirmed by you' : ''}
              </Typography>
            </Box>
          </Stack>
        );
      })}
    </Stack>
  );
}

/// The sentence a mentor actually reads. Every branch says what happened and,
/// where we know it, what came out of it.
function describeSession(session: TimelineSession): string {
  if (session.checkOutAt == null || session.durationMin == null) {
    return 'Checked in but never checked out — the session was never closed.';
  }

  if (session.durationMin < ABANDONED_SESSION_MIN) {
    return `Checked in, left after ${session.durationMin} min (no re-entry)`;
  }

  const spent = formatDuration(session.durationMin);

  if (session.progressDeltaPct == null) {
    return `${spent} · the platform reported no progress figure for this session`;
  }

  const delta = session.progressDeltaPct;
  if (delta <= 0) {
    return `${spent} · platform progress did not move`;
  }

  return `${spent} · platform progress +${delta.toFixed(delta < 1 ? 1 : 0)}%`;
}

function clockTime(date: Date): string {
  return date.toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
