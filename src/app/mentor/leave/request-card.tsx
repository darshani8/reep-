import type { ReactNode } from 'react';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { StatusChip, Surface, type Tone } from '@/components/kit';
import type { LeaveRow } from '@/lib/leave/queries';
import { LEAVE_STATUS_LABEL, leaveRangeWords } from '@/lib/leave/rules';
import { relativeDay } from '@/lib/reep';
import type { LeaveDecision, LeaveStatus } from '@prisma/client';

/**
 * One request, with both signatures shown whether or not they have happened.
 *
 * The two stages are always drawn — an unsigned stage says "waiting" rather than
 * being left out. A card that only lists the decisions already taken reads like
 * a one-step approval that happens to have gone twice, and the ordering is the
 * thing this screen has to make obvious.
 *
 * Rendered on the server so no `Date` crosses into a client component: leave
 * dates are `@db.Date` and are formatted in UTC, while a decision timestamp is a
 * real moment and is formatted local, which is a distinction the browser has no
 * way to make from the values alone.
 */

const STATUS_TONE: Record<LeaveStatus, Tone> = {
  SUBMITTED: 'neutral',
  FIRST_APPROVED: 'info',
  APPROVED: 'good',
  REJECTED: 'critical',
  CANCELLED: 'neutral',
};

export function LeaveRequestCard({
  row,
  showRequester = false,
  action,
}: {
  row: LeaveRow;
  /// On the approvals queue the requester is the headline; on your own list it
  /// is you, and repeating your name on every card is noise.
  showRequester?: boolean;
  action?: ReactNode;
}) {
  return (
    <Surface sx={{ mb: 2 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{ justifyContent: 'space-between', alignItems: { sm: 'baseline' } }}
      >
        <Box sx={{ minWidth: 0 }}>
          {showRequester ? (
            <>
              <Typography variant="subtitle1">{row.requesterName}</Typography>
              <Typography variant="caption" color="text.secondary">
                {row.requesterMeta}
              </Typography>
            </>
          ) : (
            <Typography variant="subtitle1">
              {leaveRangeWords(row.fromDate, row.toDate)}
            </Typography>
          )}
        </Box>
        <StatusChip tone={STATUS_TONE[row.status]} label={LEAVE_STATUS_LABEL[row.status]} />
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mt: showRequester ? 1 : 0.25 }}>
        {showRequester ? `${leaveRangeWords(row.fromDate, row.toDate)} · ` : ''}
        {row.days} day{row.days === 1 ? '' : 's'} · applied{' '}
        {relativeDay(row.createdAt).toLowerCase()}
      </Typography>

      <Typography variant="body2" sx={{ mt: 1.5, maxWidth: '72ch' }}>
        {row.reason}
      </Typography>

      <Stack spacing={1.25} sx={{ mt: 2.5, pt: 2, borderTop: 1, borderColor: 'divider' }}>
        <Signature
          stage="First approval"
          who={row.firstApproverName}
          decision={row.firstDecision}
          decidedAt={row.firstDecidedAt}
          note={row.firstNote}
          waitingWord="Waiting to be read"
        />
        <Signature
          stage="Second approval"
          who={row.secondApproverName}
          decision={row.secondDecision}
          decidedAt={row.secondDecidedAt}
          note={row.secondNote}
          waitingWord={
            row.status === 'SUBMITTED'
              ? 'Not started — the first approver has it'
              : row.secondApproverName
                ? 'Waiting to be read'
                : 'No second signatory on record yet'
          }
        />
      </Stack>

      {action ? <Box sx={{ mt: 2.5 }}>{action}</Box> : null}
    </Surface>
  );
}

function Signature({
  stage,
  who,
  decision,
  decidedAt,
  note,
  waitingWord,
}: {
  stage: string;
  who: string | null;
  decision: LeaveDecision | null;
  decidedAt: Date | null;
  note: string | null;
  waitingWord: string;
}) {
  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Typography variant="caption" color="text.secondary" sx={{ width: 130, flexShrink: 0 }}>
          {stage}
        </Typography>
        <Typography variant="body2">{who ?? 'Not routed'}</Typography>
        {decision ? (
          <StatusChip
            tone={decision === 'APPROVED' ? 'good' : 'critical'}
            label={decision === 'APPROVED' ? 'Approved' : 'Rejected'}
          />
        ) : (
          <Typography variant="caption" color="text.disabled">
            {waitingWord}
          </Typography>
        )}
      </Stack>

      {decidedAt ? (
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', pl: '138px' }}>
          {stampWords(decidedAt)}
        </Typography>
      ) : null}

      {note ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, pl: '138px' }}>
          “{note}”
        </Typography>
      ) : null}
    </Box>
  );
}

/// A decision timestamp is a moment, not a day — the audit trail is the reason
/// this screen exists, so it prints the time as well as the date.
function stampWords(date: Date): string {
  return date.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
