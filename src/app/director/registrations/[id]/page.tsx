import { notFound } from 'next/navigation';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import {
  EmptyState,
  Fact,
  InfoBanner,
  PageIntro,
  SectionCard,
  StatusChip,
  Surface,
  TechNote,
} from '@/components/kit';
import { requireRole } from '@/lib/auth';
import { loadRegistrationDetail } from '@/lib/registration/queries';

import { DecisionPanel } from './decision-panel';
import { STATUS_LABEL, STATUS_TONE, isOpen } from '../status';

export const metadata = { title: 'Registration — Director' };
export const dynamic = 'force-dynamic';

/**
 * One application, everything about it, and the decision.
 *
 * The order on the page is the order a reviewer works in: what the applicant
 * said, what a rule made of it, what the document actually contains, and only
 * then the buttons. The parsed CV sits above the decision rather than beside it
 * because it is the evidence — the commonest thing this screen has to settle is
 * whether the USN on the form matches the one on the CV, and that comparison
 * should not require scrolling.
 */
export default async function RegistrationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole('DIRECTOR', 'ADMIN');

  const { id } = await params;
  const detail = await loadRegistrationDetail(id);
  if (!detail) notFound();

  const { row, bundle, cohorts } = detail;
  const open = isOpen(row.status);
  const fileHref = (name: string) => `/api/register/file/${bundle?.token}/${name}`;

  return (
    <>
      <PageIntro
        title={row.name}
        subtitle={
          <>
            Applied {row.createdAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}.{' '}
            {row.emailVerifiedAt
              ? `Address confirmed ${row.emailVerifiedAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}.`
              : 'The address has not been confirmed yet.'}
          </>
        }
        action={
          <Button href="/director/registrations" size="small">
            Back to the queue
          </Button>
        }
      />

      <Box sx={{ mb: 4 }}>
        <StatusChip tone={STATUS_TONE[row.status]} label={STATUS_LABEL[row.status]} size="medium" />
      </Box>

      {row.decisionReason ? (
        <InfoBanner
          tone={row.status === 'PENDING_REVIEW' ? 'warning' : 'info'}
          title={row.matchedRuleName ? `Rule: ${row.matchedRuleName}` : 'No rule matched'}
        >
          {row.decisionReason}
        </InfoBanner>
      ) : null}

      <SectionCard title="What they told us">
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <Fact label="Email" value={row.email} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <Fact label="Phone" value={row.phone ?? '—'} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <Fact label="USN as submitted" value={row.usn ?? 'Not issued yet'} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <Fact label="Degree level" value={row.degreeLevel} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <Fact label="Programme" value={row.programme ?? '—'} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <Fact label="Branch" value={row.branch ?? '—'} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <Fact label="City" value={row.city ?? '—'} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <Fact
              label="LinkedIn"
              value={
                row.linkedinUrl ? (
                  // Normalised by `schema.ts` to a linkedin.com/in/ URL before it
                  // was ever stored, so this href cannot be a scheme of the
                  // applicant's choosing.
                  <Link href={row.linkedinUrl} target="_blank" rel="noopener noreferrer nofollow">
                    {row.linkedinUrl.replace('https://www.', '')}
                  </Link>
                ) : (
                  '—'
                )
              }
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <Fact label="Cohort applied for" value={row.cohortName ?? 'Not decided'} />
          </Grid>
        </Grid>
      </SectionCard>

      <SectionCard
        title="Uploaded documents"
        subtitle="Held in quarantine — not in the student file store — until this application is approved. Only DIRECTOR and ADMIN can open them."
      >
        {!bundle || (!bundle.cv && !bundle.photo) ? (
          <EmptyState
            title="Nothing attached"
            hint="They filled the form in by hand. That is a normal path and says nothing about the application."
          />
        ) : (
          <Grid container spacing={3}>
            {bundle.photo ? (
              <Grid size={{ xs: 12, sm: 5, md: 4 }}>
                <Surface>
                  <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
                    Professional photo
                  </Typography>
                  <Box
                    component="img"
                    src={fileHref(bundle.photo.storedName)}
                    alt={`Photo submitted by ${row.name}`}
                    sx={{
                      display: 'block',
                      width: '100%',
                      maxWidth: 240,
                      borderRadius: 1.5,
                      border: 1,
                      borderColor: 'divider',
                    }}
                  />
                  <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1 }}>
                    {bundle.photo.originalName}
                  </Typography>
                </Surface>
              </Grid>
            ) : null}

            {bundle.cv ? (
              <Grid size={{ xs: 12, sm: 7, md: 8 }}>
                <Surface>
                  <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
                    CV
                  </Typography>
                  <Typography variant="subtitle1">{bundle.cv.originalName}</Typography>
                  <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.25 }}>
                    {bundle.cv.mimeType} · {(bundle.cv.sizeBytes / 1024).toFixed(0)} KB
                  </Typography>
                  <Button
                    size="small"
                    href={fileHref(bundle.cv.storedName)}
                    target="_blank"
                    rel="noopener noreferrer"
                    sx={{ mt: 1.5 }}
                  >
                    Open the CV
                  </Button>
                </Surface>
              </Grid>
            ) : null}
          </Grid>
        )}
      </SectionCard>

      {bundle?.parsed ? (
        <SectionCard
          title="What we read out of the CV"
          subtitle="Pattern matching on this machine. It filled the form; the applicant then checked it, so a difference between this and the answers above is worth a look."
        >
          <Grid container spacing={4}>
            <Grid size={{ xs: 12, md: 7 }}>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
                Education
              </Typography>
              {bundle.parsed.education.length === 0 ? (
                <Typography variant="body2" color="text.disabled">
                  Nothing recognisable as an education section.
                </Typography>
              ) : (
                <Stack spacing={1}>
                  {bundle.parsed.education.map((entry, index) => (
                    <Box key={`${entry.degree}-${index}`}>
                      <Typography variant="subtitle1">{entry.degree || 'Unnamed qualification'}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {[entry.institution, entry.year, entry.score].filter(Boolean).join(' · ') || '—'}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              )}
            </Grid>
            <Grid size={{ xs: 12, md: 5 }}>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
                Skills claimed
              </Typography>
              {bundle.parsed.skills.length === 0 ? (
                <Typography variant="body2" color="text.disabled">
                  No skills section found.
                </Typography>
              ) : (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                  {bundle.parsed.skills.slice(0, 24).map((skill) => (
                    <Chip key={skill} label={skill} size="small" variant="outlined" />
                  ))}
                </Box>
              )}
              <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1.5 }}>
                These are written to the free-text profile field, never to the skill
                catalogue. A string lifted off a CV is a claim; the catalogue is for claims
                that have been through evidence.
              </Typography>
            </Grid>
          </Grid>
        </SectionCard>
      ) : null}

      <SectionCard title={open ? 'Decision' : 'How this was settled'}>
        {open ? (
          <DecisionPanel
            registrationId={row.id}
            cohorts={cohorts}
            suggestedCohortId={cohorts.find((cohort) => cohort.name === row.cohortName)?.id ?? null}
            suggestedUsn={row.usn ?? ''}
            emailVerified={row.emailVerifiedAt !== null}
          />
        ) : (
          <Grid container spacing={3}>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <Fact
                label="Decided"
                value={
                  row.reviewedAt
                    ? row.reviewedAt.toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric',
                      })
                    : 'By rule, on confirmation'
                }
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <Fact
                label="By"
                value={row.status === 'AUTO_APPROVED' ? 'A registration rule' : 'A member of the programme office'}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <Fact label="Student record" value={row.approvedStudentId ? 'Created' : 'None'} />
            </Grid>
            {row.reviewNote ? (
              <Grid size={12}>
                <Fact label="Note" value={row.reviewNote} />
              </Grid>
            ) : null}
          </Grid>
        )}
      </SectionCard>

      <TechNote>
        The photo and the CV are served by <code>/api/register/file/[token]/[name]</code>,
        which checks the session role itself rather than relying on middleware — middleware
        only ever tests that a cookie is present. The manifest, not the URL, decides which
        two names are readable, and the response carries{' '}
        <code>Content-Security-Policy: sandbox</code> and <code>nosniff</code> because the
        uploader was anonymous and the reader is you. Approving promotes both files through{' '}
        <code>saveUpload</code>, so they are re-sniffed on the way into the student file
        store rather than trusted because they passed once.
      </TechNote>
    </>
  );
}
