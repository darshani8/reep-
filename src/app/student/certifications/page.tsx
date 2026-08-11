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
import { prisma } from '@/lib/db';
import { getStudentCertifications } from '@/lib/queries';
import { STAGE_LABEL, STAGE_ORDER, STATUS_LABEL, formatHours, relativeDay } from '@/lib/reep';
import type { ProgressStatus, Stage } from '@prisma/client';

import { CertificationsGrid, type CertRowView } from './certifications-grid';
import { SyncButton } from './sync-button';

export const metadata = { title: 'Certifications — Student' };
export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<ProgressStatus, Tone> = {
  COMPLETED: 'good',
  IN_PROGRESS: 'warning',
  OVERDUE: 'critical',
  NOT_STARTED: 'neutral',
};

export default async function StudentCertificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string | string[] }>;
}) {
  const { studentId } = await requireStudent();
  const data = await getStudentCertifications(studentId);
  if (!data) notFound();

  const { rows, summary } = data;
  const activeStage = parseStage((await searchParams).stage);
  const now = new Date();

  // Certificates the student has already filed. A rejected proof does not
  // count — it still needs re-uploading.
  const proofs = await prisma.upload.findMany({
    where: { studentId, certCode: { not: null }, status: { not: 'REJECTED' } },
    select: { certCode: true },
  });
  const evidenced = new Set(proofs.map((proof) => proof.certCode));

  const visible = activeStage ? rows.filter((row) => row.stage === activeStage) : rows;

  // The four numbers describe the table under them, so they follow the filter.
  const counts = {
    required: visible.filter((row) => !row.cert.cert.isOptional).length,
    completed: visible.filter((row) => row.status === 'COMPLETED').length,
    inProgress: visible.filter((row) => row.status === 'IN_PROGRESS').length,
    overdue: visible.filter((row) => row.status === 'OVERDUE').length,
  };
  const optionalCount = visible.length - counts.required;

  const stageCounts = Object.fromEntries(
    STAGE_ORDER.map((stage) => [stage, rows.filter((row) => row.stage === stage).length]),
  ) as Record<Stage, number>;

  const missingProof = rows.filter(
    (row) => row.status === 'COMPLETED' && !evidenced.has(row.cert.certCode),
  );

  const gridRows: CertRowView[] = visible.map(({ cert, status, pace, stage, courseCode }) => {
    const due = describeDue(status, cert.dueDate, cert.completedAt, now);
    const provenance = describeSource(cert.selfReported, cert.lastSyncedAt, now);

    return {
      id: cert.id,
      courseCode,
      stageLabel: STAGE_LABEL[stage],
      name: cert.cert.name,
      hoursLabel: `${formatHours(cert.hoursLogged)} of ${formatHours(cert.cert.requiredHours)} logged`,
      isOptional: cert.cert.isOptional,
      provider: cert.cert.provider,
      provenance,
      sourceLabel: `${cert.cert.provider} · ${provenance.toLowerCase()}`,
      status,
      statusLabel: STATUS_LABEL[status],
      statusTone: STATUS_TONE[status],
      actualPct: Math.round(pace.actualPct),
      expectedPct: Math.round(pace.expectedPct),
      showExpected: status !== 'COMPLETED',
      dueLabel: due.label,
      dueTone: due.tone,
      dueSort: due.sort,
    };
  });

  const required = rows.filter((row) => !row.cert.cert.isOptional);
  const requiredDone = required.filter((row) => row.status === 'COMPLETED').length;

  return (
    <>
      <PageIntro
        title="Certifications"
        subtitle={
          summary.required === 0
            ? 'No required certifications are mapped to your courses yet.'
            : `You have finished ${requiredDone} of the ${summary.required} certifications required across REEP.`
        }
        action={<SyncButton />}
      />

      {missingProof.length > 0 && (
        <InfoBanner
          title="Send your certificates to your mentor"
          action={
            <Button href="/student/uploads" size="small" color="inherit">
              Go to Uploads
            </Button>
          }
        >
          {missingProof.length === 1
            ? `You have finished ${missingProof[0].cert.cert.name} but not uploaded the certificate yet.`
            : `${missingProof.length} finished certifications have no certificate uploaded yet.`}{' '}
          Once the file is there your mentor can mark the progress verified instead of
          self-reported.
        </InfoBanner>
      )}

      <Grid container spacing={2.5} sx={{ mb: 3 }}>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Required"
            value={counts.required}
            hint={
              optionalCount > 0
                ? `Plus ${optionalCount} optional, not counted here`
                : 'Every one listed is mandatory'
            }
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Completed"
            value={counts.completed}
            tone="good"
            hint={
              visible.length > 0
                ? `${Math.round((counts.completed / visible.length) * 100)}% of the ones shown`
                : 'Nothing to show yet'
            }
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="In progress"
            value={counts.inProgress}
            tone="warning"
            hint="Started and keeping up with the plan"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Overdue"
            value={counts.overdue}
            tone="critical"
            hint={
              counts.overdue > 0
                ? 'Behind the pace needed to finish in time'
                : 'Nothing behind pace'
            }
          />
        </Grid>
      </Grid>

      {/* --- stage filter ----------------------------------------------- */}
      <Box sx={{ mb: 4 }} className="no-print">
        <Tabs
          value={activeStage ?? 'ALL'}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          aria-label="Show one REEP stage at a time"
        >
          {[
            {
              value: 'ALL',
              label: `All stages · ${rows.length}`,
              href: '/student/certifications',
            },
            ...STAGE_ORDER.map((stage) => ({
              value: stage as string,
              label: `${STAGE_LABEL[stage]} · ${stageCounts[stage]}`,
              href: `/student/certifications?stage=${stage}`,
            })),
          ].map((tab) => (
            <Tab key={tab.value} value={tab.value} label={tab.label} href={tab.href} />
          ))}
        </Tabs>
      </Box>

      <SectionCard
        title={activeStage ? `${STAGE_LABEL[activeStage]} certifications` : 'All certifications'}
        subtitle={
          activeStage
            ? `${visible.length} of your ${rows.length} certifications sit in this stage`
            : 'Search by name, or filter down to the ones that need attention'
        }
      >
        {visible.length === 0 ? (
          <EmptyState
            title={
              activeStage
                ? `Nothing mapped to ${STAGE_LABEL[activeStage]} yet.`
                : 'No certifications yet.'
            }
            hint="Certifications appear here as soon as you are enrolled on the courses that carry them."
          />
        ) : (
          <CertificationsGrid rows={gridRows} />
        )}
      </SectionCard>

      <TechNote>
        Where the provider has an API — Coursera&apos;s Partner API is the only one wired up
        today — the completion % is pulled straight from it and stamped with the time of the
        pull. Everything else is the student&apos;s own number, which the mentor checks against
        the certificate on the Uploads screen; the Provider column always says which of the two
        you are reading, because they are not equally good evidence. &ldquo;Overdue&rdquo; here
        is a pace judgement, not a calendar one: a certification is flagged once actual
        completion drops below the expected curve for today, so it can read Overdue days before
        its due date. That curve lives in <code>src/lib/progress.ts</code> (
        <code>certificationStatus</code> and <code>evaluatePace</code>), and its value for today
        is the &ldquo;expected&nbsp;%&rdquo; printed beside every meter.
      </TechNote>
    </>
  );
}

