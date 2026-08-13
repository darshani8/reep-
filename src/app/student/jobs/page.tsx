import { notFound } from 'next/navigation';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';

import {
  EmptyState,
  InfoBanner,
  PageIntro,
  SectionCard,
  StatCard,
  TechNote,
  type Tone,
} from '@/components/kit';
import { requireStudent } from '@/lib/auth';
import { applicationState } from '@/lib/jobs/application';
import { getJobsBoard, type BoardData, type BoardJob } from '@/lib/jobs/board';
import { matchJob, matchSummary, type MatchBand } from '@/lib/jobs/match';
import { relativeDay } from '@/lib/reep';
import type { DegreeLevel } from '@prisma/client';

import { JobsGrid, type JobRowView } from './jobs-grid';

export const metadata = { title: 'Jobs — Student' };
export const dynamic = 'force-dynamic';

/// The tabs, in the order the spec names them.
const LEVELS: DegreeLevel[] = ['UG', 'PG'];

const LEVEL_LABEL: Record<DegreeLevel, string> = {
  UG: 'Undergraduate',
  PG: 'Post Graduate',
};

/// A match is never coloured as a warning. A 30% fit is information, not a
/// problem with the student, and painting it red would make the board read as
/// an accusation on the day they have no verified skills yet.
const BAND_TONE: Record<MatchBand, Tone> = {
  strong: 'good',
  fair: 'info',
  weak: 'neutral',
};

export default async function StudentJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ level?: string | string[] }>;
}) {
  const { studentId } = await requireStudent();
  const board = await getJobsBoard(studentId);
  if (!board) notFound();

  const { ownLevel, jobs, catalogue, held, applications } = board;
  // The student's own level is the default; the query string is a browsing
  // choice, not an entitlement, so an unknown value falls back rather than 404s.
  const level = parseLevel((await searchParams).level) ?? ownLevel;
  const now = new Date();

  const visible = jobs.filter((job) => job.degreeLevel === level);
  const rows: JobRowView[] = visible.map((job) => toRow(job, board, now));

  const openRows = rows.filter((row) => !row.isClosed);
  const appliedCount = rows.filter((row) => row.applied).length;
  const strongCount = openRows.filter((row) => (row.matchPct ?? 0) >= 70).length;
  const closingSoon = openRows.filter((row) => row.closesSort <= 7).length;

  const counts = Object.fromEntries(
    LEVELS.map((value) => [value, jobs.filter((job) => job.degreeLevel === value).length]),
  ) as Record<DegreeLevel, number>;

  const verifiedSkills = held.filter((skill) => skill.verified).length;

  return (
    <>
      <PageIntro
        title="Jobs"
        subtitle={
          jobs.length === 0
            ? 'No vacancies have been imported yet. The placement cell uploads a sheet each week.'
            : `The weekly sheet from the placement cell, split by degree level. You are on the ${LEVEL_LABEL[ownLevel]} board — the other one is here to browse.`
        }
        action={
          <Button href="/student/profile" variant="outlined">
            My skills
          </Button>
        }
      />

      {held.length === 0 && (
        <InfoBanner
          title="Add your skills and every posting gets a match percentage"
          action={
            <Button href="/student/profile" size="small" color="inherit">
              Add skills
            </Button>
          }
        >
          The match column compares what you can prove against what each posting asks
          for. You have not recorded any skills yet, so there is nothing to compare —
          the column says so rather than showing you a misleading 0%.
        </InfoBanner>
      )}

      {held.length > 0 && verifiedSkills === 0 && (
        <InfoBanner
          tone="warning"
          title="None of your skills are verified yet"
          action={
            <Button href="/student/uploads" size="small" color="inherit">
              Upload evidence
            </Button>
          }
        >
          Only skills your mentor has checked against evidence count towards a match,
          because a percentage built on unchecked claims would tell you that you are
          ready for a vacancy when nobody has looked. Upload a certificate and the
          column starts scoring.
        </InfoBanner>
      )}

      <Grid container spacing={2.5} sx={{ mb: 3 }}>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Open vacancies"
            value={openRows.length}
            hint={
              rows.length > openRows.length
                ? `${rows.length - openRows.length} more have closed`
                : 'Every posting on this board is still open'
            }
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="You have applied to"
            value={appliedCount}
            tone={appliedCount > 0 ? 'good' : 'neutral'}
            hint="Your own tick — not a confirmed submission"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Strong matches"
            value={strongCount}
            tone={strongCount > 0 ? 'good' : 'neutral'}
            hint={
              verifiedSkills === 0
                ? 'Needs at least one verified skill'
                : '70% or more of what the posting asks for'
            }
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Closing this week"
            value={closingSoon}
            tone={closingSoon > 0 ? 'warning' : 'neutral'}
            hint={closingSoon > 0 ? 'Apply before they go' : 'Nothing closes in the next 7 days'}
          />
        </Grid>
      </Grid>

      {/* --- UG / PG ------------------------------------------------------ */}
      <Box sx={{ mb: 4 }} className="no-print">
        <Tabs
          value={level}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          aria-label="Undergraduate and post graduate vacancies"
        >
          {LEVELS.map((value) => (
            <Tab
              key={value}
              value={value}
              label={`${LEVEL_LABEL[value]} · ${counts[value]}${value === ownLevel ? ' · yours' : ''}`}
              href={`/student/jobs?level=${value}`}
            />
          ))}
        </Tabs>
      </Box>

      <SectionCard
        title={`${LEVEL_LABEL[level]} vacancies`}
        subtitle={
          level === ownLevel
            ? 'The board for your own cohort. Four things you can do with every row.'
            : `You are on the ${LEVEL_LABEL[ownLevel]} programme — these are here to read, and most will not take your degree.`
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            title={`No ${LEVEL_LABEL[level]} vacancies on the board.`}
            hint={
              jobs.length === 0
                ? 'The placement cell uploads the weekly sheet from the director screens. Nothing has been imported yet.'
                : `The other tab has ${counts[level === 'UG' ? 'PG' : 'UG']} postings on it.`
            }
            action={
              <Button href={`/student/jobs?level=${level === 'UG' ? 'PG' : 'UG'}`} size="small">
                Show the {LEVEL_LABEL[level === 'UG' ? 'PG' : 'UG']} board
              </Button>
            }
          />
        ) : (
          <JobsGrid rows={rows} />
        )}
      </SectionCard>

      <TechNote>
        The match percentage is arithmetic, not a model. Each posting&apos;s required
        skills are weighted at full value and any further skill its description names
        at 40%, the student&apos;s level on each is credited on a curve that flattens
        above Proficient, and the score is what they hold over what the posting asks
        for — <code>src/lib/jobs/match.ts</code>, which touches no database and calls
        no LLM, so this page raises no question for{' '}
        <code>studentDataEgressAllowed()</code> and the same input always produces the
        same number. Only mentor-<em>verified</em> skills score; the unverified ones
        are reported separately as the headroom verification would buy, because a
        percentage inflated by unchecked claims tells a student they are ready for a
        vacancy nobody has confirmed they are. Where there is no honest number — no
        skills recorded, none verified, or a posting that lists no requirements — the
        column says which of the three it is instead of printing 0%. Ticking
        &ldquo;I applied&rdquo; writes a <code>JobApplication</code> with{' '}
        <code>selfReported</code> true and no way of setting it otherwise: the
        dashboard cannot see the employer&apos;s portal, and a placement report must
        never read a tick as a confirmed submission. Opening the employer link records
        the intent on the same row under a marker note, which is why the box can say
        &ldquo;opened, not yet applied&rdquo; without a second table.
      </TechNote>
    </>
  );
}

