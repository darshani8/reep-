import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';

import { EmptyState, InfoBanner, PageIntro, SectionCard, StatCard, TechNote } from '@/components/kit';
import { requireMentor } from '@/lib/auth';
import {
  leaveActor,
  listOwnRequests,
  loadApprovalQueue,
  previewApprovers,
} from '@/lib/leave/queries';
import {
  MAX_BACKDATED_DAYS,
  MAX_LEAVE_DAYS,
  leaveDayISO,
  openStage,
} from '@/lib/leave/rules';

import { applyForLeaveAction, withdrawLeaveAction } from './actions';
import { LeaveForm } from './leave-form';
import { LeaveRequestCard } from './request-card';
import { WithdrawButton } from './withdraw-button';

export const metadata = { title: 'Leave — Mentor' };
export const dynamic = 'force-dynamic';

const MS_PER_DAY = 86_400_000;

/**
 * Apply for leave, and see what happened to everything you have applied for.
 *
 * Deciding somebody else's leave is a different job with a different queue, and
 * it lives at `/mentor/leave/approvals`. Putting both on one screen would mean a
 * mentor scanning for the request they have to sign has to read past their own,
 * and the two have opposite empty states — "you have asked for nothing" is
 * unremarkable, "nothing is waiting on you" is the good outcome.
 */
export default async function MentorLeavePage() {
  const session = await requireMentor();
  const standing = leaveActor(session);

  if (!standing.ok) {
    return (
      <>
        <PageIntro title="Leave" subtitle="Apply, and follow the two signatures it needs." />
        <EmptyState title="This account cannot use the leave desk." hint={standing.reason} />
        <LeaveTechNote />
      </>
    );
  }

  const [mine, queue, approvers] = await Promise.all([
    listOwnRequests(standing.userId),
    loadApprovalQueue(standing.userId),
    previewApprovers(standing.userId),
  ]);

  const now = new Date();
  const live = mine.filter((row) => openStage(row.status) !== null);
  const approved = mine.filter((row) => row.status === 'APPROVED');
  const daysApproved = approved.reduce((sum, row) => sum + row.days, 0);

  return (
    <>
      <PageIntro
        title="Leave"
        subtitle="Every request is signed twice, in order: your first approver reads it, and only then does the programme office see it."
        action={
          <Button href="/mentor/leave/approvals" variant="contained" color="secondary">
            {queue.awaiting.length > 0
              ? `Approvals waiting on you (${queue.awaiting.length})`
              : 'Approvals queue'}
          </Button>
        }
      />

      {queue.awaiting.length > 0 && (
        <InfoBanner
          tone="warning"
          title={`${queue.awaiting.length} request${queue.awaiting.length === 1 ? '' : 's'} waiting on your signature`}
          action={
            <Button size="small" href="/mentor/leave/approvals">
              Open the queue
            </Button>
          }
        >
          Somebody cannot plan their week until you have read it.
        </InfoBanner>
      )}

      <Grid container spacing={2.5} sx={{ mb: 5 }}>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard label="Your requests" value={mine.length} hint="Ever applied for" />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="In flight"
            value={live.length}
            tone={live.length > 0 ? 'info' : 'neutral'}
            hint="Awaiting one of the two signatures"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard label="Days approved" value={daysApproved} hint="Across every approved request" />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Waiting on you"
            value={queue.awaiting.length}
            tone={queue.awaiting.length > 0 ? 'warning' : 'neutral'}
            hint="Other people's requests"
          />
        </Grid>
      </Grid>

      <Grid container columnSpacing={6}>
        <Grid size={{ xs: 12, lg: 6 }}>
          <SectionCard
            title="Apply for leave"
            subtitle={`Up to ${MAX_LEAVE_DAYS} days, and backdated by at most ${MAX_BACKDATED_DAYS} for leave written up after the fact`}
          >
            <LeaveForm
              applyAction={applyForLeaveAction}
              todayISO={leaveDayISO(now)}
              earliestISO={leaveDayISO(new Date(now.getTime() - MAX_BACKDATED_DAYS * MS_PER_DAY))}
              latestISO={leaveDayISO(new Date(now.getTime() + 365 * MS_PER_DAY))}
              firstApproverName={approvers.firstName}
              secondApproverName={approvers.secondName}
              routingError={approvers.routing.ok ? null : approvers.routing.reason}
            />
          </SectionCard>
        </Grid>

        <Grid size={{ xs: 12, lg: 6 }}>
          <SectionCard title="Your requests" subtitle="Newest first">
            {mine.length === 0 ? (
              <EmptyState
                title="You have not applied for any leave."
                hint="Anything you apply for appears here with both signatures on it, so you can see exactly where it has got to."
              />
            ) : (
              mine.map((row) => (
                <LeaveRequestCard
                  key={row.id}
                  row={row}
                  action={
                    openStage(row.status) ? (
                      <WithdrawButton requestId={row.id} withdrawAction={withdrawLeaveAction} />
                    ) : null
                  }
                />
              ))
            )}
          </SectionCard>
        </Grid>
      </Grid>

      <LeaveTechNote />
    </>
  );
}

function LeaveTechNote() {
  return (
    <TechNote>
      A leave request is not an <code>approved</code> boolean. It carries two named
      approvers, a verdict and a timestamp for each of them, and a status that says
      which signature it is waiting on — so the record shows that the mentor
      recommended it and the programme office did not, rather than only that it ended
      up refused. The routing is worked out in{' '}
      <code>src/lib/leave/rules.ts</code>: the first signature goes to the mentor group&rsquo;s
      recorded approver, else to its own mentor, else to a director, and nobody ever
      signs their own leave — which is what happens when a mentor applies here. The
      second goes to a director who is neither the requester nor the first approver,
      and is named when the first signature lands rather than at submission, because
      until then &ldquo;any director&rdquo; is a role and not a person. Dates are
      <code>@db.Date</code> columns, so they are parsed and printed in UTC; a decision
      timestamp is a real moment and is printed in local time.
    </TechNote>
  );
}
