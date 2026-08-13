import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Typography from '@mui/material/Typography';

import { EmptyState, PageIntro, SectionCard, StatCard, TechNote } from '@/components/kit';
import { requireMentor } from '@/lib/auth';
import { leaveActor, loadApprovalQueue } from '@/lib/leave/queries';
import { openStage } from '@/lib/leave/rules';

import { decideLeaveAction } from '../actions';
import { LeaveRequestCard } from '../request-card';
import { DecisionForm } from './decision-form';

export const metadata = { title: 'Leave approvals — Mentor' };
export const dynamic = 'force-dynamic';

/**
 * The approver's queue.
 *
 * It holds only what this person may act on, and the ordering rule is visible in
 * the shape of the page: requests a mentor has not yet read do not appear in the
 * programme office's queue at all — they are counted, so the office knows work is
 * coming, and nothing more. A director who could open a request the mentor has
 * not recommended is a two-stage approval with one stage that does not matter.
 *
 * Oldest first, deliberately. This is a to-do list and the person who has been
 * waiting longest goes at the top; sorting by "newest" would quietly favour
 * whoever applied most recently.
 */
export default async function LeaveApprovalsPage() {
  const session = await requireMentor();
  const standing = leaveActor(session);

  if (!standing.ok) {
    return (
      <>
        <PageIntro title="Leave approvals" subtitle="Requests naming you as an approver." />
        <EmptyState title="This account cannot sign leave." hint={standing.reason} />
        <ApprovalsTechNote />
      </>
    );
  }

  const queue = await loadApprovalQueue(standing.userId);
  const settled = queue.history.filter((row) => openStage(row.status) === null).length;

  return (
    <>
      <PageIntro
        title="Leave approvals"
        subtitle="Only requests that have reached you. A request waits with its first approver until they have read it."
        action={
          <Button href="/mentor/leave" sx={{ color: 'text.secondary' }}>
            Your own leave
          </Button>
        }
      />

      <Grid container spacing={2.5} sx={{ mb: 5 }}>
        <Grid size={{ xs: 6, md: 4 }}>
          <StatCard
            label="Waiting on you"
            value={queue.awaiting.length}
            tone={queue.awaiting.length > 0 ? 'warning' : 'good'}
            hint={queue.awaiting.length > 0 ? 'Read the oldest first' : 'Nothing is held up by you'}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 4 }}>
          <StatCard
            label="With the first approver"
            value={queue.waitingOnFirst}
            hint="Reaches you once it is recommended"
          />
        </Grid>
        <Grid size={{ xs: 12, md: 4 }}>
          <StatCard label="Settled" value={settled} hint="Requests you signed that are now closed" />
        </Grid>
      </Grid>

      <SectionCard
        title="Waiting on your signature"
        subtitle={queue.awaiting.length > 0 ? 'Oldest first' : undefined}
      >
        {queue.awaiting.length === 0 ? (
          <EmptyState
            title="Nothing is waiting on you."
            hint={
              queue.waitingOnFirst > 0
                ? `${queue.waitingOnFirst} request${queue.waitingOnFirst === 1 ? ' is' : 's are'} still with their first approver. They arrive here once that signature lands.`
                : 'Requests naming you as an approver appear here the moment they reach your stage.'
            }
          />
        ) : (
          queue.awaiting.map((row) => (
            <LeaveRequestCard
              key={row.id}
              row={row}
              showRequester
              action={
                <DecisionForm
                  requestId={row.id}
                  stage={row.status === 'SUBMITTED' ? 'FIRST' : 'SECOND'}
                  requesterFirstName={row.requesterName.split(' ')[0] ?? row.requesterName}
                  decideAction={decideLeaveAction}
                />
              }
            />
          ))
        )}
      </SectionCard>

      {queue.waitingOnFirst > 0 && (
        <SectionCard title="Not yet with you">
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: '68ch' }}>
            {queue.waitingOnFirst} request{queue.waitingOnFirst === 1 ? '' : 's'} name
            {queue.waitingOnFirst === 1 ? 's' : ''} you as second approver and{' '}
            {queue.waitingOnFirst === 1 ? 'is' : 'are'} still with the first. The dates and
            the reason are deliberately not shown here: the second signature is meant to
            follow a recommendation, not to pre-empt one.
          </Typography>
        </SectionCard>
      )}

      <SectionCard
        title="Already signed by you"
        subtitle="Newest first — settled, or passed on to the other approver"
      >
        {queue.history.length === 0 ? (
          <EmptyState title="You have not signed anything yet." />
        ) : (
          queue.history.map((row) => <LeaveRequestCard key={row.id} row={row} showRequester />)
        )}
      </SectionCard>

      <ApprovalsTechNote />
    </>
  );
}

function ApprovalsTechNote() {
  return (
    <TechNote>
      Who may sign, and when, is decided by <code>decideLeave</code> in{' '}
      <code>src/lib/leave/rules.ts</code> against the row as the database holds it —
      not by which buttons this page drew. A Server Action is reachable by a direct
      POST, so a second approver posting a verdict at a request that is still with its
      first approver is refused by the same function that refuses a stranger, a second
      verdict from the first approver, and any verdict at all on a request that has
      already been decided. What each verdict writes is a patch of exactly the columns
      for that stage, which is why a rejection by the programme office cannot overwrite
      the mentor&rsquo;s recommendation. A mentor account carrying no{' '}
      <code>Mentor</code> row has no scope at all under{' '}
      <code>mentorScope()</code> and is refused the desk outright rather than treated
      as programme staff.
    </TechNote>
  );
}