/// Unknown or repeated `?level=` values fall back to the student's own board.
function parseLevel(value: string | string[] | undefined): DegreeLevel | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && (LEVELS as string[]).includes(raw) ? (raw as DegreeLevel) : null;
}

function toRow(job: BoardJob, board: BoardData, now: Date): JobRowView {
  const match = matchJob(job, board.catalogue, board.held);
  const summary = matchSummary(match);
  const closes = describeClosing(job.closesOn, now);
  const application = board.applications.get(job.id);
  const state = applicationState(application);

  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location ?? '',
    postedLabel: `posted ${relativeDay(job.postedOn, now).toLowerCase()}`,
    closesLabel: closes.label,
    closesTone: closes.tone,
    closesSort: closes.sort,
    isClosed: closes.closed,
    matchPct: match.kind === 'scored' ? match.pct : null,
    // Everything without a percentage sorts below everything with one, rather
    // than clustering at the top as if it were a 0% match.
    matchSort: match.kind === 'scored' ? match.pct : -1,
    matchLabel: summary.label,
    matchHint: summary.hint,
    matchTone: summary.band ? BAND_TONE[summary.band] : 'neutral',
    // A closed posting keeps its link — the grid decides what to do with it,
    // and reading a vacancy you missed is allowed.
    applyUrl: job.applyUrl,
    applied: state === 'applied',
    openedLabel:
      state === 'opened' && application
        ? `Opened ${relativeDay(application.appliedAt, now).toLowerCase()}`
        : null,
    skillsLabel: job.requiredSkills.join(' '),
  };
}

/// Plain words rather than a date the reader has to subtract from today, and a
/// `sort` in days so the column orders soonest-first.
function describeClosing(
  closesOn: Date | null,
  now: Date,
): { label: string; tone: Tone; sort: number; closed: boolean } {
  if (!closesOn) return { label: 'No closing date', tone: 'neutral', sort: 9_999, closed: false };

  const startOf = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(closesOn) - startOf(now)) / 86_400_000);

  if (days < 0) return { label: 'Closed', tone: 'neutral', sort: 10_000, closed: true };
  if (days === 0) return { label: 'Closes today', tone: 'critical', sort: 0, closed: false };
  return {
    label: days === 1 ? '1 day left' : `${days} days left`,
    tone: days <= 3 ? 'critical' : days <= 7 ? 'warning' : 'neutral',
    sort: days,
    closed: false,
  };
}
