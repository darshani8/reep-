import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import {
  EmptyState,
  MeterRow,
  PageIntro,
  SectionCard,
  StatCard,
  TechNote,
} from '@/components/kit';
import {
  DirectorPlacementGrid,
  type PlacementRowView,
} from '@/components/director-placement-grid';
import { requireRole } from '@/lib/auth';
import { getDirectorAnalytics } from '@/lib/queries';
import { CriteriaForm } from './criteria-form';

export const metadata = { title: 'Placement readiness — Director' };
export const dynamic = 'force-dynamic';

/// The check list is criteria-driven, but its order and labels are fixed by
/// evaluatePlacementReadiness(), so the columns can be named here.
const REEP = 'REEP completion';
const CERTS = 'Certification completion';
const ATTENDANCE = 'Attendance';
const CORE = 'Core certifications';

export default async function DirectorPlacementPage() {
  await requireRole('DIRECTOR', 'ADMIN');
  const { criteria, perStudent, summary } = await getDirectorAnalytics();

  const ready = perStudent.filter((entry) => entry.placement.ready);
  const blocked = perStudent.filter((entry) => !entry.placement.ready);
  const oneAway = blocked.filter((entry) => entry.placement.failed.length === 1);

  // Which single criterion, relaxed, would free the most people? That is the
  // programme-level lever — everything else is per-student mentoring.
  const blockCounts = new Map<string, number>();
  for (const entry of blocked) {
    for (const label of entry.placement.failed) {
      blockCounts.set(label, (blockCounts.get(label) ?? 0) + 1);
    }
  }
  const blockers = [...blockCounts.entries()]
    .map(([label, count]) => ({
      label,
      count,
      soleBlockFor: oneAway.filter((entry) => entry.placement.failed[0] === label).length,
    }))
    .sort((a, b) => b.count - a.count);
  const topBlocker = blockers[0];

  // Stated in words above the meters, so the lever is readable without reading
  // a bar against the others.
  const blockerSentence = topBlocker
    ? `${topBlocker.label} is the one to fix first: it blocks ${
        topBlocker.count === blocked.length ? 'every one of the' : `${topBlocker.count} of the`
      } ${blocked.length} students who are not yet ready${
        topBlocker.soleBlockFor > 0
          ? `, and for ${topBlocker.soleBlockFor} of them it is the only thing in the way.`
          : ', though never on its own — everyone it blocks has another gap as well.'
      }`
    : null;

  const rows: PlacementRowView[] = perStudent.map((entry) => {
    const find = (label: string) => entry.placement.checks.find((check) => check.label === label);
    const reep = find(REEP);
    const certs = find(CERTS);
    const attendance = find(ATTENDANCE);
    const core = find(CORE);

    return {
      id: entry.student.id,
      name: entry.student.user.name,
      usn: entry.student.usn,
      cohort: entry.student.cohort.code,
      ready: entry.placement.ready,
      gaps: entry.placement.failed.length,
      reepPct: Math.round(entry.reepPct),
      reepActual: reep?.actual ?? '—',
      reepPassed: reep?.passed ?? true,
      certPct: Math.round(entry.certCompletionPct),
      certActual: certs?.actual ?? '—',
      certPassed: certs?.passed ?? true,
      attendancePct: Math.round(entry.attendancePct),
      attendanceActual: attendance?.actual ?? '—',
      attendancePassed: attendance?.passed ?? true,
      coreActual: core?.actual ?? '—',
      corePassed: core?.passed ?? true,
    };
  });

  // Not-ready students first, most gaps at the top — the people who need work.
  const sorted = [...rows].sort(
    (a, b) =>
      Number(a.ready) - Number(b.ready) || b.gaps - a.gaps || a.name.localeCompare(b.name),
  );

  return (
    <>
      <PageIntro
        title="Placement readiness"
        subtitle={`${ready.length} of ${summary.studentCount} students clear every criterion today.`}
      />

      <Grid container spacing={4} sx={{ mb: 7 }}>
        <Grid size={{ xs: 6, sm: 4 }}>
          <StatCard
            label="Placement-ready"
            value={`${summary.placementReadyPct.toFixed(0)}%`}
            tone={summary.placementReadyPct >= 50 ? 'good' : 'warning'}
            hint={`${ready.length} students pass every check`}
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 4 }}>
          <StatCard
            label="Not there yet"
            value={blocked.length}
            tone={blocked.length > 0 ? 'critical' : 'good'}
            hint="Missing at least one criterion"
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 4 }}>
          <StatCard
            label="One criterion away"
            value={oneAway.length}
            tone={oneAway.length > 0 ? 'warning' : 'neutral'}
            hint="Would qualify if a single gap closed"
          />
        </Grid>
      </Grid>

      <Grid container spacing={{ xs: 0, lg: 6 }}>
        {/* --- the rule itself, editable ---------------------------------- */}
        <Grid size={{ xs: 12, lg: 7 }}>
          <SectionCard
            title="Eligibility criteria"
            subtitle="Saving these re-checks every student immediately"
          >
            <CriteriaForm
              criteria={{
                minReepCompletionPct: criteria.minReepCompletionPct,
                minCertCompletionPct: criteria.minCertCompletionPct,
                minAttendancePct: criteria.minAttendancePct,
                requireCoreCerts: criteria.requireCoreCerts,
              }}
            />
          </SectionCard>
        </Grid>

        {/* --- what the rule is actually catching -------------------------- */}
        <Grid size={{ xs: 12, lg: 5 }}>
          <SectionCard
            title="What is holding students back"
            subtitle="Each criterion, counted across everyone not yet ready"
          >
            {!topBlocker ? (
              <EmptyState
                title="Every student clears the current criteria."
                hint="Raise a threshold on the left to see where the programme would start to strain."
              />
            ) : (
              <>
                <Box sx={{ mb: 3, maxWidth: '72ch' }}>
                  <Typography variant="body1">{blockerSentence}</Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    Each bar is the share of the whole programme that criterion blocks. A student
                    failing two criteria is counted under both.
                  </Typography>
                </Box>

                <Stack spacing={2.5}>
                  {blockers.map((blocker) => (
                    <MeterRow
                      key={blocker.label}
                      label={blocker.label}
                      value={
                        summary.studentCount > 0
                          ? (blocker.count / summary.studentCount) * 100
                          : 0
                      }
                      tone={blocker === topBlocker ? 'critical' : 'warning'}
                      labelWidth={168}
                      hint={`${blocker.count} blocked`}
                    />
                  ))}
                </Stack>
              </>
            )}
          </SectionCard>
        </Grid>
      </Grid>

      <SectionCard
        title="Every student against today's criteria"
        subtitle="Not-ready students first, biggest gaps at the top"
      >
        {sorted.length === 0 ? (
          <EmptyState title="No students to evaluate yet." />
        ) : (
          <DirectorPlacementGrid
            rows={sorted}
            headers={{
              reep: `REEP ≥ ${criteria.minReepCompletionPct}%`,
              cert: `Certifications ≥ ${criteria.minCertCompletionPct}%`,
              attendance: `Attendance ≥ ${criteria.minAttendancePct}%`,
              core: 'Core certifications',
            }}
            showCore={criteria.requireCoreCerts}
          />
        )}
      </SectionCard>

      <TechNote>
        &ldquo;Placement-ready&rdquo; is not a column anyone ticks. It is recomputed on
        every read from the one active <code>PlacementCriteria</code> row: REEP
        completion, certification completion and attendance each over their own floor,
        plus an optional all-or-nothing gate on the core certifications. The form above
        writes that row, and that is the whole point — the placement cell re-negotiates
        these rules each intake and the REEP weightings behind them move year to year, so
        the rule has to be data a director can edit rather than a constant a developer has
        to redeploy. Because nothing is cached, saving a threshold re-evaluates all{' '}
        {summary.studentCount} students on the next page load; there is no stored flag to
        backfill. The table keeps an <code>active</code> boolean rather than a single row,
        so next year&apos;s intake can be given its own criteria set while this
        year&apos;s definition of &ldquo;ready&rdquo; is kept alongside it for audit
        instead of being overwritten.
      </TechNote>
    </>
  );
}
