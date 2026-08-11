import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';

import {
  EmptyState,
  InfoBanner,
  PageIntro,
  SectionCard,
  StatCard,
  StatusChip,
  Surface,
  TechNote,
  type Tone,
} from '@/components/kit';
import { readResumeContent, readResumeEvidence, readResumeScoring } from '@/lib/ai/read';
import type {
  ResumeContent,
  ResumeEvidence,
  ResumeScoring,
} from '@/lib/ai/resume-types';
import { getStudentResume } from '@/lib/ai/store';
import { requireStudent } from '@/lib/auth';
import { formatPct } from '@/lib/reep';

import { regenerateResumeAction } from '../actions';
import { CopyMarkdownButton, PrintButton, RegenerateButton } from './document-actions';
import { ResumeTabs } from './resume-tabs';

export const metadata = { title: 'Resume — Student' };
export const dynamic = 'force-dynamic';

/**
 * The app chrome and every panel that is not the document already carry
 * `no-print`, so all this stylesheet has to do is un-card the document and force
 * ink colours — otherwise a student printing in dark mode gets white on white.
 */
const PRINT_CSS = `
@page { margin: 14mm; }
@media print {
  html, body { background: white !important; }
  #resume-document {
    max-width: none !important;
    margin: 0 !important;
    padding: 0 !important;
    border: none !important;
    border-radius: 0 !important;
    background: white !important;
  }
  #resume-document * {
    color: black !important;
    background: transparent !important;
    border-color: rgba(0, 0, 0, 0.25) !important;
  }
  #resume-document .doc-muted { color: rgba(0, 0, 0, 0.58) !important; }
}
`;

/// Document typography: bigger and airier than the dashboard's body text,
/// because this one gets read on paper.
const DOC_BODY = { fontSize: '0.875rem', lineHeight: 1.75 } as const;
const DOC_HEADING = { fontSize: '0.875rem', fontWeight: 600 } as const;

const FULL_DATE: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
};

export default async function ResumeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { studentId } = await requireStudent();
  const { id } = await params;

  const resume = await getStudentResume(studentId, id);
  if (!resume) notFound();

  const content = readResumeContent(resume.content);
  if (!content) notFound();

  const evidence = readResumeEvidence(resume.evidence);
  const scoring = readResumeScoring(resume.scoring);
  // Any model path, local or hosted — as opposed to the deterministic composer.
  const byModel = resume.generatedBy !== 'fallback';

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      <Box className="no-print">
        <Button href="/student/resume" size="small" startIcon={<ArrowBackRounded />}>
          All my resumes
        </Button>
      </Box>

      <Box className="no-print" sx={{ mt: 1.5 }}>
        <PageIntro
          title={resume.title}
          subtitle={
            <>
              Version {resume.version} · {resume.targetRole ?? 'No target role'}
              {resume.targetIndustry ? ` · ${resume.targetIndustry}` : ''} · written{' '}
              {resume.createdAt.toLocaleDateString('en-IN', FULL_DATE)}
            </>
          }
          action={
            <Stack
              direction="row"
              spacing={1.5}
              sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1.5 }}
            >
              <StatusChip
                tone="neutral"
                label={byModel ? `Written by ${resume.model ?? 'Claude'}` : 'Rule-based draft'}
              />
              <PrintButton />
              <CopyMarkdownButton markdown={resume.markdown} />
              {/* A plain <form> rather than a MUI wrapper: the server action has
                  to reach the DOM element, and the pending state is read by the
                  client button inside it. */}
              <form action={regenerateResumeAction}>
                <input type="hidden" name="resumeId" value={resume.id} />
                <RegenerateButton />
              </form>
            </Stack>
          }
        />
      </Box>

      <ResumeTabs
        document={<ResumeDocument content={content} />}
        markdown={<MarkdownPanel markdown={resume.markdown} />}
        evidence={<EvidencePanel evidence={evidence} />}
        score={<ScorePanel scoring={scoring} />}
      />

      <Box className="no-print">
        <TechNote>
          The document, the markdown and the evidence map are three views of one
          saved row: <code>content</code> holds the structured resume,{' '}
          <code>markdown</code> the flat copy, and <code>evidence</code> the
          claim-to-record map. None of it is re-derived when the page loads, so a
          draft shown to a recruiter today reads exactly as it did the day it was
          written. Regenerate never edits this row — it re-reads the student&apos;s
          current REEP record and files a new version, which is what keeps an old
          evidence map honest. Printing is handled by a stylesheet scoped to this
          screen: the app chrome, the tabs and the buttons are marked{' '}
          <code>no-print</code>, and the document is forced to ink-on-paper colours
          so &ldquo;Save as PDF&rdquo; gives the same page in either theme.
        </TechNote>
      </Box>
    </>
  );
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

