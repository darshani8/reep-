import type { ReactNode } from 'react';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Typography from '@mui/material/Typography';
import ArrowForwardRounded from '@mui/icons-material/ArrowForwardRounded';

import { EmptyState, PageIntro, SectionCard, TechNote } from '@/components/kit';
import { DirectorCohortGrid, type CohortRowView } from '@/components/director-cohort-grid';
import { RankedBarChart, TrendChart } from '@/components/reep-charts';
import { GlassPanel, NeuPanel, NeuStat, SurfaceScene } from '@/components/surfaces';
import { requireRole } from '@/lib/auth';
import { getDirectorAnalytics } from '@/lib/queries';

export const metadata = { title: 'Cohort analytics — Director' };
export const dynamic = 'force-dynamic';

/**
 * The highest-altitude view in the product, and therefore the emptiest: four
 * numbers, two charts, one table. Every chart is led by a sentence that states
 * its finding in words, so a director gets the answer without having to read a
 * bar against an axis — the chart is there to show the shape around the number,
 * not to hold the number hostage.
 */
function Lead({ children, detail }: { children: ReactNode; detail?: ReactNode }) {
  return (
    <Box sx={{ mb: 2.5, maxWidth: '72ch' }}>
      <Typography variant="body1">{children}</Typography>
      {detail ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {detail}
        </Typography>
      ) : null}
    </Box>
  );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * A raised panel that is still the validated chart surface.
 *
 * The neumorphic default is a gradient, and the chart palette in `theme.ts` was
 * checked against `background.default` specifically — so this keeps the
 * extrusion and pins the fill back to the exact colour those four series were
 * validated on. Depth is worth having; it is not worth quietly moving a mark off
 * its contrast floor.
 */
function ChartPanel({ children }: { children: ReactNode }) {
  return (
    <NeuPanel sx={{ background: 'var(--mui-palette-background-default)' }}>{children}</NeuPanel>
  );
}

