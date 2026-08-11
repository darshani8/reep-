import { notFound } from 'next/navigation';

import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';

import {
  EmptyState,
  PageIntro,
  SectionCard,
  StatCard,
  TechNote,
  type Tone,
} from '@/components/kit';
import { requireMentor } from '@/lib/auth';
import { getMentorCohortForSession } from '@/lib/queries';
import { PACE_LABEL, STAGE_LABEL, daysBetween, relativeDay } from '@/lib/reep';
import type { PaceStatus, Stage } from '@prisma/client';

import { MenteeGrid, type MenteeRow } from './mentee-grid';

export const metadata = { title: 'Your students — Mentor' };
export const dynamic = 'force-dynamic';

const PACE_TONE: Record<PaceStatus, Tone> = {
  ON_TRACK: 'good',
  BEHIND: 'warning',
  AT_RISK: 'critical',
};

/// Nobody has checked in for a week — the number a mentor should act on first.
const QUIET_DAYS = 7;

export default async function MentorStudentIndexPage() {
  const session = await requireMentor();

  // A director or admin reaches /mentor/* through the role guard but owns no
  // mentee list — the cohort screens are their way into a student. A mentor
  // account with no `Mentor` row looks identical on the session and is not the
  // same thing at all, which is why the scope decision is made by role in
  // `getMentorCohortForSession` rather than by `session.mentorId ? … : null`.
  const scoped = await getMentorCohortForSession(session);
  if (scoped.kind === 'denied') notFound();

  if (scoped.kind === 'no-group') {
    return (
      <>
        <PageIntro
          title="Your students"
          subtitle="Open a student to see how their time is turning into progress."
        />
        <EmptyState
          title="You are not the mentor of record for anyone."
          hint="Programme staff reach a student through cohort analytics rather than through a mentor roster."
          action={
            <Button href="/director" variant="contained" color="secondary">
              Go to cohort analytics
            </Button>
          }
        />
        <IndexTechNote />
      </>
    );
  }

  const data = scoped.cohort;
  const now = new Date();

  const rows: MenteeRow[] = data.roster.map((row) => ({
    id: row.studentId,
    name: row.name,
    usn: row.usn,
    stage: `${STAGE_LABEL[row.stage as Stage]} · Sem ${row.semester}`,
    overallPct: row.overallPct,
    paceLabel: PACE_LABEL[row.certPace.status],
    paceTone: PACE_TONE[row.certPace.status],
    lastActive: relativeDay(row.lastActiveAt, now),
    // 999 stands in for "never checked in", which should sort as the quietest.
    daysQuiet: row.lastActiveAt ? daysBetween(now, row.lastActiveAt) : 999,
    openAlerts: row.openAlerts,
    atRisk: row.atRisk,
    behind: row.behind,
  }));

  const quiet = rows.filter((row) => row.daysQuiet >= QUIET_DAYS).length;

  return (
    <>
      <PageIntro
        title="Your students"
        subtitle={`${data.mentor.mentorGroup} · open a student to see how their time is turning into progress.`}
      />

      <Grid container spacing={2.5} sx={{ mb: 5 }}>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard label="Students" value={rows.length} hint="In your mentor group" />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Average completion"
            value={`${data.summary.avgCompletion.toFixed(0)}%`}
            progress={data.summary.avgCompletion}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="At risk"
            value={data.summary.atRisk}
            tone={data.summary.atRisk > 0 ? 'critical' : 'neutral'}
            hint={data.summary.atRisk > 0 ? 'Start your week here' : 'Nobody needs rescuing'}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Quiet in the lab"
            value={quiet}
            tone={quiet > 0 ? 'warning' : 'neutral'}
            hint={`No check-in for ${QUIET_DAYS} days or more`}
          />
        </Grid>
      </Grid>

      <SectionCard
        title="Everyone you mentor"
        subtitle="Open a row to see that student's focus log"
      >
        <MenteeGrid rows={rows} />
      </SectionCard>

      <IndexTechNote />
    </>
  );
}

function IndexTechNote() {
  return (
    <TechNote>
      This list is scoped by the mentor relationship on the student record rather than
      by cohort, because a mentor group can span sections. The detail screen re-checks
      that relationship on every read and every write, so pasting another mentor&apos;s
      student id into the URL shows nothing and flags nobody. Pace, overall percentage
      and the at-risk definition all come out of <code>getMentorCohort</code> — the same
      call the cohort overview uses — so a student marked at risk here is marked at risk
      there.
    </TechNote>
  );
}
