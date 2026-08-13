import { notFound } from 'next/navigation';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded';

import {
  EmptyState,
  Fact,
  InfoBanner,
  MeterRow,
  PageIntro,
  SectionCard,
  StatusChip,
  TechNote,
} from '@/components/kit';
import {
  isAiResumeEnabled,
  resumeModelHost,
  resumeModelId,
  resumeWriterBlocked,
} from '@/lib/ai/resume';
import { requireStudent } from '@/lib/auth';
import { applicationState } from '@/lib/jobs/application';
import { getJobForStudent, skillNamesFor } from '@/lib/jobs/board';
import { jobBrief } from '@/lib/jobs/brief';
import { matchJob, matchSummary } from '@/lib/jobs/match';
import { relativeDay } from '@/lib/reep';

import { CvForm } from './cv-form';

export const metadata = { title: 'CV for this job — Student' };
export const dynamic = 'force-dynamic';

const FULL_DATE: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
};

export default async function JobCvPage({ params }: { params: Promise<{ id: string }> }) {
  const { studentId } = await requireStudent();
  const { id } = await params;

  const data = await getJobForStudent(studentId, id);
  if (!data) notFound();

  const { job, catalogue, held, application, lastIndustry, resumes } = data;
  const match = matchJob(job, catalogue, held);
  const summary = matchSummary(match);
  const brief = jobBrief(job, await skillNamesFor(job.requiredSkills));
  const state = applicationState(application);

  const aiEnabled = isAiResumeEnabled();
  const modelHost = resumeModelHost();
  const writerBlocked = resumeWriterBlocked();

  return (
    <>
      <PageIntro
        title={job.title}
        subtitle={`${job.company}${job.location ? ` · ${job.location}` : ''} · posted ${relativeDay(job.postedOn).toLowerCase()}`}
        action={
          <Stack direction="row" spacing={1.5}>
            <Button href="/student/jobs" variant="outlined">
              Back to jobs
            </Button>
            {job.applyUrl && (
              <Button
                href={job.applyUrl}
                target="_blank"
                rel="noopener noreferrer"
                endIcon={<OpenInNewRounded />}
              >
                Open the posting
              </Button>
            )}
          </Stack>
        }
      />

      {/* The same four banners the resume screen shows, in the same order and
          the same words. A student who reads "your record is not leaving this
          machine" there and nothing here would reasonably assume this path is
          different, and the whole point is that it is not. */}
      {!aiEnabled && (
        <InfoBanner title="A rule-based writer is doing the drafting today">
          No model is configured, so REEP composes your CV deterministically from your
          records instead. Every section still fills in and the evidence rules are the
          same.
        </InfoBanner>
      )}

      {modelHost === 'local' && (
        <InfoBanner tone="good" title="Your record is not leaving this machine">
          The draft is written by <code>{resumeModelId()}</code> running locally, so your
          name, USN, marks and attendance are never sent to anyone else&rsquo;s server.
        </InfoBanner>
      )}

      {writerBlocked && (
        <InfoBanner
          tone="warning"
          title="A model is configured, but it is not on this machine"
        >
          <code>{resumeModelId()}</code> runs on{' '}
          {modelHost === 'anthropic' ? "Anthropic's servers" : 'another machine'}, so REEP
          will not send it your name, USN, marks or attendance. Your CV is composed
          deterministically from your records instead — every section still fills in and
          the evidence rules are the same. An administrator can allow the model to be used
          by setting <code>LLM_ALLOW_REMOTE_STUDENT_DATA</code> in <code>.env</code>. The
          posting itself is public and is sent either way.
        </InfoBanner>
      )}

      {modelHost === 'remote' && !writerBlocked && (
        <InfoBanner tone="warning" title="Your record is sent to a third-party model">
          <code>{resumeModelId()}</code> is hosted elsewhere, and your name, USN, marks and
          attendance are sent to it to write the draft. Your administrator has allowed
          this.
        </InfoBanner>
      )}

      {modelHost === 'anthropic' && !writerBlocked && (
        <InfoBanner tone="warning" title="Your record is sent to Anthropic">
          The draft is written by <code>{resumeModelId()}</code>, so your name, USN, marks
          and attendance leave this machine to produce it. Your administrator has allowed
          this.
        </InfoBanner>
      )}

      <Grid container spacing={{ xs: 0, lg: 5 }}>
        {/* --- the posting ------------------------------------------------ */}
        <Grid size={{ xs: 12, lg: 7 }}>
          <SectionCard
            title="What the draft is written against"
            subtitle="Exactly the text handed to the writer. You do not have to paste anything."
          >
            <Grid container spacing={2.5} sx={{ mb: 3 }}>
              <Grid size={{ xs: 6, sm: 4 }}>
                <Fact label="Degree level" value={job.degreeLevel === 'UG' ? 'Undergraduate' : 'Post Graduate'} />
              </Grid>
              <Grid size={{ xs: 6, sm: 4 }}>
                <Fact
                  label="Closes"
                  value={
                    job.closesOn
                      ? job.closesOn.toLocaleDateString('en-IN', FULL_DATE)
                      : 'No closing date'
                  }
                />
              </Grid>
              <Grid size={{ xs: 6, sm: 4 }}>
                <Fact
                  label="You have"
                  value={
                    state === 'applied'
                      ? 'said you applied'
                      : state === 'opened'
                        ? 'opened the posting'
                        : 'not applied yet'
                  }
                />
              </Grid>
            </Grid>

            <Box
              sx={{
                bgcolor: 'background.paper',
                border: 1,
                borderColor: 'divider',
                borderRadius: 2,
                p: 2.5,
                whiteSpace: 'pre-wrap',
              }}
            >
              <Typography variant="body2" color="text.secondary">
                {brief}
              </Typography>
            </Box>
          </SectionCard>

          <SectionCard
            title="How you match it"
            subtitle="Verified skills only — the same arithmetic as the Match column on the board"
          >
            {match.kind === 'scored' ? (
              <Stack spacing={3}>
                <MeterRow
                  label="Skill match"
                  value={match.pct}
                  tone={match.band === 'strong' ? 'good' : match.band === 'fair' ? 'info' : 'neutral'}
                  labelWidth={96}
                />
                <Typography variant="body2" color="text.secondary">
                  {summary.hint}
                </Typography>

                <Box>
                  <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                    Verified and asked for
                  </Typography>
                  {match.matched.length === 0 ? (
                    <Typography variant="body2" color="text.disabled">
                      None yet.
                    </Typography>
                  ) : (
                    <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                      {match.matched.map((skill) => (
                        <Chip
                          key={skill.slug}
                          size="small"
                          color="success"
                          variant="outlined"
                          label={`${skill.name} · level ${skill.level}`}
                        />
                      ))}
                    </Stack>
                  )}
                </Box>

                {match.unverified.length > 0 && (
                  <Box>
                    <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                      Held but not verified — worth {match.potentialPct - match.pct} points
                    </Typography>
                    <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                      {match.unverified.map((skill) => (
                        <Chip key={skill.slug} size="small" variant="outlined" label={skill.name} />
                      ))}
                    </Stack>
                  </Box>
                )}

                {match.missing.length > 0 && (
                  <Box>
                    <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                      Asked for, not on your record
                    </Typography>
                    <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                      {match.missing.map((demand) => (
                        <Chip
                          key={demand.slug}
                          size="small"
                          variant="outlined"
                          label={demand.name}
                          sx={{ opacity: demand.source === 'required' ? 1 : 0.65 }}
                        />
                      ))}
                    </Stack>
                    <Typography variant="caption" color="text.disabled" sx={{ mt: 1, display: 'block' }}>
                      Faded ones were only mentioned in the description, not listed as
                      requirements.
                    </Typography>
                  </Box>
                )}
              </Stack>
            ) : (
              <EmptyState
                title={summary.label}
                hint={summary.hint}
                action={
                  match.kind === 'no-skills' ? (
                    <Button href="/student/profile" size="small" variant="outlined">
                      Add my skills
                    </Button>
                  ) : match.kind === 'nothing-verified' ? (
                    <Button href="/student/uploads" size="small" variant="outlined">
                      Upload evidence
                    </Button>
                  ) : undefined
                }
              />
            )}
          </SectionCard>
        </Grid>

        {/* --- the builder ------------------------------------------------- */}
        <Grid size={{ xs: 12, lg: 5 }}>
          <SectionCard
            title="Build a CV for this job"
            subtitle="The posting above is already loaded. Two fields and you are done."
          >
            <CvForm
              jobId={job.id}
              defaultRole={job.title}
              defaultIndustry={lastIndustry ?? undefined}
              modelHint={
                writerBlocked
                  ? 'Composed from your records, so this is quick'
                  : modelHost === 'local'
                    ? `${resumeModelId()} runs on this machine, so expect about a minute`
                    : modelHost === 'remote' || modelHost === 'anthropic'
                      ? `${resumeModelId()}`
                      : undefined
              }
            />
          </SectionCard>

          <SectionCard
            title="CVs you have written for this posting"
            subtitle="Filed against this vacancy, so you can find them again"
          >
            {resumes.length === 0 ? (
              <EmptyState
                title="None yet."
                hint="The first draft takes a few seconds without a model, or about a minute with a local one."
              />
            ) : (
              <List disablePadding>
                {resumes.map((resume, index) => (
                  <ListItem
                    key={resume.id}
                    disablePadding
                    sx={{ borderTop: index === 0 ? 0 : 1, borderColor: 'divider' }}
                  >
                    <ListItemButton
                      href={`/student/resume/${resume.id}`}
                      sx={{ px: 1.5, mx: -1.5, py: 1.75, width: 'auto', flex: 1 }}
                    >
                      <Stack
                        direction="row"
                        spacing={2}
                        sx={{ width: '100%', alignItems: 'center' }}
                      >
                        <Typography
                          variant="subtitle2"
                          color="text.secondary"
                          className="tabular"
                          sx={{ width: 44, flexShrink: 0 }}
                        >
                          v{resume.version}
                        </Typography>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography variant="subtitle1" noWrap>
                            {resume.title}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" className="tabular">
                            {resume.createdAt.toLocaleDateString('en-IN', FULL_DATE)}
                          </Typography>
                        </Box>
                        <StatusChip
                          tone="neutral"
                          label={resume.generatedBy === 'fallback' ? 'Rule-based' : 'Model'}
                        />
                      </Stack>
                    </ListItemButton>
                  </ListItem>
                ))}
              </List>
            )}
          </SectionCard>
        </Grid>
      </Grid>

      <TechNote>
        This screen does not contain a second resume generator. It composes the posting
        into the same <code>jobDescription</code> the Resume Builder accepts as pasted
        text — <code>src/lib/jobs/brief.ts</code> — and hands it to the same{' '}
        <code>createResumeVersion</code>, so there is one writer, one evidence rule and
        one set of banners about where your record goes. The only thing the route adds
        afterwards is <code>Resume.jobId</code>, which is what lets this page list the
        drafts written for this vacancy and only this vacancy. The description is read
        from the <code>Job</code> row on the server rather than posted from this page: a
        posting that travelled through the browser could come back edited, and the draft
        would then be tailored to a vacancy that does not exist. The percentage above is
        the same pure function the board&apos;s Match column uses, so the two can never
        disagree.
      </TechNote>
    </>
  );
}