/// Unknown or repeated ?stage= values fall back to "all" rather than 404 — the
/// filter is a view preference, not a resource identifier.
function parseStage(value: string | string[] | undefined): Stage | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && (STAGE_ORDER as string[]).includes(raw) ? (raw as Stage) : null;
}

/// "Coursera, synced today" against "the student typed this in" — the mentor's
/// whole verification job hangs on the difference.
function describeSource(
  selfReported: boolean,
  lastSyncedAt: Date | null,
  now: Date,
): string {
  if (selfReported || !lastSyncedAt) return 'Self-reported';
  return `Synced ${relativeDay(lastSyncedAt, now).toLowerCase()}`;
}

/// Plain words rather than a date the reader has to subtract from today.
/// `sort` is days remaining, so sorting the column puts the worst first.
function describeDue(
  status: ProgressStatus,
  dueDate: Date,
  completedAt: Date | null,
  now: Date,
): { label: string; tone: Tone; sort: number } {
  const startOf = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(dueDate) - startOf(now)) / 86_400_000);

  if (status === 'COMPLETED') {
    const when = completedAt
      ? completedAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
      : null;
    return { label: when ? `Done ${when}` : 'Done', tone: 'good', sort: 10_000 };
  }

  if (days === 0) return { label: 'Due today', tone: 'warning', sort: 0 };

  if (days < 0) {
    const late = Math.abs(days);
    return {
      label: late === 1 ? '1 day overdue' : `${late} days overdue`,
      tone: 'critical',
      sort: days,
    };
  }

  return {
    label: days === 1 ? '1 day left' : `${days} days left`,
    tone: days <= 7 ? 'warning' : 'neutral',
    sort: days,
  };
}
