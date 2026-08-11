import { notFound } from 'next/navigation';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

import {
  EmptyState,
  MeterRow,
  PageIntro,
  ProgressMeter,
  SectionCard,
  StatCard,
  StatusChip,
  TechNote,
  type Tone,
} from '@/components/kit';
import { focusQuality } from '@/lib/analytics';
import { requireMentor } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { menteeWhere } from '@/lib/mentor-scope';
import { certificationStatus, type CertProgressWithCert } from '@/lib/progress';
import { getMentorCohortForSession } from '@/lib/queries';
import {
  ALERT_RULE_LABEL,
  PACE_LABEL,
  SEVERITY_LABEL,
  STAGE_LABEL,
  formatPct,
  relativeDay,
} from '@/lib/reep';
import { ALL_RULE_KEYS } from '@/lib/rules';
import type { AlertSeverity, PaceStatus, Stage } from '@prisma/client';

import { SEVERITY_RANK, SEVERITY_TONE } from '../alerts/severity';
import { PrintButton } from './print-button';

export const metadata = { title: 'Cohort Report — Mentor' };
export const dynamic = 'force-dynamic';

const PACE_TONE: Record<PaceStatus, Tone> = {
  ON_TRACK: 'good',
  BEHIND: 'warning',
  AT_RISK: 'critical',
};

/// 20-point bands: enough shape for a group of a dozen without inventing
/// precision that is not there.
const FOCUS_BANDS = [80, 60, 40, 20, 0];

const HEAD_CELL = { whiteSpace: 'nowrap' } as const;
const NUM_CELL = { whiteSpace: 'nowrap', textAlign: 'right' } as const;

/// Sections short enough to sit on one page say so, and the browser will move
/// the whole block rather than orphan a heading at the foot of a page.
const KEEP_TOGETHER = { breakInside: 'avoid' } as const;

/**
 * This page is a document before it is a screen.
 *
 * The app chrome and the toolbar already carry `.no-print`, so the only work
 * left is to stop the *screen* from following the report onto paper: a mentor
 * printing in dark mode would otherwise get white text on a white sheet, and
 * every hairline would print as a light-on-dark rule. So inside the report the
 * ink is forced black and every fill is dropped — with one exception, the
 * progress meters, which are the one place where the fill is the information.
 * Even there the percentage is printed beside the bar, so a black-and-white
 * printer that drops backgrounds loses nothing.
 */
const PRINT_CSS = `
@page { margin: 12mm; }

@media print {
  /* The shell paints the page, and in dark mode that page is near-black. This
     stylesheet only exists on the report route, so stripping every fill here is
     safe and is what printing should mean anyway. */
  html, body { background: #ffffff !important; }
  * { background-color: transparent !important; box-shadow: none !important; }

  #cohort-report, #cohort-report * {
    color: #000000 !important;
    border-color: rgba(0, 0, 0, 0.22) !important;
  }

  /* The one exception: a meter's fill is its value. The percentage is printed
     beside every bar, so nothing is lost if a printer drops it anyway. */
  #cohort-report .MuiLinearProgress-root {
    background-color: rgba(0, 0, 0, 0.13) !important;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  #cohort-report .MuiLinearProgress-bar {
    background-color: rgba(0, 0, 0, 0.62) !important;
  }

  /* A scroll container clips on paper. */
  #cohort-report .MuiTableContainer-root { overflow: visible !important; }
  #cohort-report table { width: 100% !important; }

  /* A heading never ends a page, a row never straddles one, and a table that
     spills reprints its own header on the next sheet. */
  #cohort-report h1, #cohort-report h2, #cohort-report h3, #cohort-report h4 {
    break-after: avoid;
  }
  #cohort-report thead { display: table-header-group; }
  #cohort-report tr { break-inside: avoid; }
}
`;