export default async function DirectorAnalyticsPage() {
  await requireRole('DIRECTOR', 'ADMIN');
  const { summary, criteria, bottlenecks, atRiskTrend, cohortRollup } =
    await getDirectorAnalytics();

  const worst = bottlenecks[0];
  const atRiskPct =
    summary.studentCount > 0 ? (summary.atRiskCount / summary.studentCount) * 100 : 0;

  const barData = bottlenecks.map((course) => ({
    label: course.courseCode,
    value: course.completionPct,
  }));

  // The chart wrappers are client components, so only plain values cross the
  // boundary — the week-start Dates are formatted upstream.
  const trendData = atRiskTrend.map((point) => ({ label: point.label, value: point.value }));
  const firstWeek = atRiskTrend[0];
  const lastWeek = atRiskTrend[atRiskTrend.length - 1];
  const trendChange = lastWeek && firstWeek ? lastWeek.value - firstWeek.value : 0;

  const trendSentence =
    lastWeek && firstWeek
      ? `${lastWeek.value} ${plural(lastWeek.value, 'student is', 'students are')} at risk this week, ${
          trendChange === 0
            ? 'unchanged from six weeks ago.'
            : trendChange > 0
              ? `${trendChange} more than six weeks ago.`
              : `${Math.abs(trendChange)} fewer than six weeks ago.`
        }`
      : null;

  const cohortRows: CohortRowView[] = cohortRollup.map((row) => ({
    id: row.cohort.id,
    code: row.cohort.code,
    name: row.cohort.name,
    batchLabel: row.cohort.batchLabel,
    studentCount: row.studentCount,
    reepPct: Math.round(row.reepPct),
    placementReadyPct: Math.round(row.placementReadyPct),
    atRisk: row.atRisk,
  }));

  const strongestCohort = [...cohortRollup].sort((a, b) => b.reepPct - a.reepPct)[0];
  const weakestCohort = [...cohortRollup].sort((a, b) => a.reepPct - b.reepPct)[0];

  return (
    <SurfaceScene>
      {/* --- the hero: the four numbers, read as one row ------------------ */}
      <GlassPanel sx={{ mb: 5 }}>
        <PageIntro
          title="Cohort analytics"
          subtitle={`${summary.studentCount} students across ${summary.cohortCount} cohorts, recomputed on every load.`}
          action={
            <Button href="/director/placement" endIcon={<ArrowForwardRounded />}>
              Placement readiness
            </Button>
          }
          sx={{ mb: 3.5 }}
        />

        <Grid container spacing={2.5}>
          <Grid size={{ xs: 6, md: 3 }}>
            <NeuStat
              label="REEP completion"
              value={`${summary.reepCompletion.toFixed(0)}%`}
              progress={summary.reepCompletion}
              hint={`Mean across all ${summary.studentCount} students`}
            />
          </Grid>
          <Grid size={{ xs: 6, md: 3 }}>
            <NeuStat
              label="Certification completion"
              value={`${summary.certCompletion.toFixed(0)}%`}
              progress={summary.certCompletion}
              hint="Required certifications finished"
            />
          </Grid>
          <Grid size={{ xs: 6, md: 3 }}>
            <NeuStat
              label="Placement-ready"
              value={`${summary.placementReadyPct.toFixed(0)}%`}
              tone={summary.placementReadyPct >= 50 ? 'good' : 'warning'}
              progress={summary.placementReadyPct}
              hint={`Clearing ${criteria.minReepCompletionPct}% REEP and ${criteria.minAttendancePct}% attendance`}
            />
          </Grid>
          <Grid size={{ xs: 6, md: 3 }}>
            <NeuStat
              label="At-risk students"
              value={summary.atRiskCount}
              tone={summary.atRiskCount > 0 ? 'critical' : 'good'}
              hint={`${atRiskPct.toFixed(0)}% of the programme has an open critical flag`}
            />
          </Grid>
        </Grid>
      </GlassPanel>

      <Grid container spacing={{ xs: 0, lg: 6 }}>
        {/* --- where the programme is stuck ------------------------------- */}
        <Grid size={{ xs: 12, lg: 7 }}>
          <SectionCard
            title="Course bottlenecks"
            subtitle="The six weakest courses, averaged across everyone enrolled"
          >
            <ChartPanel>
              {barData.length === 0 ? (
                <EmptyState title="No course has any enrolments yet." />
              ) : (
                <>
                  {worst && (
                    <Lead
                      detail={`${worst.courseName} · ${worst.enrolledCount} ${plural(
                        worst.enrolledCount,
                        'student',
                        'students',
                      )} enrolled${
                        worst.atRiskCount > 0
                          ? `, ${worst.atRiskCount} already carrying a critical flag`
                          : ''
                      }.`}
                    >
                      {worst.courseCode} is the tightest bottleneck at {worst.completionPct}% mean
                      completion.
                    </Lead>
                  )}
                  <RankedBarChart data={barData} scale="percentage" />
                </>
              )}
            </ChartPanel>
          </SectionCard>
        </Grid>

        {/* --- is the problem growing or shrinking? ----------------------- */}
        <Grid size={{ xs: 12, lg: 5 }}>
          <SectionCard
            title="At-risk students"
            subtitle="Distinct students carrying an open critical flag, by week"
          >
            <ChartPanel>
              {trendSentence ? <Lead>{trendSentence}</Lead> : null}
              <TrendChart data={trendData} label="At-risk students" />
            </ChartPanel>
          </SectionCard>
        </Grid>
      </Grid>

      {/* --- cohort comparison -------------------------------------------- */}
      <SectionCard
        title="Cohort comparison"
        subtitle="Both percentages sit on the same 0–100 scale"
      >
        <NeuPanel sx={{ px: { xs: 1.5, sm: 2 } }}>
          {cohortRows.length === 0 ? (
            <EmptyState title="No cohorts have been set up yet." />
          ) : (
            <>
              {strongestCohort && weakestCohort && strongestCohort !== weakestCohort && (
                <Lead>
                  {strongestCohort.cohort.code} is furthest along at{' '}
                  {strongestCohort.reepPct.toFixed(0)}% mean completion;{' '}
                  {weakestCohort.cohort.code} trails at {weakestCohort.reepPct.toFixed(0)}%.
                </Lead>
              )}
              <DirectorCohortGrid rows={cohortRows} />
            </>
          )}
        </NeuPanel>
      </SectionCard>

      <TechNote>
        Nothing here is stored. Every figure is recomputed from the same functions
        the student and mentor screens use, so a number can never mean one thing on
        this page and something else on a mentor&apos;s. A course counts as a
        bottleneck when the <em>whole</em> group enrolled on it is stuck, not when one
        student is — the bar is the mean of each student&apos;s own course completion,
        weighted by course hours. The at-risk line counts distinct students, so
        somebody with three open flags is still one person. &ldquo;Placement-ready&rdquo;
        reads the one active <code>PlacementCriteria</code> row, which a director edits
        on the Placement readiness screen; the thresholds are data rather than code
        because REEP weightings are re-agreed every intake. The depth is presentation only,
        driven by custom properties in <code>src/theme.ts</code>; the chart panels
        deliberately pin their fill back to <code>background.default</code>, because the
        four-slot categorical palette was validated against that exact surface and a
        gradient underneath it would move each mark off the contrast floor it cleared.
      </TechNote>
    </SurfaceScene>
  );
}
