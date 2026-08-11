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
  DirectorCertificationsGrid,
  type CertRowView,
} from '@/components/director-certifications-grid';
import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  DEFAULT_PACE_THRESHOLDS,
  certificationStatus,
  type CertProgressWithCert,
} from '@/lib/progress';
import { STAGE_LABEL, formatHours } from '@/lib/reep';
import type { ProgressStatus } from '@prisma/client';

export const metadata = { title: 'Certifications — Director' };
export const dynamic = 'force-dynamic';

export default async function DirectorCertificationsPage() {
  await requireRole('DIRECTOR', 'ADMIN');

  // The student screens ask "how is this student doing?". This one asks the
  // transpose — "how is the whole programme doing on this certification?" — so
  // it reads the catalogue with every progress row attached.
  const certs = await prisma.certification.findMany({
    include: { course: true, progress: true },
    orderBy: [{ courseCode: 'asc' }, { name: 'asc' }],
  });

  const now = new Date();
  const studentsBehind = new Set<string>();

  const rows: CertRowView[] = certs.map((cert) => {
    const progress: CertProgressWithCert[] = cert.progress.map((row) => ({ ...row, cert }));
    const evaluated = progress.map((row) => ({ row, ...certificationStatus(row, now) }));

    const assigned = evaluated.length;
    const count = (status: ProgressStatus) =>
      evaluated.filter((entry) => entry.status === status).length;

    const overdue = evaluated.filter((entry) => entry.status === 'OVERDUE');
    for (const entry of overdue) studentsBehind.add(entry.row.studentId);

    const mean = (pick: (entry: (typeof evaluated)[number]) => number) =>
      assigned > 0 ? evaluated.reduce((sum, entry) => sum + pick(entry), 0) / assigned : 0;

    // "Systematically behind" is a cohort judgement: the *average* student on
    // this certification has slipped past the same deviation that marks one
    // individual as behind pace.
    const deviationPct = mean((e) => e.pace.actualPct) - mean((e) => e.pace.expectedPct);

    return {
      id: cert.code,
      name: cert.name,
      provider: cert.provider,
      courseCode: cert.courseCode,
      courseName: cert.course.name,
      stage: STAGE_LABEL[cert.course.stage],
      requiredHours: cert.requiredHours,
      requiredHoursLabel: formatHours(cert.requiredHours),
      assigned,
      completed: count('COMPLETED'),
      inProgress: count('IN_PROGRESS'),
      overdue: overdue.length,
      completionPct: assigned > 0 ? (count('COMPLETED') / assigned) * 100 : 0,
      behind: assigned > 0 && deviationPct < -DEFAULT_PACE_THRESHOLDS.behindDeviationPct,
      optional: cert.isOptional,
      meanProgressPct: mean((e) => e.row.progressPct),
      deviationPct,
    };
  });

  const tracked = rows.filter((row) => row.assigned > 0);
  const weakestFirst = [...tracked].sort((a, b) => a.completionPct - b.completionPct);
  const behind = weakestFirst.filter((row) => row.behind);
  // Biggest slip first — that is the one the lead sentence names.
  const worstBehind = [...behind].sort((a, b) => a.deviationPct - b.deviationPct)[0];

  const totalAssigned = tracked.reduce((sum, row) => sum + row.assigned, 0);
  const totalCompleted = tracked.reduce((sum, row) => sum + row.completed, 0);
  const completionRate = totalAssigned > 0 ? (totalCompleted / totalAssigned) * 100 : 0;
  const totalOverdue = tracked.reduce((sum, row) => sum + row.overdue, 0);

  return (
    <>
      <PageIntro
        title="Certifications"
        subtitle={`${tracked.length} certifications being worked on, across ${totalAssigned} student enrolments.`}
      />

      <Grid container spacing={4} sx={{ mb: 7 }}>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Completion rate"
            value={`${completionRate.toFixed(0)}%`}
            hint={`${totalCompleted} of ${totalAssigned} finished`}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Certifications tracked"
            value={tracked.length}
            hint={`${rows.filter((row) => row.optional).length} of them optional`}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Students running late"
            value={studentsBehind.size}
            tone={studentsBehind.size > 0 ? 'warning' : 'good'}
            hint={`${totalOverdue} overdue certifications between them`}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Whole cohort behind"
            value={behind.length}
            tone={behind.length > 0 ? 'critical' : 'good'}
            hint="Certifications where the average student has slipped"
          />
        </Grid>
      </Grid>

      {/* --- the programme-level problem, not the individual one ---------- */}
      <SectionCard
        title="Where the whole cohort is behind"
        subtitle="Certifications the average student — not just a few — has fallen behind on"
      >
        {behind.length === 0 ? (
          <EmptyState
            title="No certification is behind across the cohort."
            hint="Individual students may still be running late. Those show up on the mentor alerts screen, where somebody can act on them."
          />
        ) : (
          <>
            <Box sx={{ mb: 3, maxWidth: '72ch' }}>
              <Typography variant="body1">
                {behind.length === 1
                  ? `${worstBehind?.name} is behind for the group as a whole, ${Math.abs(
                      worstBehind?.deviationPct ?? 0,
                    ).toFixed(0)} points under where it should be by now.`
                  : `${behind.length} certifications are behind for the group as a whole, ${worstBehind?.name} worst at ${Math.abs(
                      worstBehind?.deviationPct ?? 0,
                    ).toFixed(0)} points under the expected curve.`}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                That usually points at how a certification is sequenced or taught rather than at
                the students on it. Each bar is the group&apos;s mean progress with the provider;
                the figure beside it is how far under the curve that sits.
              </Typography>
            </Box>

            <Stack spacing={2.5}>
              {behind.map((row) => (
                <MeterRow
                  key={row.id}
                  label={row.name}
                  value={row.meanProgressPct}
                  tone="critical"
                  labelWidth={220}
                  hint={`${row.deviationPct.toFixed(0)} pts behind`}
                />
              ))}
            </Stack>
          </>
        )}
      </SectionCard>

      <SectionCard title="All certifications" subtitle="Weakest completion first">
        {tracked.length === 0 ? (
          <EmptyState title="No certifications have been assigned to students yet." />
        ) : (
          <DirectorCertificationsGrid rows={weakestFirst} />
        )}
      </SectionCard>

      <TechNote>
        This screen is the student certification tracker turned on its side: the same
        rows and the same <code>certificationStatus()</code> verdict, grouped by
        certification instead of by student. A certification counts as behind when the
        group&apos;s mean progress sits more than{' '}
        {DEFAULT_PACE_THRESHOLDS.behindDeviationPct} points under the group&apos;s mean
        expected progress — the same tolerance a single student is judged by — so the
        flag fires when the certification is the problem rather than when a handful of
        people are. Overdue means past the due date <em>or</em> more than{' '}
        {DEFAULT_PACE_THRESHOLDS.atRiskDeviationPct} points below the expected curve,
        because somebody who will clearly miss the date is worth chasing before it
        arrives. Progress comes from the provider where an integration exists and is
        self-reported otherwise; the <code>selfReported</code> flag on each row is what an
        audit view would filter on.
      </TechNote>
    </>
  );
}