export default async function MentorReportsPage() {
  const session = await requireMentor();

  // Scoped by role, not by whether the token happens to carry a mentor group.
  // `if (!session.mentorId)` pointed the right way by luck here — a mentor
  // account with no `Mentor` row landed on the empty state rather than on a
  // roster — but it was still answering the wrong question, and it told that
  // account it was signed in as programme staff. The detail screen and the alert
  // scan asked the same question and the luck ran the other way.
  const scoped = await getMentorCohortForSession(session);
  if (scoped.kind === 'denied') notFound();

  if (scoped.kind === 'no-group') {
    return (
      <>
        <PageIntro
          title="Cohort report"
          subtitle="One printable page covering the whole mentor group."
        />
        <EmptyState
          title="This report belongs to a mentor group."
          hint="You are signed in as programme staff without one. The Director analytics cover the whole programme."
        />
        <TechNote>
          The report is scoped by the caller&rsquo;s <em>role</em> rather than by the
          presence of a <code>mentorId</code> on the session, so a director or admin — who
          has no mentor group — lands here rather than on an empty table, while a mentor
          account with no mentor record gets nothing at all rather than the programme. The
          CSV route at <code>/mentor/reports/export</code> answers the same way.
        </TechNote>
      </>
    );
  }

  const data = scoped.cohort;

  // getMentorCohort returns the roster summary; the certification and focus
  // sections need the underlying rows, which that summary deliberately drops.
  // Same scope, same helper — the two halves of the page cannot disagree about
  // whose students they are describing.
  const students = await prisma.student.findMany({
    where: menteeWhere(session),
    include: {
      user: { select: { name: true } },
      cohort: { select: { code: true, batchLabel: true } },
      labSessions: true,
      certProgress: { include: { cert: { include: { course: true } } } },
    },
    orderBy: { user: { name: 'asc' } },
  });

  const now = new Date();
  const cohortCodes = [...new Set(students.map((s) => s.cohort.code))].sort();
  const batchLabels = [...new Set(students.map((s) => s.cohort.batchLabel))].sort();
  const generatedOn = now.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });

  // --- certification completion, per course ---------------------------------
  const courseMap = new Map<
    string,
    { name: string; stage: Stage; total: number; completed: number; overdue: number; sum: number }
  >();
  for (const student of students) {
    for (const progress of student.certProgress as CertProgressWithCert[]) {
      const key = progress.cert.courseCode;
      const entry = courseMap.get(key) ?? {
        name: progress.cert.course.name,
        stage: progress.cert.course.stage,
        total: 0,
        completed: 0,
        overdue: 0,
        sum: 0,
      };
      const { status } = certificationStatus(progress, now);
      entry.total += 1;
      entry.sum += progress.progressPct;
      if (status === 'COMPLETED') entry.completed += 1;
      if (status === 'OVERDUE') entry.overdue += 1;
      courseMap.set(key, entry);
    }
  }
  const courseRows = [...courseMap.entries()]
    .map(([code, entry]) => ({
      code,
      name: entry.name,
      stage: entry.stage,
      enrolments: entry.total,
      completed: entry.completed,
      overdue: entry.overdue,
      completionPct: entry.total > 0 ? (entry.completed / entry.total) * 100 : 0,
      avgProgressPct: entry.total > 0 ? entry.sum / entry.total : 0,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));

  // --- open alerts, per rule ------------------------------------------------
  const ruleRows = ALL_RULE_KEYS.map((ruleKey) => {
    const firing = data.alerts.filter((a) => a.ruleTriggered === ruleKey);
    const severity = firing.reduce<AlertSeverity | null>(
      (worst, a) =>
        worst == null || SEVERITY_RANK[a.severity] > SEVERITY_RANK[worst] ? a.severity : worst,
      null,
    );
    return {
      ruleKey,
      label: ALERT_RULE_LABEL[ruleKey],
      count: firing.length,
      students: new Set(firing.map((a) => a.studentId)).size,
      severity,
    };
  }).sort((a, b) => b.count - a.count);

  // --- focus score distribution --------------------------------------------
  const focusScores = students.map((s) => focusQuality(s.labSessions).focusScore);
  const distribution = FOCUS_BANDS.map((low) => {
    const high = low + 19;
    const count = focusScores.filter((score) => score >= low && score <= high).length;
    return {
      label: `${low}–${low === 80 ? 100 : high}`,
      count,
      sharePct: focusScores.length > 0 ? (count / focusScores.length) * 100 : 0,
    };
  });
  const medianFocus = median(focusScores);
  const lowestBand = distribution[distribution.length - 1].count;

  return (
    <Box id="cohort-report">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      <PageIntro
        title="Cohort report"
        subtitle={`${data.mentor.user.name} · mentor group ${data.mentor.mentorGroup} · ${cohortCodes.join(', ')} (${batchLabels.join(', ')}) · generated ${generatedOn}`}
        action={
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            {/* A plain anchor, not a router link: the target is a CSV route
                handler, and the browser has to see the download response. */}
            <Button component="a" href="/mentor/reports/export" sx={{ color: 'text.secondary' }}>
              Download CSV
            </Button>
            <PrintButton />
          </Stack>
        }
      />

      <Grid container spacing={2.5} sx={{ mb: 5, ...KEEP_TOGETHER }}>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Mentees"
            value={data.summary.studentCount}
            hint={`${cohortCodes.length} cohort${cohortCodes.length === 1 ? '' : 's'}`}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Average completion"
            value={formatPct(data.summary.avgCompletion)}
            tone={completionTone(data.summary.avgCompletion)}
            progress={data.summary.avgCompletion}
            hint="Hour-weighted across every course"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="At risk"
            value={data.summary.atRisk}
            tone={data.summary.atRisk > 0 ? 'critical' : 'neutral'}
            hint={`${data.summary.behindPace} more behind pace`}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Certifications overdue"
            value={data.summary.certsOverdue}
            tone={data.summary.certsOverdue > 0 ? 'warning' : 'neutral'}
            hint="Due date passed in the last 7 days"
          />
        </Grid>
      </Grid>

      {/* --- roster ------------------------------------------------------- */}
      <SectionCard title="Roster" subtitle={`${data.roster.length} mentees, alphabetical`}>
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={HEAD_CELL}>Student</TableCell>
                <TableCell sx={HEAD_CELL}>Stage</TableCell>
                <TableCell sx={{ minWidth: 170 }}>Overall</TableCell>
                <TableCell sx={NUM_CELL}>Attendance</TableCell>
                <TableCell sx={HEAD_CELL}>Certification pace</TableCell>
                <TableCell sx={HEAD_CELL}>Last active</TableCell>
                <TableCell sx={NUM_CELL}>Open alerts</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.roster.map((row) => (
                <TableRow key={row.studentId}>
                  <TableCell sx={{ minWidth: 180 }}>
                    <Typography variant="body2">{row.name}</Typography>
                    <Typography variant="caption" color="text.disabled" className="tabular">
                      {row.usn}
                    </Typography>
                  </TableCell>
                  <TableCell sx={HEAD_CELL}>
                    <Typography variant="body2">
                      {STAGE_LABEL[row.stage as Stage]}
                    </Typography>
                    <Typography variant="caption" color="text.disabled" className="tabular">
                      Semester {row.semester}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    {/* Ink, not a status ramp — the pace column beside it is
                        where the judgement lives, and the number is printed
                        next to the bar for anyone reading on paper. */}
                    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                      <ProgressMeter
                        value={row.overallPct}
                        tone="neutral"
                        sx={{ width: 88 }}
                        label={`${row.name} overall completion`}
                      />
                      <Typography
                        variant="body2"
                        className="tabular"
                        sx={{ width: 42, textAlign: 'right' }}
                      >
                        {formatPct(row.overallPct)}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell className="tabular" sx={NUM_CELL}>
                    {formatPct(row.attendancePct)}
                  </TableCell>
                  <TableCell sx={HEAD_CELL}>
                    <StatusChip
                      tone={PACE_TONE[row.certPace.status]}
                      label={PACE_LABEL[row.certPace.status]}
                    />
                  </TableCell>
                  <TableCell sx={HEAD_CELL}>{relativeDay(row.lastActiveAt, now)}</TableCell>
                  <TableCell className="tabular" sx={NUM_CELL}>
                    {row.openAlerts === 0 ? (
                      <Box component="span" sx={{ color: 'text.disabled' }}>
                        —
                      </Box>
                    ) : (
                      <Box component="span" sx={{ color: 'error.dark' }}>
                        {row.openAlerts}
                      </Box>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </SectionCard>

      <Grid container columnSpacing={6}>
        {/* --- open alerts by rule --------------------------------------- */}
        <Grid size={{ xs: 12, lg: 7 }}>
          <SectionCard
            title="Open alerts by rule"
            subtitle="Which rule is doing the work in this group right now"
            sx={KEEP_TOGETHER}
          >
            {data.alerts.length === 0 ? (
              <EmptyState title="No open alerts for this group." />
            ) : (
              <TableContainer sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Rule</TableCell>
                      <TableCell sx={HEAD_CELL}>Severity</TableCell>
                      <TableCell sx={NUM_CELL}>Alerts</TableCell>
                      <TableCell sx={NUM_CELL}>Students</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {ruleRows.map((row) => (
                      <TableRow key={row.ruleKey}>
                        <TableCell sx={{ minWidth: 200 }}>{row.label}</TableCell>
                        <TableCell sx={HEAD_CELL}>
                          {row.severity ? (
                            <StatusChip
                              tone={SEVERITY_TONE[row.severity]}
                              label={SEVERITY_LABEL[row.severity]}
                            />
                          ) : (
                            <Box component="span" sx={{ color: 'text.disabled' }}>
                              Not firing
                            </Box>
                          )}
                        </TableCell>
                        <TableCell className="tabular" sx={NUM_CELL}>
                          {row.count}
                        </TableCell>
                        <TableCell className="tabular" sx={NUM_CELL}>
                          {row.students}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </SectionCard>
        </Grid>

        {/* --- focus score distribution ---------------------------------- */}
        <Grid size={{ xs: 12, lg: 5 }}>
          <SectionCard
            title="Focus scores"
            subtitle="Progress gained per logged hour, blended with session discipline"
            sx={KEEP_TOGETHER}
          >
            {focusScores.length === 0 ? (
              <EmptyState title="No logged lab sessions yet." />
            ) : (
              <>
                {/* A distribution, not five verdicts: the band label already
                    says which end of the scale it is. One ink colour. */}
                <Stack spacing={2.25} sx={{ pt: 0.5 }}>
                  {distribution.map((band) => (
                    <MeterRow
                      key={band.label}
                      label={band.label}
                      value={band.sharePct}
                      tone="neutral"
                      labelWidth={64}
                      hint={`${band.count} of ${focusScores.length}`}
                    />
                  ))}
                </Stack>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ mt: 2.5, pt: 2, borderTop: 1, borderColor: 'divider' }}
                >
                  Median score {medianFocus}. {lowestBand === 0
                    ? 'Nobody sits in the lowest band.'
                    : `${lowestBand} mentee${lowestBand === 1 ? ' sits' : 's sit'} in the lowest band (0–19).`}{' '}
                  This measures what the hours produced, not how many hours were spent.
                </Typography>
              </>
            )}
          </SectionCard>
        </Grid>
      </Grid>

      {/* --- certification completion by course --------------------------- */}
      <SectionCard
        title="Certification completion by course"
        subtitle="Every certification this group is enrolled on, grouped by its parent course"
      >
        {courseRows.length === 0 ? (
          <EmptyState title="No certifications assigned to this group." />
        ) : (
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Course</TableCell>
                  <TableCell sx={HEAD_CELL}>Stage</TableCell>
                  <TableCell sx={NUM_CELL}>Completed</TableCell>
                  <TableCell sx={{ minWidth: 180 }}>Completion</TableCell>
                  <TableCell sx={NUM_CELL}>Average progress</TableCell>
                  <TableCell sx={NUM_CELL}>Overdue</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {courseRows.map((row) => (
                  <TableRow key={row.code}>
                    <TableCell sx={{ minWidth: 220 }}>
                      <Typography variant="body2">{row.code}</Typography>
                      <Typography variant="caption" color="text.disabled">
                        {row.name}
                      </Typography>
                    </TableCell>
                    <TableCell sx={HEAD_CELL}>{STAGE_LABEL[row.stage]}</TableCell>
                    <TableCell className="tabular" sx={NUM_CELL}>
                      {row.completed} of {row.enrolments}
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                        <ProgressMeter
                          value={row.completionPct}
                          tone="neutral"
                          sx={{ width: 96 }}
                          label={`${row.code} certification completion`}
                        />
                        <Typography
                          variant="body2"
                          className="tabular"
                          sx={{ width: 42, textAlign: 'right' }}
                        >
                          {formatPct(row.completionPct)}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell className="tabular" sx={NUM_CELL}>
                      {formatPct(row.avgProgressPct)}
                    </TableCell>
                    <TableCell className="tabular" sx={NUM_CELL}>
                      {row.overdue === 0 ? (
                        <Box component="span" sx={{ color: 'text.disabled' }}>
                          —
                        </Box>
                      ) : (
                        <Box component="span" sx={{ color: 'warning.dark' }}>
                          {row.overdue}
                        </Box>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </SectionCard>

      {/* Commentary about the build is not part of the document a coordinator
          files, so it stays on the screen and off the paper. */}
      <Box className="no-print">
        <TechNote>
          This page is the print artefact. The toolbar, the sidebar and the top bar all carry{' '}
          <code>.no-print</code>, which the theme turns into <code>display: none</code> inside{' '}
          <code>@media print</code>, and the report itself is forced to black ink on white so a
          mentor printing in dark mode does not get a black sheet. Nothing is recomputed for
          printing: the roster is <code>getMentorCohort()</code>, certification state is{' '}
          <code>certificationStatus()</code> (measured against the expected curve, not merely a
          date that has passed), and the focus bands come from <code>focusQuality()</code>,
          which counts provider-reported progress gained per logged hour rather than time on a
          seat. &ldquo;Download CSV&rdquo; hits <code>/mentor/reports/export</code>, which reads
          the same roster rows — so the spreadsheet and the printout cannot disagree. Every
          percentage is printed next to its bar, because a bar on its own is not a number, and
          because a printer that drops backgrounds must not drop the data with them.
        </TechNote>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------

function completionTone(pct: number): Tone {
  if (pct >= 75) return 'good';
  if (pct >= 50) return 'warning';
  return 'critical';
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