function ResumeDocument({ content }: { content: ResumeContent }) {
  const { header } = content;

  const contact = [header.city, header.email, header.phone, `USN ${header.usn}`].filter(
    (part): part is string => Boolean(part),
  );
  const links = [header.linkedinUrl, header.githubUrl, header.portfolioUrl].filter(
    (link): link is string => Boolean(link),
  );

  const skillGroups: [string, string[]][] = [
    ['Technical & analytical', content.skills?.technical ?? []],
    ['Professional & behavioural', content.skills?.professional ?? []],
    ['Tools', content.skills?.tools ?? []],
  ];

  return (
    // The one real surface on the screen: this is a document, and it has to read
    // as a sheet of paper both on screen and out of the printer.
    <Box
      id="resume-document"
      component="article"
      sx={{
        maxWidth: 840,
        mx: 'auto',
        bgcolor: 'background.paper',
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        px: { xs: 3, sm: 7 },
        py: { xs: 4, sm: 6 },
      }}
    >
      <Box component="header">
        {/* h2, not h1: the screen's own <h1> is the version header above. On
            paper the level is invisible; on a screen reader it keeps one outline. */}
        <Typography
          component="h2"
          sx={{
            fontSize: '1.75rem',
            fontWeight: 600,
            letterSpacing: '-0.022em',
            lineHeight: 1.15,
          }}
        >
          {header.name}
        </Typography>

        {header.headline && (
          <Typography
            className="doc-muted"
            color="text.secondary"
            sx={{ mt: 0.75, fontSize: '0.9375rem', fontWeight: 500 }}
          >
            {header.headline}
          </Typography>
        )}

        <Typography
          className="doc-muted"
          variant="body2"
          color="text.secondary"
          sx={{ mt: 1.75 }}
        >
          {contact.join('   ·   ')}
        </Typography>

        {links.length > 0 && (
          <Typography
            className="doc-muted"
            variant="body2"
            color="text.secondary"
            sx={{ mt: 0.5, wordBreak: 'break-word' }}
          >
            {links.join('   ·   ')}
          </Typography>
        )}
      </Box>

      {content.summary && (
        <DocSection title="Professional summary">
          <Typography sx={DOC_BODY}>{content.summary}</Typography>
        </DocSection>
      )}

      {content.education.length > 0 && (
        <DocSection title="Education">
          <Stack spacing={2}>
            {content.education.map((entry, index) => (
              <Box key={`${entry.degree}-${index}`}>
                <DocRow left={entry.degree} right={entry.year} />
                <Typography className="doc-muted" sx={{ ...DOC_BODY, color: 'text.secondary' }}>
                  {[entry.institution, entry.score].filter(Boolean).join('  ·  ')}
                </Typography>
              </Box>
            ))}
          </Stack>
        </DocSection>
      )}

      {content.experience.length > 0 && (
        <DocSection title="Experience">
          <Stack spacing={2.5}>
            {content.experience.map((role, index) => (
              <Box key={`${role.title}-${index}`}>
                <DocRow
                  left={role.org ? `${role.title} — ${role.org}` : role.title}
                  right={role.period}
                />
                <Box component="ul" sx={{ m: 0, mt: 0.75, pl: 2.5, ...DOC_BODY }}>
                  {role.bullets.map((bullet, bulletIndex) => (
                    <Box component="li" key={bulletIndex} sx={{ mb: 0.5 }}>
                      {bullet.text}
                    </Box>
                  ))}
                </Box>
              </Box>
            ))}
          </Stack>
        </DocSection>
      )}

      {content.projects.length > 0 && (
        <DocSection title="Projects">
          <Stack spacing={2}>
            {content.projects.map((project, index) => (
              <Box key={`${project.name}-${index}`}>
                <Typography sx={DOC_HEADING}>{project.name}</Typography>
                {project.description && (
                  <Typography sx={DOC_BODY}>{project.description}</Typography>
                )}
                {(project.tech.length > 0 || project.link) && (
                  <Typography
                    className="doc-muted"
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', mt: 0.25, wordBreak: 'break-word' }}
                  >
                    {[project.tech.join(', '), project.link].filter(Boolean).join('   ·   ')}
                  </Typography>
                )}
              </Box>
            ))}
          </Stack>
        </DocSection>
      )}

      {content.certifications.length > 0 && (
        <DocSection title="Certifications">
          <Stack spacing={1.25}>
            {content.certifications.map((cert, index) => (
              <Stack
                key={`${cert.name}-${index}`}
                direction={{ xs: 'column', sm: 'row' }}
                spacing={{ xs: 0, sm: 2 }}
                sx={{ alignItems: { sm: 'baseline' } }}
              >
                <Typography sx={{ ...DOC_BODY, flex: 1 }}>
                  <Box component="span" sx={{ fontWeight: 600 }}>
                    {cert.name}
                  </Box>
                  {cert.provider ? ` — ${cert.provider}` : ''}
                  {cert.hours > 0 ? ` · ${cert.hours}h` : ''}
                  {cert.dimension ? ` · ${cert.dimension}` : ''}
                </Typography>
                <Typography
                  className="doc-muted"
                  variant="caption"
                  color="text.secondary"
                  sx={{ flexShrink: 0 }}
                >
                  {cert.completedOn}
                </Typography>
              </Stack>
            ))}
          </Stack>
        </DocSection>
      )}

      {content.reepHighlights.length > 0 && (
        <DocSection title="REEP programme record">
          <Box component="ul" sx={{ m: 0, pl: 2.5, ...DOC_BODY }}>
            {content.reepHighlights.map((highlight, index) => (
              <Box component="li" key={`${highlight.label}-${index}`} sx={{ mb: 0.75 }}>
                <Box component="span" sx={{ fontWeight: 600 }}>
                  {highlight.label}:
                </Box>{' '}
                {highlight.detail}
              </Box>
            ))}
          </Box>
        </DocSection>
      )}

      {skillGroups.some(([, items]) => items.length > 0) && (
        <DocSection title="Skills">
          <Stack spacing={1}>
            {skillGroups
              .filter(([, items]) => items.length > 0)
              .map(([label, items]) => (
                <Typography key={label} sx={DOC_BODY}>
                  <Box component="span" sx={{ fontWeight: 600 }}>
                    {label}:
                  </Box>{' '}
                  {items.join(', ')}
                </Typography>
              ))}
          </Stack>
        </DocSection>
      )}
    </Box>
  );
}

function DocSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box component="section" sx={{ mt: 4.5 }}>
      <Typography
        component="h3"
        sx={{
          fontSize: '0.9375rem',
          fontWeight: 600,
          letterSpacing: '-0.006em',
          pb: 0.75,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        {title}
      </Typography>
      <Box sx={{ mt: 2 }}>{children}</Box>
    </Box>
  );
}

/// Title on the left, dates on the right — the one layout every recruiter's eye
/// already knows how to scan.
function DocRow({ left, right }: { left: string; right: string }) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={{ xs: 0, sm: 2 }}
      sx={{ alignItems: { sm: 'baseline' }, justifyContent: 'space-between' }}
    >
      <Typography sx={DOC_HEADING}>{left}</Typography>
      {right && (
        <Typography
          className="doc-muted"
          variant="caption"
          color="text.secondary"
          sx={{ flexShrink: 0 }}
        >
          {right}
        </Typography>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function MarkdownPanel({ markdown }: { markdown: string }) {
  return (
    <SectionCard
      title="Markdown source"
      subtitle="Plain headings and bullets — safe to paste into a job portal or an email"
      action={<CopyMarkdownButton markdown={markdown} label="Copy" />}
    >
      <Surface>
        <Box
          component="pre"
          sx={{
            m: 0,
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: '0.8125rem',
            lineHeight: 1.7,
            color: 'text.secondary',
          }}
        >
          {markdown}
        </Box>
      </Surface>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

function EvidencePanel({ evidence }: { evidence: ResumeEvidence | null }) {
  if (!evidence) {
    return (
      <SectionCard title="Evidence">
        <EmptyState
          title="This draft was saved without an evidence map."
          hint="Regenerate it and the new version will carry one."
        />
      </SectionCard>
    );
  }

  const byId = new Map(evidence.records.map((record) => [record.id, record]));
  const uncited = evidence.claims.filter((claim) => claim.evidenceIds.length === 0).length;

  return (
    <>
      <SectionCard
        title="Every line, and the record behind it"
        subtitle={`${evidence.claims.length} claims checked against ${evidence.records.length} REEP records`}
        action={
          uncited === 0 ? (
            <StatusChip tone="good" label="All backed up" />
          ) : (
            <StatusChip tone="warning" label={`${uncited} unbacked`} />
          )
        }
      >
        <Stack>
          {evidence.claims.map((claim, index) => (
            <Box
              key={index}
              sx={{
                py: 2,
                borderTop: 1,
                borderColor: 'divider',
                '&:first-of-type': { borderTop: 0, pt: 0 },
              }}
            >
              <Typography variant="body1">{claim.claim}</Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 1 }}>
                {claim.evidenceIds.length === 0 ? (
                  <StatusChip tone="warning" label="No supporting record" />
                ) : (
                  claim.evidenceIds.map((recordId) => (
                    <Chip
                      key={recordId}
                      size="small"
                      variant="outlined"
                      label={byId.get(recordId)?.label ?? recordId}
                    />
                  ))
                )}
              </Stack>
            </Box>
          ))}
        </Stack>
      </SectionCard>

      <SectionCard
        title="The record pack"
        subtitle="The only facts the writer was allowed to use"
      >
        <Stack>
            {evidence.records.map((record) => (
              <Stack
                key={record.id}
                direction={{ xs: 'column', md: 'row' }}
                spacing={{ xs: 0.25, md: 3 }}
                sx={{
                  py: 1.75,
                  borderTop: 1,
                  borderColor: 'divider',
                  '&:first-of-type': { borderTop: 0, pt: 0 },
                }}
              >
                <Typography variant="subtitle2" sx={{ width: { md: 220 }, flexShrink: 0 }}>
                  {record.label}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                  {record.detail}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.disabled"
                  sx={{ width: { md: 180 }, flexShrink: 0, textAlign: { md: 'right' } }}
                >
                  {record.source}
                </Typography>
              </Stack>
          ))}
        </Stack>
      </SectionCard>
    </>
  );
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

function scoreTone(value: number): Tone {
  if (value >= 75) return 'good';
  if (value >= 55) return 'warning';
  return 'critical';
}

function ScorePanel({ scoring }: { scoring: ResumeScoring | null }) {
  if (!scoring) {
    return (
      <SectionCard title="Score">
        <EmptyState
          title="This draft was saved without a score."
          hint="Regenerate it and the new version will carry one."
        />
      </SectionCard>
    );
  }

  return (
    <>
      <Grid container spacing={2.5} sx={{ mb: 5 }}>
        <Grid size={{ xs: 12, sm: 6 }}>
          <StatCard
            label="Screening score"
            value={scoring.atsScore}
            tone={scoreTone(scoring.atsScore)}
            progress={scoring.atsScore}
            hint="How an automated screen would read this draft: sections filled in, words that match the job you named, and how much of it is backed by a record."
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6 }}>
          <StatCard
            label="Completeness"
            value={formatPct(scoring.completeness)}
            tone={scoreTone(scoring.completeness)}
            progress={scoring.completeness}
            hint="How many of the sections a recruiter expects are actually filled in."
          />
        </Grid>
      </Grid>

      <SectionCard title="What to fix next" subtitle="Highest impact first">
        {scoring.missing.length === 0 ? (
          <InfoBanner tone="good" title="Nothing missing">
            Every section this builder checks for is filled in.
          </InfoBanner>
        ) : (
          <Stack spacing={1.5}>
            {scoring.missing.map((item) => (
              <Stack key={item} direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
                <Box sx={{ pt: 0.25, flexShrink: 0 }}>
                  <StatusChip tone="warning" label="Gap" />
                </Box>
                <Typography variant="body1">{item}</Typography>
              </Stack>
            ))}
          </Stack>
        )}

        {scoring.suggestions.length > 0 && (
          <>
            <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 4, mb: 1.5 }}>
              Suggestions
            </Typography>
            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
              {scoring.suggestions.map((item) => (
                <Box component="li" key={item} sx={{ mb: 1 }}>
                  <Typography variant="body1" component="span">
                    {item}
                  </Typography>
                </Box>
              ))}
            </Box>
          </>
        )}

        <Typography variant="body2" color="text.secondary" sx={{ mt: 3.5 }}>
          Most of these are fixed on your profile. Regenerate afterwards and the new
          version picks the changes up.
        </Typography>

        <Stack direction="row" spacing={1.5} sx={{ mt: 2, flexWrap: 'wrap', rowGap: 1.5 }}>
          <Button href="/student/profile" variant="outlined" size="small">
            Update my profile
          </Button>
          <Button href="/student/certifications" size="small">
            My certifications
          </Button>
        </Stack>
      </SectionCard>
    </>
  );
}
