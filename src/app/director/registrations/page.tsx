import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { EmptyState, PageIntro, SectionCard, StatCard, StatusChip, TechNote } from '@/components/kit';
import { requireRole } from '@/lib/auth';
import { loadRegistrationQueue, loadRules } from '@/lib/registration/queries';

import { RulePanel } from './rule-panel';
import { STATUS_LABEL, STATUS_TONE } from './status';

export const metadata = { title: 'Registrations — Director' };
export const dynamic = 'force-dynamic';

/**
 * The review queue.
 *
 * DIRECTOR and ADMIN only, and not because reviewing is unusually sensitive: an
 * applicant is not a student yet, so they belong to no mentor group, so
 * `mentorScope()` genuinely has no answer about them. Narrowing this screen by
 * mentee would show every mentor an empty page, and widening it would show every
 * mentor every stranger's CV and phone number. Programme-office work, decided by
 * role — the rule `mentor-scope.ts` exists to state.
 *
 * The page is arranged by *what is owed to whom*, not by status: applications a
 * director has to act on first, then the ones waiting on the applicant, then the
 * rules that are quietly deciding the rest, then the audit trail. The rules panel
 * is on this screen rather than a settings page for the same reason — the
 * commonest question a queue provokes is "why did this one land here?", and the
 * answer is directly underneath it.
 */
export default async function RegistrationsPage() {
  await requireRole('DIRECTOR', 'ADMIN');

  const [queue, rules] = await Promise.all([loadRegistrationQueue(), loadRules()]);

  const needsDecision = queue.waiting.filter((row) => row.status === 'PENDING_REVIEW');
  const awaitingApplicant = queue.waiting.filter((row) => row.status !== 'PENDING_REVIEW');

  return (
    <>
      <PageIntro
        title="Registrations"
        subtitle="Applications from people who are not students yet. A confirmed college address matching an open intake becomes an account without passing through here; everything else does."
      />

      <Grid container spacing={4} sx={{ mb: 5 }}>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Needs a decision"
            value={queue.counts.awaitingReview}
            tone={queue.counts.awaitingReview > 0 ? 'warning' : 'good'}
            hint="Address confirmed, no rule settled it"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Waiting on applicant"
            value={queue.counts.awaitingEmail}
            hint="Confirmation link not clicked yet"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard label="Approved" value={queue.counts.approved} tone="good" hint="By rule or by hand" />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard label="Rejected" value={queue.counts.rejected} tone="neutral" />
        </Grid>
      </Grid>

      <SectionCard
        title="Needs a decision"
        subtitle="The address is proven. What is left is a judgement no rule was willing to make."
      >
        {needsDecision.length === 0 ? (
          <EmptyState
            title="Nothing waiting"
            hint="Every confirmed application has either been approved by a rule or already been read."
          />
        ) : (
          <Stack spacing={0}>
            {needsDecision.map((row) => (
              <ApplicationRow key={row.id} row={row} />
            ))}
          </Stack>
        )}
      </SectionCard>

      <SectionCard
        title="Waiting on the applicant"
        subtitle="Submitted, but the confirmation link in their inbox has not been clicked. Nothing is decided until it is."
      >
        {awaitingApplicant.length === 0 ? (
          <EmptyState title="Nobody is mid-application" />
        ) : (
          <Stack spacing={0}>
            {awaitingApplicant.map((row) => (
              <ApplicationRow key={row.id} row={row} />
            ))}
          </Stack>
        )}
      </SectionCard>

      <SectionCard
        title="Rules in force"
        subtitle="Every populated condition on a rule has to match — the email domain and the intake the seat number belongs to. The lowest priority among the matches decides."
      >
        <RulePanel rules={rules} />
      </SectionCard>

      <SectionCard title="Recently settled" subtitle="The last 40 decisions, whoever or whatever made them.">
        {queue.settled.length === 0 ? (
          <EmptyState title="No decisions yet" />
        ) : (
          <Stack spacing={0}>
            {queue.settled.map((row) => (
              <ApplicationRow key={row.id} row={row} />
            ))}
          </Stack>
        )}
      </SectionCard>

      <TechNote>
        The programme, branch, city and LinkedIn link an applicant gives have no column on{' '}
        <code>registrations</code> — that table is owned by the schema stage — so they are
        held in the quarantine manifest beside the uploaded CV and photo, which is the
        same place the review screen has to open anyway. Approval runs one{' '}
        <code>prisma.$transaction</code>: <code>User</code>, <code>Student</code>, the
        promoted <code>Upload</code> rows, then <code>StudentProfile</code> with{' '}
        <code>photoUploadId</code> pointing at the promoted photo. The file copies happen
        inside it, so a disk error rolls the whole thing back rather than leaving a{' '}
        <code>User</code> that can sign in to nothing. Nothing is moved — the quarantined
        original stays put until the seven-day sweep.
      </TechNote>
    </>
  );
}

/**
 * One line of the queue.
 *
 * The reason a rule gave is on the row rather than behind the link, because it is
 * what makes triage possible: a director scanning ten of these is deciding which
 * ones need opening, and "personal email address and no USN issued yet" answers
 * that where a status chip does not.
 */
function ApplicationRow({
  row,
}: {
  row: Awaited<ReturnType<typeof loadRegistrationQueue>>['waiting'][number];
}) {
  return (
    <Box
      sx={{
        py: 2,
        borderBottom: 1,
        borderColor: 'divider',
        display: 'flex',
        gap: 2,
        alignItems: 'flex-start',
        flexWrap: 'wrap',
        '&:last-of-type': { borderBottom: 0 },
      }}
    >
      <Box sx={{ minWidth: 0, flex: '1 1 320px' }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="subtitle1">{row.name}</Typography>
          <StatusChip tone={STATUS_TONE[row.status]} label={STATUS_LABEL[row.status]} />
          {row.hasCv ? <StatusChip tone="neutral" label="CV" variant="outlined" /> : null}
          {row.hasPhoto ? <StatusChip tone="neutral" label="Photo" variant="outlined" /> : null}
        </Stack>

        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {row.email}
          {row.usn ? ` · ${row.usn}` : ''}
          {row.programme ? ` · ${row.programme}` : ''}
          {row.branch ? ` (${row.branch})` : ''}
        </Typography>

        {row.decisionReason ? (
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.5, maxWidth: '76ch' }}>
            {row.decisionReason}
          </Typography>
        ) : null}
      </Box>

      <Stack spacing={0.5} sx={{ alignItems: { xs: 'flex-start', sm: 'flex-end' }, flexShrink: 0 }}>
        <Typography variant="caption" color="text.disabled" className="tabular">
          {row.createdAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
        </Typography>
        <Button size="small" href={`/director/registrations/${row.id}`}>
          Open
        </Button>
      </Stack>
    </Box>
  );
}
