import { notFound } from 'next/navigation';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
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
import { normaliseProfile, profileGaps } from '@/lib/ai/profile';
import { readResumeScoring } from '@/lib/ai/read';
import {
  isAiResumeEnabled,
  resumeModelHost,
  resumeModelId,
  resumeWriterBlocked,
} from '@/lib/ai/resume';
import { requireStudent } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getResumeContext } from '@/lib/queries';
import { STAGE_LABEL, formatHours, formatPct, relativeDay } from '@/lib/reep';
import { formatBytes } from '@/lib/uploads';

import { GeneratorForm } from './generator-form';

export const metadata = { title: 'Resume Builder — Student' };
export const dynamic = 'force-dynamic';

const MONTH_YEAR: Intl.DateTimeFormatOptions = { month: 'short', year: 'numeric' };
const FULL_DATE: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
};

export default async function ResumeBuilderPage() {
  const { studentId } = await requireStudent();

  const [data, cv] = await Promise.all([
    getResumeContext(studentId),
    // The Resume-kind upload is not part of the resume context, because the
    // generator does not read file bytes — it is surfaced here so a student who
    // already has a CV can work from it.
    prisma.upload.findFirst({
      where: { studentId, kind: 'RESUME' },
      orderBy: { uploadedAt: 'desc' },
    }),
  ]);
  if (!data) notFound();

  const {
    student,
    resumes,
    completedCerts,
    inProgressCerts,
    stages,
    overallPct,
    attendancePct,
    focus,
    totalLoggedHours,
  } = data;

  const gaps = profileGaps(normaliseProfile(data.profile));
  const aiEnabled = isAiResumeEnabled();
  const modelHost = resumeModelHost();
  const writerBlocked = resumeWriterBlocked();
  const lastResume = resumes[0];

  return (
    <>
      <PageIntro
        title="Resume Builder"
        subtitle="Tell us the job you are aiming at. REEP writes the draft from the record it already holds on you."
        action={
          <Button href="/student/profile" variant="outlined">
            My profile
          </Button>
        }
      />

      {!aiEnabled && (
        <InfoBanner title="A rule-based writer is doing the drafting today">
          No model is configured, so REEP composes your resume deterministically
          from your records instead. Every section still fills in and the evidence
          rules are the same. Set <code>LLM_BASE_URL</code> and{' '}
          <code>LLM_MODEL</code> in <code>.env</code> and the wording comes from a
          model instead.
        </InfoBanner>
      )}

      {modelHost === 'local' && (
        <InfoBanner tone="good" title="Your record is not leaving this machine">
          The draft is written by <code>{resumeModelId()}</code> running locally, so
          your name, USN, marks and attendance are never sent to anyone else&rsquo;s
          server.
        </InfoBanner>
      )}

      {/* The refusal covers a hosted LLM_BASE_URL and Anthropic alike — both are
          somebody else's machine, and the student does not care which variable
          named it — so this banner is deliberately written for either. */}
      {writerBlocked && (
        <InfoBanner
          tone="warning"
          title="A model is configured, but it is not on this machine"
        >
          <code>{resumeModelId()}</code> runs on{' '}
          {modelHost === 'anthropic' ? "Anthropic's servers" : 'another machine'}, so
          REEP will not send it your name, USN, marks or attendance. Your draft is
          composed deterministically from your records instead — every section still
          fills in and the evidence rules are the same. An administrator can allow the
          model to be used by setting{' '}
          <code>LLM_ALLOW_REMOTE_STUDENT_DATA</code> in <code>.env</code>.
        </InfoBanner>
      )}

      {modelHost === 'remote' && !writerBlocked && (
        <InfoBanner tone="warning" title="Your record is sent to a third-party model">
          <code>{resumeModelId()}</code> is hosted elsewhere, and your name, USN,
          marks and attendance are sent to it to write the draft. Your
          administrator has allowed this. A locally-run model keeps the same
          record on this machine.
        </InfoBanner>
      )}

      {/* `!writerBlocked` is not decoration: without it this rendered alongside
          the refusal banner above, telling the student their record had been
          sent to Anthropic when it had not — the mirror image of the bug that
          sent it while saying nothing. */}
      {modelHost === 'anthropic' && !writerBlocked && (
        <InfoBanner tone="warning" title="Your record is sent to Anthropic">
          The draft is written by <code>{resumeModelId()}</code>, so your name, USN,
          marks and attendance leave this machine to produce it. Your administrator
          has allowed this.
        </InfoBanner>
      )}

      {gaps.length > 0 && (
        <InfoBanner
          tone="warning"
          title="Your profile is missing a few things"
          action={
            <Button href="/student/profile" size="small" color="inherit">
              Fill it in
            </Button>
          }
        >
          REEP cannot observe {listInWords(gaps)}, so those sections will be left
          out. You can still generate a resume right now — add the details later and
          run it again.
        </InfoBanner>
      )}

      <Grid container spacing={{ xs: 0, lg: 5 }}>
        {/* --- everything REEP already holds ------------------------------ */}
        <Grid size={{ xs: 12, lg: 7 }}>
          <SectionCard
            title="What we already know about you"
            subtitle="Read live from your REEP record every time you generate. You type none of it."
          >
            <Grid container spacing={2.5}>
              <Grid size={{ xs: 6, sm: 4 }}>
                <Fact label="Programme complete" value={formatPct(overallPct)} />
              </Grid>
              <Grid size={{ xs: 6, sm: 4 }}>
                <Fact label="Certifications done" value={`${completedCerts.length}`} />
              </Grid>
              <Grid size={{ xs: 6, sm: 4 }}>
                <Fact label="Hours logged" value={formatHours(totalLoggedHours)} />
              </Grid>
              <Grid size={{ xs: 6, sm: 4 }}>
                <Fact label="Attendance" value={formatPct(attendancePct)} />
              </Grid>
              <Grid size={{ xs: 6, sm: 4 }}>
                <Fact label="Focus score" value={`${focus.focusScore.toFixed(0)} / 100`} />
              </Grid>
              <Grid size={{ xs: 6, sm: 4 }}>
                <Fact label="Still in progress" value={`${inProgressCerts.length}`} />
              </Grid>
            </Grid>

            <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 4, mb: 2 }}>
              Stage progress
            </Typography>
            <Stack spacing={2.5}>
              {stages.map((stage) => (
                <MeterRow
                  key={stage.stage}
                  label={STAGE_LABEL[stage.stage]}
                  value={stage.pct}
                  tone="neutral"
                  labelWidth={124}
                />
              ))}
            </Stack>

            <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 4, mb: 1 }}>
              Certifications the resume can quote
            </Typography>
            {completedCerts.length === 0 ? (
              <EmptyState
                title="No completed certifications yet."
                hint="The draft will lead with your stage progress and logged hours instead."
              />
            ) : (
              <Stack>
                {completedCerts.map((entry) => (
                  <Stack
                    key={entry.certCode}
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={{ xs: 0.25, sm: 2 }}
                    sx={{
                      py: 1.5,
                      alignItems: { sm: 'baseline' },
                      borderTop: 1,
                      borderColor: 'divider',
                    }}
                  >
                    <Typography variant="body2" sx={{ flex: 1, fontWeight: 500 }}>
                      {entry.cert.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" className="tabular">
                      {entry.cert.provider} · {entry.cert.requiredHours}h ·{' '}
                      {entry.cert.courseCode}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      className="tabular"
                      sx={{ width: { sm: 84 }, textAlign: { sm: 'right' }, flexShrink: 0 }}
                    >
                      {entry.completedAt
                        ? entry.completedAt.toLocaleDateString('en-IN', MONTH_YEAR)
                        : '—'}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            )}
          </SectionCard>
        </Grid>

        {/* --- the brief -------------------------------------------------- */}
        <Grid size={{ xs: 12, lg: 5 }}>
          <SectionCard
            title="Write a new resume"
            subtitle={`Two fields is enough. ${STAGE_LABEL[student.currentStage]} stage, semester ${student.currentSemester}.`}
          >
            <GeneratorForm
              defaultRole={lastResume?.targetRole ?? undefined}
              defaultIndustry={lastResume?.targetIndustry ?? undefined}
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

          {cv && (
            <SectionCard title="The CV you uploaded">
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="subtitle1" noWrap>
                  {cv.originalName}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatBytes(cv.sizeBytes)} · uploaded {relativeDay(cv.uploadedAt)}
                </Typography>
              </Box>

              <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                The builder writes from your REEP record, not from this file. Open it
                beside the form and move anything REEP cannot see — past jobs,
                projects, the tools you actually use — onto your profile. The next
                draft picks all of it up.
              </Typography>

              <Stack direction="row" spacing={1.5} sx={{ mt: 2.5, flexWrap: 'wrap' }}>
                <Button
                  href={`/api/uploads/${cv.id}`}
                  target="_blank"
                  size="small"
                  variant="outlined"
                  endIcon={<OpenInNewRounded />}
                >
                  Open my CV
                </Button>
                <Button href="/student/profile" size="small">
                  Add those details to my profile
                </Button>
              </Stack>
            </SectionCard>
          )}
        </Grid>
      </Grid>

      {/* --- version history --------------------------------------------- */}
      <SectionCard
        title="Resumes you have generated"
        subtitle="Each run is saved as its own version — nothing is ever overwritten"
      >
          {resumes.length === 0 ? (
            <EmptyState
              title="You have not generated a resume yet."
              hint="Fill in the target role and industry above. The first draft takes a few seconds."
            />
          ) : (
            <List disablePadding>
              {resumes.map((resume, index) => {
                const scoring = readResumeScoring(resume.scoring);
                const byModel = resume.generatedBy !== 'fallback';
                return (
                  <ListItem
                    key={resume.id}
                    disablePadding
                    sx={{
                      borderTop: index === 0 ? 0 : 1,
                      borderColor: 'divider',
                    }}
                  >
                    <ListItemButton
                      href={`/student/resume/${resume.id}`}
                      sx={{ px: 1.5, mx: -1.5, py: 1.75, width: 'auto', flex: 1 }}
                    >
                      <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        spacing={{ xs: 1, sm: 2 }}
                        sx={{ width: '100%', alignItems: { sm: 'center' } }}
                      >
                        <Typography
                          variant="subtitle2"
                          color="text.secondary"
                          className="tabular"
                          sx={{ width: { sm: 44 }, flexShrink: 0 }}
                        >
                          v{resume.version}
                        </Typography>

                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography variant="subtitle1">{resume.title}</Typography>
                          <Typography variant="body2" color="text.secondary">
                            {resume.targetRole ?? 'No target role'}
                            {resume.targetIndustry ? ` · ${resume.targetIndustry}` : ''}
                          </Typography>
                        </Box>

                        <StatusChip
                          tone="neutral"
                          label={byModel ? (resume.model ?? 'Claude') : 'Rule-based'}
                        />

                        <Typography
                          variant="caption"
                          color="text.secondary"
                          className="tabular"
                          sx={{ width: { sm: 150 }, textAlign: { sm: 'right' }, flexShrink: 0 }}
                        >
                          {resume.createdAt.toLocaleDateString('en-IN', FULL_DATE)}
                          {scoring ? ` · screening ${scoring.atsScore}` : ''}
                        </Typography>
                      </Stack>
                    </ListItemButton>
                  </ListItem>
                );
              })}
            </List>
          )}
      </SectionCard>

      <TechNote>
        Nothing on the &ldquo;what we already know&rdquo; card is stored twice: the
        percentages, hours, attendance and certification rows come from the same
        functions the rest of the dashboard renders from, so a resume can never quote
        a number the student&apos;s own screens disagree with. Those records are
        turned into an evidence pack in <code>src/lib/ai/evidence.ts</code>, and a
        generated line survives only if it cites a row in that pack — a citation
        naming anything else is dropped before the draft is saved, which is what
        stops an invented employer or credential reaching the page — and it is what
        makes a small local model safe to use here at all: it can write a duller
        sentence than a frontier model, but it cannot claim a certification the
        student never earned. The prose comes from whichever writer is configured —
        an OpenAI-compatible server at <code>LLM_BASE_URL</code> (preferred, because
        the prompt carries the student&apos;s name, USN and marks and a local model
        keeps them on the machine), then Anthropic, then a deterministic composer
        that builds the same structure from the same pack with no model at all. A
        writer that is not on this machine — a hosted <code>LLM_BASE_URL</code> or
        Anthropic, which differ only in which variable configures them — is refused
        the record altogether unless an administrator has set{' '}
        <code>LLM_ALLOW_REMOTE_STUDENT_DATA</code>, and the deterministic composer
        writes the draft instead; one check in <code>src/lib/ai/llm.ts</code> decides
        that for every path, so a fourth writer cannot be added past it. The
        adapter in <code>src/lib/ai/llm.ts</code> degrades through JSON-schema,
        JSON-object and plain-prose response modes, because support for each varies
        by server and by model, and it refuses a prompt that would not fit the
        configured context window rather than let the server truncate the pack and
        invent the missing half. Every
        run writes a new <code>Resume</code> row with its own version, so a draft a
        recruiter was shown last month still reads exactly as it did then.
      </TechNote>
    </>
  );
}

/// "a phone number, projects and a career summary" — reads like a sentence
/// rather than a comma-separated dump.
function listInWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}
