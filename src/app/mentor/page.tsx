import { notFound } from 'next/navigation';

import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';

import {
  EmptyState,
  InfoBanner,
  PageIntro,
  SectionCard,
  TechNote,
} from '@/components/kit';
import { RosterGrid, type RosterRowView } from '@/components/roster-grid';
import { GlassPanel, NeuPanel, NeuStat, SurfaceScene } from '@/components/surfaces';
import { requireMentor } from '@/lib/auth';
import { getMentorCohort } from '@/lib/queries';
import { STAGE_LABEL, formatPct, relativeDay } from '@/lib/reep';
import { alertStripSummary } from '@/lib/rules';
import type { Stage } from '@prisma/client';

import { resolveMentorId } from './(overview)/resolve-mentor';

export const metadata = { title: 'Cohort overview — Mentor' };
export const dynamic = 'force-dynamic';

export default async function MentorCohortPage() {
  const session = await requireMentor();
  const { mentorId, borrowed } = await resolveMentorId(session);

  const data = await getMentorCohort(mentorId);
  if (!data) notFound();

  const { mentor, roster, alerts, summary } = data;
  const now = new Date();

  // Everything the grid needs, flattened and formatted here: the grid runs on
  // the client, so it only ever receives strings and numbers.
  const rows: RosterRowView[] = roster.map((row) => ({
    id: row.studentId,
    name: row.name,
    usn: row.usn,
    stageLabel: `${STAGE_LABEL[row.stage as Stage] ?? row.stage} · Sem ${row.semester}`,
    overallPct: Math.round(row.overallPct),
    attendancePct: Math.round(row.attendancePct),
    paceStatus: row.certPace.status,
    idleDays: idleDaysSince(row.lastActiveAt, now),
    lastActiveLabel: relativeDay(row.lastActiveAt, now),
    openAlerts: row.openAlerts,
    atRisk: row.atRisk,
    behind: row.behind,
  }));

  const strip = alertStripSummary(alerts, 3);
  const hidden = strip.count - Math.min(strip.count, 3);

  // Most seeded mentor names already carry the honorific; only add it when the
  // stored name does not, so nobody reads as "Prof. Prof. Rakesh Iyer".
  const mentorName = mentor.user.name.startsWith(mentor.title)
    ? mentor.user.name
    : `${mentor.title} ${mentor.user.name}`;

  return (
    <SurfaceScene>
      {/* --- the hero: the state of the group in one glance --------------- */}
      {/* Counts, not percentages, on the three action tiles — a mentor works a
          queue of named students, and "2" is something you can finish today.
          The average is left in ink: it is a measurement, not a status. */}
      <GlassPanel sx={{ mb: 5 }}>
        <PageIntro
          title="Cohort overview"
          subtitle={`${mentorName} · ${mentor.mentorGroup} · ${summary.studentCount} student${
            summary.studentCount === 1 ? '' : 's'
          }`}
          sx={{ mb: 3.5 }}
        />

        <Grid container spacing={2.5}>
          <Grid size={{ xs: 6, lg: 3 }}>
            <NeuStat
              label="Avg. completion"
              value={formatPct(summary.avgCompletion)}
              progress={summary.avgCompletion}
              hint={`Across your ${summary.studentCount} mentees`}
            />
          </Grid>
          <Grid size={{ xs: 6, lg: 3 }}>
            <NeuStat
              label="At risk"
              value={summary.atRisk}
              // Zero is not a status worth colouring. A quiet week should look
              // like a quiet week; the hint says so in words.
              tone={summary.atRisk > 0 ? 'critical' : 'neutral'}
              hint={summary.atRisk > 0 ? 'Talk to these students first' : 'Nobody at risk today'}
            />
          </Grid>
          <Grid size={{ xs: 6, lg: 3 }}>
            <NeuStat
              label="Behind pace"
              value={summary.behindPace}
              tone={summary.behindPace > 0 ? 'warning' : 'neutral'}
              hint="Slower than their certifications need"
            />
          </Grid>
          <Grid size={{ xs: 6, lg: 3 }}>
            <NeuStat
              label="Certs overdue (7d)"
              value={summary.certsOverdue}
              tone={summary.certsOverdue > 0 ? 'critical' : 'neutral'}
              hint="Due dates that passed in the last week"
            />
          </Grid>
        </Grid>
      </GlassPanel>

      {borrowed && (
        <InfoBanner tone="info" title="You are viewing this as programme staff">
          Your account has no mentor group of its own, so this is {mentorName}&apos;s group
          shown exactly as they see it. Programme-wide numbers live on the director
          dashboard.
        </InfoBanner>
      )}

      {strip.count > 0 && (
        <InfoBanner
          tone="warning"
          title={`${strip.count} open alert${strip.count === 1 ? '' : 's'}`}
          action={
            <Button href="/mentor/alerts" size="small" color="inherit">
              Review alerts
            </Button>
          }
        >
          {strip.text}
          {hidden > 0 ? `  |  and ${hidden} more` : ''}
        </InfoBanner>
      )}

      {/* The roster sits on a raised panel rather than behind glass: it is a
          dense grid of names and figures, and a translucent backing under a
          table is the fastest way to make one hard to read. */}
      <SectionCard
        title="Your mentees"
        subtitle="Click any row to open that student. Sort by tapping a column heading."
      >
        <NeuPanel sx={{ px: { xs: 1.5, sm: 2 } }}>
          {rows.length === 0 ? (
            <EmptyState
              title="No students are assigned to this group yet."
              hint="Once the programme office assigns mentees, they appear here with their progress and alerts."
            />
          ) : (
            <RosterGrid rows={rows} />
          )}
        </NeuPanel>
      </SectionCard>

      <TechNote>
        &ldquo;Cert. pace&rdquo; is not stored anywhere — it is the gap between how much
        of their certification work a student has actually finished and how much the
        elapsed-time curve expects of them today, so it moves on its own as due dates
        approach. The alert strip is the same idea one level up: rules such as &ldquo;no lab
        check-in in N days&rdquo; or &ldquo;pace more than X% below the curve&rdquo; are
        evaluated against the same signals. Every N and X is an{' '}
        <code>AlertRuleConfig</code> row scoped to a cohort and edited on{' '}
        <code>/mentor/settings</code>, so a coordinator can retune a batch without a code
        change and nothing in this page carries a hard-coded threshold. The depth is
        presentation only: the frosted hero and the extruded tiles are custom properties
        from <code>src/theme.ts</code> wrapped around the same <code>StatCard</code> the
        other screens use, so every tone, threshold and contrast ratio is unchanged. The
        roster is deliberately not behind glass — a translucent backing under a dense grid
        of names is the fastest way to make one hard to read.
      </TechNote>
    </SurfaceScene>
  );
}

/// Whole calendar days since a date, matching `relativeDay` exactly so the
/// "Inactive 5+ days" filter and the printed label can never disagree.
function idleDaysSince(date: Date | null, now: Date): number {
  if (!date) return 9999;
  const startOf = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.max(0, Math.round((startOf(now) - startOf(date)) / 86_400_000));
}
