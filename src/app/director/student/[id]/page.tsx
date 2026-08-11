import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import DataObjectRounded from '@mui/icons-material/DataObjectRounded';
import TableViewRounded from '@mui/icons-material/TableViewRounded';

import {
  EmptyState,
  Fact,
  MeterRow,
  PageIntro,
  ProgressMeter,
  SectionCard,
  StatCard,
  StatusChip,
  TechNote,
  type Tone,
} from '@/components/kit';
import { requireRole } from '@/lib/auth';
import { EXPORT_TABLES } from '@/lib/export/collect';
import {
  ACTIVITY_LABEL,
  ALERT_RULE_LABEL,
  COURSE_MODEL_LABEL,
  DIMENSION_LABEL,
  MODE_LABEL,
  PACE_LABEL,
  SEVERITY_LABEL,
  SOURCE_LABEL,
  STAGE_BLURB,
  STAGE_LABEL,
  STATUS_LABEL,
  formatDuration,
  formatHours,
  relativeDay,
} from '@/lib/reep';
import { UPLOAD_KIND_LABEL, formatBytes } from '@/lib/uploads';
import type {
  AlertSeverity,
  MentorAction,
  ProgressStatus,
  UploadStatus,
} from '@prisma/client';

import { buildStudentRecord, type StudentRecord } from '../record';
import { PrintDocumentButton } from './document-actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const record = await buildStudentRecord(id);
  // The browser stamps document.title into the print header, so this is the
  // filename a director gets when they choose "Save as PDF".
  return {
    title: record
      ? `${record.student.user.name} — REEP record`
      : 'Student record — Director',
  };
}

/**
 * The programme attendance floor, mirrored from the default placement criteria
 * so this page grades a student against the same bar the readiness screen does.
 */
const ATTENDANCE_FLOOR = 85;

const CERT_TONE: Record<ProgressStatus, Tone> = {
  NOT_STARTED: 'neutral',
  IN_PROGRESS: 'info',
  COMPLETED: 'good',
  OVERDUE: 'critical',
};

const SEVERITY_TONE: Record<AlertSeverity, Tone> = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
};

const UPLOAD_TONE: Record<UploadStatus, Tone> = {
  PENDING_REVIEW: 'warning',
  VERIFIED: 'good',
  REJECTED: 'critical',
};

const UPLOAD_STATUS_LABEL: Record<UploadStatus, string> = {
  PENDING_REVIEW: 'Awaiting check',
  VERIFIED: 'Verified',
  REJECTED: 'Needs re-upload',
};

const ACTION_LABEL: Record<MentorAction, string> = {
  NONE: 'Observation',
  FLAGGED: 'Flagged for follow-up',
  NUDGE_SENT: 'Nudge sent',
  ONE_ON_ONE_SCHEDULED: '1:1 scheduled',
};

/**
 * Print rules.
 *
 * Three jobs. Drop the app chrome, so the sheet is the document and nothing
 * else. Force ink to black on white, because a director printing at 11pm in
 * dark mode must not get a page of pale grey on nothing. And keep a section
 * whole across a page break — a heading orphaned at the foot of page 3 with its
 * table on page 4 is how a review meeting loses its thread. Sections that are
 * genuinely taller than a sheet opt out through `.doc-flow`, and their table
 * headers repeat instead.
 */
const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 14mm 12mm; }

  html, body { background: #fff !important; }
  body * { background-color: transparent !important; box-shadow: none !important; }
  .no-print { display: none !important; }

  /* The shell's padded, max-width column is screen furniture. */
  main > div { padding: 0 !important; max-width: none !important; }

  .reep-doc, .reep-doc * {
    color: #000 !important;
    border-color: #b4b4b4 !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }

  /* Meters still have to read as measurements once the hue is gone. */
  .reep-doc .MuiLinearProgress-root { background-color: #e0e0e0 !important; }
  .reep-doc .MuiLinearProgress-bar { background-color: #000 !important; }
  .reep-doc .MuiChip-root { border-color: #767676 !important; }

  .reep-doc section { page-break-inside: avoid; break-inside: avoid; }
  .reep-doc .doc-flow section { page-break-inside: auto; break-inside: auto; }
  .reep-doc h1, .reep-doc h2, .reep-doc h3 { page-break-after: avoid; break-after: avoid; }
  .reep-doc thead { display: table-header-group; }
  .reep-doc tr { page-break-inside: avoid; break-inside: avoid; }
  .reep-doc .MuiTableContainer-root { overflow: visible !important; }
  .reep-doc table { width: 100% !important; min-width: 0 !important; }
}
`;

// --- formatting -------------------------------------------------------------

function fmtDate(date: Date | null | undefined): string {
  if (!date) return '—';
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDateTime(date: Date | null | undefined): string {
  if (!date) return '—';
  const day = date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const time = date.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${day}, ${time}`;
}

function completionTone(pct: number): Tone {
  return pct >= 70 ? 'good' : pct >= 40 ? 'warning' : 'critical';
}

function attendanceTone(pct: number): Tone {
  return pct >= ATTENDANCE_FLOOR ? 'good' : pct >= 70 ? 'warning' : 'critical';
}

/// Signed gap from the expected certification curve, in percentage points.
function paceDelta(deviationPct: number): string {
  const points = Math.round(deviationPct);
  if (points === 0) return 'On curve';
  return `${points > 0 ? '+' : '−'}${Math.abs(points)} pts`;
}

// --- small building blocks --------------------------------------------------

function DocTable({
  head,
  children,
  minWidth = 680,
}: {
  head: ReactNode;
  children: ReactNode;
  minWidth?: number;
}) {
  return (
    <TableContainer>
      <Table size="small" sx={{ minWidth }}>
        <TableHead>{head}</TableHead>
        <TableBody>{children}</TableBody>
      </Table>
    </TableContainer>
  );
}

/// A meter and its number, sized to sit inside a table cell.
function MeterCell({ value, tone }: { value: number; tone: Tone }) {
  return (
    <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', minWidth: 118 }}>
      <ProgressMeter value={value} tone={tone} sx={{ flex: 1, minWidth: 52 }} decorative />
      <Box component="span" className="tabular" sx={{ width: 36, textAlign: 'right' }}>
        {value.toFixed(0)}%
      </Box>
    </Stack>
  );
}

/// Sections whose content can legitimately run past one sheet.
function LongSection({ children }: { children: ReactNode }) {
  return <Box className="doc-flow">{children}</Box>;
}

// ---------------------------------------------------------------------------

export default async function DirectorStudentRecordPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole('DIRECTOR', 'ADMIN');
  const { id } = await params;

  const record = await buildStudentRecord(id);
  if (!record) notFound();

  const { student } = record;
  const openAlerts = record.alerts.filter((alert) => alert.resolvedAt == null);
  const preparedOn = fmtDate(new Date());

  return (
    <Box className="reep-doc">
      <style>{PRINT_CSS}</style>

      <PageIntro
        title={student.user.name}
        subtitle={`${student.usn} · ${student.cohort.code} · ${STAGE_LABEL[student.currentStage]}, semester ${student.currentSemester}`}
        action={
          <Stack direction="row" spacing={1.25} sx={{ flexWrap: 'wrap' }}>
            <PrintDocumentButton />
            <Button
              component="a"
              href={`/api/export/xlsx?studentId=${encodeURIComponent(student.id)}`}
              download
              variant="outlined"
              startIcon={<TableViewRounded />}
            >
              Download Excel
            </Button>
            <Button
              component="a"
              href={`/api/export/student/${student.id}`}
              variant="outlined"
              startIcon={<DataObjectRounded />}
            >
              Download JSON
            </Button>
          </Stack>
        }
      />

      {/* --- who this is about ------------------------------------------- */}
      <Box component="section" sx={{ mb: 5 }}>
        <Typography
          variant="caption"
          color="text.disabled"
          className="no-print"
          sx={{ display: 'block', mb: 3, maxWidth: '76ch' }}
        >
          <strong>Download PDF</strong> opens your browser&rsquo;s own print dialog — choose
          &ldquo;Save as PDF&rdquo; as the destination. Nothing is rendered on the server, so
          what you get is exactly this page with the navigation and buttons removed.{' '}
          <strong>Download Excel</strong> is the whole record as a nine-sheet workbook, and{' '}
          <strong>Download JSON</strong> the same thing as a data file for an audit trail.
          Individual tables as CSV are at the foot of the page.
        </Typography>

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          BGSCET MBA — REEP programme record · prepared {preparedOn}
        </Typography>

        <Grid container spacing={2.5} sx={{ mb: 3.5 }}>
          <Grid size={{ xs: 6, sm: 4, md: 2 }}>
            <Fact label="USN" value={student.usn} />
          </Grid>
          <Grid size={{ xs: 6, sm: 4, md: 2 }}>
            <Fact label="Cohort" value={student.cohort.code} />
          </Grid>
          <Grid size={{ xs: 6, sm: 4, md: 2 }}>
            <Fact label="Stage" value={STAGE_LABEL[student.currentStage]} />
          </Grid>
          <Grid size={{ xs: 6, sm: 4, md: 2 }}>
            <Fact label="Semester" value={student.currentSemester} />
          </Grid>
          <Grid size={{ xs: 6, sm: 4, md: 2 }}>
            <Fact
              label="Faculty mentor"
              value={
                student.mentor
                  ? `${student.mentor.title} ${student.mentor.user.name}`
                  : 'Unassigned'
              }
            />
          </Grid>
          <Grid size={{ xs: 6, sm: 4, md: 2 }}>
            <Fact label="Enrolled" value={fmtDate(student.enrolledAt)} />
          </Grid>
        </Grid>

        <Divider sx={{ mb: 3.5 }} />

        <Grid container spacing={2.5}>
          <Grid size={{ xs: 6, md: 3 }}>
            <StatCard
              label="Overall completion"
              value={`${record.overallPct.toFixed(0)}%`}
              tone={completionTone(record.overallPct)}
              progress={record.overallPct}
              hint="Weighted across every enrolled course"
            />
          </Grid>
          <Grid size={{ xs: 6, md: 3 }}>
            <StatCard
              label="Lecture attendance"
              value={`${record.attendancePct.toFixed(0)}%`}
              tone={attendanceTone(record.attendancePct)}
              progress={record.attendancePct}
              hint={`${record.lecturesAttended} of ${record.lecturesHeld} lectures · floor is ${ATTENDANCE_FLOOR}%`}
            />
          </Grid>
          <Grid size={{ xs: 6, md: 3 }}>
            <StatCard
              label="Certification pace"
              value={paceDelta(record.certPace.deviationPct)}
              tone={
                record.certPace.status === 'ON_TRACK'
                  ? 'good'
                  : record.certPace.status === 'BEHIND'
                    ? 'warning'
                    : 'critical'
              }
              hint={`${PACE_LABEL[record.certPace.status]} — ${record.certPace.actualPct.toFixed(0)}% done against ${record.certPace.expectedPct.toFixed(0)}% expected`}
            />
          </Grid>
          <Grid size={{ xs: 6, md: 3 }}>
            <StatCard
              label="Focus score"
              value={record.focus.focusScore}
              tone={
                record.focus.focusScore >= 70
                  ? 'good'
                  : record.focus.focusScore >= 45
                    ? 'warning'
                    : 'critical'
              }
              hint={`${record.focus.progressPerHour.toFixed(2)} progress points per logged hour, over ${formatHours(record.totalLoggedHours)}`}
            />
          </Grid>
        </Grid>

        {openAlerts.length > 0 && (
          <Typography variant="body2" color="error.dark" sx={{ mt: 3 }}>
            {openAlerts.length} flag{openAlerts.length === 1 ? '' : 's'} open at the time this
            record was prepared — listed in full under Alerts below.
          </Typography>
        )}
      </Box>

      <JourneySection stages={record.stages} />
      <DimensionsSection dimensions={record.dimensions} />

      <LongSection>
        <CoursesSection courses={record.courses} />
      </LongSection>

      <LongSection>
        <CertificationsSection certs={record.certs} />
      </LongSection>

      <LongSection>
        <TimeLogSection record={record} />
      </LongSection>

      <LongSection>
        <AttendanceSection record={record} />
      </LongSection>

      <LongSection>
        <AlertsSection alerts={record.alerts} />
      </LongSection>

      <LongSection>
        <NotesSection notes={record.notes} name={student.user.name} />
      </LongSection>

      <LongSection>
        <UploadsSection uploads={record.uploads} />
      </LongSection>

      <Box className="no-print">
        <DownloadsSection studentId={student.id} name={student.user.name} usn={student.usn} />
      </Box>

      <TechNote>
        Nothing on this page is stored. Every percentage is recomputed at request time from
        the same functions the student and mentor screens call, so a figure quoted in a
        review meeting cannot drift from what the student sees on their own dashboard. The
        JSON export is built from this identical record, which is why it is safe to circulate
        the two together. Alerts, notes and uploads are listed in full rather than capped, and
        resolved flags stay visible — a record that only shows current problems cannot show
        that a problem was handled. &ldquo;Overdue&rdquo; on a certification means the pace has
        fallen below the expected completion curve, not merely that the date has passed. The
        spreadsheet downloads are the programme export with{' '}
        <code>?studentId=</code> on it: the same nine tables, the same columns, filtered to
        one person by <code>collectProgrammeData()</code> — so this student&rsquo;s workbook
        and their cohort&rsquo;s cannot disagree about a single cell.
      </TechNote>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// 1 — REEP journey
// ---------------------------------------------------------------------------

function JourneySection({ stages }: { stages: StudentRecord['stages'] }) {
  return (
    <SectionCard
      title="REEP journey"
      subtitle="Stage-by-stage completion, weighted by the hours each course is worth"
    >
      <Stack spacing={2.5} sx={{ pt: 0.5 }}>
        {stages.map((stage) => (
          <Box key={stage.stage}>
            <MeterRow
              label={STAGE_LABEL[stage.stage]}
              value={stage.pct}
              tone={stage.courseCount === 0 ? 'neutral' : completionTone(stage.pct)}
              labelWidth={132}
            />
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mt: 0.5, display: 'block', pl: '148px' }}
            >
              {STAGE_BLURB[stage.stage]} ·{' '}
              {stage.courseCount === 0
                ? 'not enrolled on this stage yet'
                : `${stage.completedCourses} of ${stage.courseCount} courses complete`}
            </Typography>
          </Box>
        ))}
      </Stack>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 2 — Development dimensions
// ---------------------------------------------------------------------------

function DimensionsSection({ dimensions }: { dimensions: StudentRecord['dimensions'] }) {
  return (
    <SectionCard
      title="Development dimensions"
      subtitle="Each course rolls up into one of the four REEP developmental dimensions"
    >
      <Stack spacing={2.5} sx={{ pt: 0.5 }}>
        {dimensions.map((dimension) => (
          <MeterRow
            key={dimension.dimension}
            label={DIMENSION_LABEL[dimension.dimension]}
            value={dimension.pct}
            tone={dimension.courseCount === 0 ? 'neutral' : completionTone(dimension.pct)}
            labelWidth={132}
            hint={
              dimension.courseCount === 0
                ? 'no courses'
                : `${dimension.courseCount} course${dimension.courseCount === 1 ? '' : 's'}`
            }
          />
        ))}
      </Stack>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 3 — Courses
// ---------------------------------------------------------------------------

function CoursesSection({ courses }: { courses: StudentRecord['courses'] }) {
  if (courses.length === 0) {
    return (
      <SectionCard title="Courses">
        <EmptyState title="This student has no course enrolments." />
      </SectionCard>
    );
  }

  const teachingAttended = courses.reduce(
    (sum, c) => sum + c.enrollment.teachingHoursAttended,
    0,
  );
  const teachingRequired = courses.reduce((sum, c) => sum + c.enrollment.course.teachingHours, 0);
  const selfLogged = courses.reduce((sum, c) => sum + c.enrollment.selfLearningHoursLogged, 0);
  const selfRequired = courses.reduce(
    (sum, c) => sum + c.enrollment.course.selfLearningHoursRequired,
    0,
  );

  return (
    <SectionCard
      title="Courses"
      subtitle={`${courses.length} enrolments · teaching ${formatHours(teachingAttended)} of ${formatHours(teachingRequired)} · self-learning ${formatHours(selfLogged)} of ${formatHours(selfRequired)}`}
    >
      <DocTable
        minWidth={760}
        head={
          <TableRow>
            <TableCell>Course</TableCell>
            <TableCell>Stage</TableCell>
            <TableCell>Model</TableCell>
            <TableCell align="right">Teaching hours</TableCell>
            <TableCell align="right">Self-learning hours</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Completion</TableCell>
          </TableRow>
        }
      >
        {courses.map(({ enrollment, completionPct }) => (
          <TableRow key={enrollment.id}>
            <TableCell>
              <Typography variant="subtitle2">{enrollment.course.code}</Typography>
              <Typography variant="caption" color="text.secondary">
                {enrollment.course.name}
              </Typography>
            </TableCell>
            <TableCell>{STAGE_LABEL[enrollment.course.stage]}</TableCell>
            <TableCell>{COURSE_MODEL_LABEL[enrollment.course.modelType]}</TableCell>
            <TableCell align="right" className="tabular">
              {enrollment.course.teachingHours > 0
                ? `${enrollment.teachingHoursAttended.toFixed(0)} / ${enrollment.course.teachingHours.toFixed(0)}`
                : '—'}
            </TableCell>
            <TableCell align="right" className="tabular">
              {enrollment.course.selfLearningHoursRequired > 0
                ? `${enrollment.selfLearningHoursLogged.toFixed(0)} / ${enrollment.course.selfLearningHoursRequired.toFixed(0)}`
                : '—'}
            </TableCell>
            <TableCell>{STATUS_LABEL[enrollment.status]}</TableCell>
            <TableCell align="right">
              <MeterCell value={completionPct} tone={completionTone(completionPct)} />
            </TableCell>
          </TableRow>
        ))}
      </DocTable>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 4 — Certifications
// ---------------------------------------------------------------------------

function CertificationsSection({ certs }: { certs: StudentRecord['certs'] }) {
  if (certs.length === 0) {
    return (
      <SectionCard title="Certifications">
        <EmptyState title="No certifications are assigned to this student." />
      </SectionCard>
    );
  }

  const completed = certs.filter((row) => row.status === 'COMPLETED').length;
  const overdue = certs.filter((row) => row.status === 'OVERDUE').length;
  const verified = certs.filter((row) => !row.cert.selfReported).length;

  return (
    <SectionCard
      title="Certifications"
      subtitle={`${certs.length} assigned · ${completed} complete · ${overdue} overdue · ${verified} pulled from a provider rather than self-reported`}
    >
      <DocTable
        minWidth={860}
        head={
          <TableRow>
            <TableCell>Certification</TableCell>
            <TableCell>Course</TableCell>
            <TableCell align="right">Hours</TableCell>
            <TableCell align="right">Progress</TableCell>
            <TableCell align="right">Expected</TableCell>
            <TableCell>Due</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Provenance</TableCell>
          </TableRow>
        }
      >
        {certs.map(({ cert, status, pace }) => (
          <TableRow key={cert.id}>
            <TableCell>
              <Typography variant="subtitle2">{cert.cert.name}</Typography>
              <Typography variant="caption" color="text.secondary">
                {cert.cert.provider}
                {cert.cert.isOptional ? ' · optional' : ''}
              </Typography>
            </TableCell>
            <TableCell>{cert.cert.courseCode}</TableCell>
            <TableCell align="right" className="tabular">
              {cert.cert.requiredHours.toFixed(0)}
            </TableCell>
            <TableCell align="right">
              <MeterCell value={cert.progressPct} tone={CERT_TONE[status]} />
            </TableCell>
            <TableCell align="right" className="tabular">
              {pace.expectedPct.toFixed(0)}%
            </TableCell>
            <TableCell>{fmtDate(cert.dueDate)}</TableCell>
            <TableCell>
              <StatusChip tone={CERT_TONE[status]} label={STATUS_LABEL[status]} />
            </TableCell>
            <TableCell>
              <Typography variant="body2">
                {cert.selfReported ? 'Self-reported' : 'Provider sync'}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {cert.lastSyncedAt
                  ? `synced ${relativeDay(cert.lastSyncedAt).toLowerCase()}`
                  : 'never synced'}
              </Typography>
            </TableCell>
          </TableRow>
        ))}
      </DocTable>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 5 — Time log
// ---------------------------------------------------------------------------

const RECENT_SESSION_COUNT = 30;

function TimeLogSection({ record }: { record: StudentRecord }) {
  const recent = record.sessions.slice(0, RECENT_SESSION_COUNT);

  return (
    <SectionCard
      title="Time log"
      subtitle={`${formatHours(record.totalLoggedHours)} logged across ${record.sessions.length} sessions · active on ${record.consistency.activeDays} of the last ${record.consistency.windowDays} days`}
    >
      <Grid container spacing={{ xs: 4, md: 5 }} sx={{ mb: 4 }}>
        <Grid size={{ xs: 12, md: 6 }}>
          <Typography variant="subtitle2" sx={{ mb: 2 }}>
            Hours by learning mode
          </Typography>
          {record.modes.every((mode) => mode.hours === 0) ? (
            <Typography variant="body2" color="text.disabled">
              No time has been logged yet.
            </Typography>
          ) : (
            <Stack spacing={2.5}>
              {record.modes.map((mode) => (
                <MeterRow
                  key={mode.mode}
                  label={MODE_LABEL[mode.mode]}
                  value={mode.pct}
                  tone="info"
                  labelWidth={168}
                  hint={`${formatHours(mode.hours)} · ${mode.sessionCount} sessions`}
                />
              ))}
            </Stack>
          )}
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <Typography variant="subtitle2" sx={{ mb: 2 }}>
            Hours by activity
          </Typography>
          {record.activities.length === 0 ? (
            <Typography variant="body2" color="text.disabled">
              No activity has been recorded yet.
            </Typography>
          ) : (
            <DocTable
              minWidth={320}
              head={
                <TableRow>
                  <TableCell>Activity</TableCell>
                  <TableCell align="right">Sessions</TableCell>
                  <TableCell align="right">Hours</TableCell>
                  <TableCell align="right">Share</TableCell>
                </TableRow>
              }
            >
              {record.activities.map((activity) => (
                <TableRow key={activity.activity}>
                  <TableCell>{activity.label}</TableCell>
                  <TableCell align="right" className="tabular">
                    {activity.sessions}
                  </TableCell>
                  <TableCell align="right" className="tabular">
                    {formatHours(activity.hours)}
                  </TableCell>
                  <TableCell align="right" className="tabular">
                    {activity.pct.toFixed(0)}%
                  </TableCell>
                </TableRow>
              ))}
            </DocTable>
          )}
        </Grid>
      </Grid>

      <Typography variant="subtitle2" sx={{ mb: 2 }}>
        Most recent {recent.length} sessions
      </Typography>

      {recent.length === 0 ? (
        <EmptyState title="No check-ins have been recorded for this student." />
      ) : (
        <DocTable
          minWidth={880}
          head={
            <TableRow>
              <TableCell>When</TableCell>
              <TableCell>Course</TableCell>
              <TableCell>Module</TableCell>
              <TableCell>Activity</TableCell>
              <TableCell>Mode</TableCell>
              <TableCell align="right">Duration</TableCell>
              <TableCell align="right">Progress</TableCell>
              <TableCell>Captured by</TableCell>
            </TableRow>
          }
        >
          {recent.map((session) => (
            <TableRow key={session.id}>
              <TableCell className="tabular">{fmtDateTime(session.checkInAt)}</TableCell>
              <TableCell>{session.courseCode}</TableCell>
              <TableCell>{session.module}</TableCell>
              <TableCell>
                <Typography variant="body2">{ACTIVITY_LABEL[session.activity]}</Typography>
                {session.activityNote ? (
                  <Typography variant="caption" color="text.secondary">
                    {session.activityNote}
                  </Typography>
                ) : null}
              </TableCell>
              <TableCell>{MODE_LABEL[session.mode]}</TableCell>
              <TableCell align="right" className="tabular">
                {session.checkOutAt ? formatDuration(session.durationMin) : 'open'}
              </TableCell>
              <TableCell align="right" className="tabular">
                {session.progressDeltaPct == null
                  ? '—'
                  : `${session.progressDeltaPct > 0 ? '+' : ''}${session.progressDeltaPct.toFixed(1)}`}
              </TableCell>
              <TableCell>
                <Typography variant="body2">{SOURCE_LABEL[session.source]}</Typography>
                {session.mentorConfirmed ? (
                  <Typography variant="caption" color="text.secondary">
                    mentor-confirmed
                  </Typography>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </DocTable>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 6 — Attendance
// ---------------------------------------------------------------------------

function AttendanceSection({ record }: { record: StudentRecord }) {
  const belowFloor = record.attendance.filter((row) => row.pct < ATTENDANCE_FLOOR);

  return (
    <SectionCard
      title="Attendance"
      subtitle={`Instructor-led lectures only — lab check-ins are in the time log above. ${record.lecturesAttended} of ${record.lecturesHeld} attended.`}
    >
      {record.attendance.length === 0 ? (
        <EmptyState
          title="No lecture attendance has been recorded."
          hint="These courses may be pure supervised self-learn, which is tracked as check-ins rather than a register."
        />
      ) : (
        <>
          <DocTable
            minWidth={700}
            head={
              <TableRow>
                <TableCell>Course</TableCell>
                <TableCell align="right">Held</TableCell>
                <TableCell align="right">Attended</TableCell>
                <TableCell align="right">Missed</TableCell>
                <TableCell>Last absence</TableCell>
                <TableCell align="right">Attendance</TableCell>
              </TableRow>
            }
          >
            {record.attendance.map((row) => (
              <TableRow key={row.code}>
                <TableCell>
                  <Typography variant="subtitle2">{row.code}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {row.name}
                  </Typography>
                </TableCell>
                <TableCell align="right" className="tabular">
                  {row.held}
                </TableCell>
                <TableCell align="right" className="tabular">
                  {row.attended}
                </TableCell>
                <TableCell align="right" className="tabular">
                  {row.missed}
                </TableCell>
                <TableCell>{row.lastAbsence ? fmtDate(row.lastAbsence) : 'Never absent'}</TableCell>
                <TableCell align="right">
                  <MeterCell value={row.pct} tone={attendanceTone(row.pct)} />
                </TableCell>
              </TableRow>
            ))}
          </DocTable>

          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            {belowFloor.length === 0
              ? `Every course clears the ${ATTENDANCE_FLOOR}% programme floor.`
              : `${belowFloor.length} course${belowFloor.length === 1 ? '' : 's'} below the ${ATTENDANCE_FLOOR}% floor: ${belowFloor.map((row) => row.code).join(', ')}.`}
          </Typography>
        </>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 7 — Alerts
// ---------------------------------------------------------------------------

function AlertsSection({ alerts }: { alerts: StudentRecord['alerts'] }) {
  const open = alerts.filter((alert) => alert.resolvedAt == null).length;

  return (
    <SectionCard
      title="Alerts"
      subtitle={
        alerts.length === 0
          ? 'Every flag ever raised for this student, open and resolved'
          : `${alerts.length} raised in total · ${open} still open`
      }
    >
      {alerts.length === 0 ? (
        <EmptyState title="No flag has ever fired for this student." />
      ) : (
        <DocTable
          minWidth={820}
          head={
            <TableRow>
              <TableCell>Rule</TableCell>
              <TableCell>Severity</TableCell>
              <TableCell>What fired</TableCell>
              <TableCell>Raised</TableCell>
              <TableCell>Outcome</TableCell>
            </TableRow>
          }
        >
          {alerts.map((alert) => (
            <TableRow key={alert.id}>
              <TableCell>{ALERT_RULE_LABEL[alert.ruleTriggered]}</TableCell>
              <TableCell>
                <StatusChip
                  tone={SEVERITY_TONE[alert.severity]}
                  label={SEVERITY_LABEL[alert.severity]}
                />
              </TableCell>
              <TableCell sx={{ maxWidth: 320 }}>
                <Typography
                  variant="body2"
                  color={alert.resolvedAt ? 'text.secondary' : 'text.primary'}
                >
                  {alert.message}
                </Typography>
              </TableCell>
              <TableCell className="tabular">{fmtDate(alert.triggeredAt)}</TableCell>
              <TableCell>
                {alert.resolvedAt ? (
                  <>
                    <Typography variant="body2">Resolved</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {fmtDate(alert.resolvedAt)}
                      {alert.resolvedBy ? ` · ${alert.resolvedBy}` : ''}
                    </Typography>
                  </>
                ) : (
                  <Typography variant="body2" color="error.dark">
                    Open
                  </Typography>
                )}
              </TableCell>
            </TableRow>
          ))}
        </DocTable>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 8 — Mentor notes
// ---------------------------------------------------------------------------

function NotesSection({
  notes,
  name,
}: {
  notes: StudentRecord['notes'];
  name: string;
}) {
  return (
    <SectionCard
      title="Mentor notes"
      subtitle={
        notes.length === 0
          ? 'Everything a mentor has written about this student'
          : `${notes.length} note${notes.length === 1 ? '' : 's'}, newest first — reproduced in full`
      }
    >
      {notes.length === 0 ? (
        <EmptyState
          title={`No mentor has written a note about ${name.split(' ')[0]} yet.`}
          hint="Every nudge, flag and scheduled 1:1 writes a note, so this list is also the record of what was done."
        />
      ) : (
        <Stack>
          {notes.map((note) => (
            <Box
              key={note.id}
              sx={{
                py: 2.25,
                borderTop: 1,
                borderColor: 'divider',
                '&:first-of-type': { borderTop: 0, pt: 0 },
              }}
            >
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={{ xs: 0.5, sm: 2 }}
                sx={{ justifyContent: 'space-between', alignItems: { sm: 'baseline' }, mb: 0.75 }}
              >
                <Typography variant="subtitle2">
                  {note.mentor.title} {note.mentor.user.name}
                </Typography>
                <Typography variant="caption" color="text.secondary" className="tabular">
                  {ACTION_LABEL[note.linkedAction]} · {fmtDate(note.createdAt)}
                </Typography>
              </Stack>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ maxWidth: '84ch', whiteSpace: 'pre-wrap' }}
              >
                {note.noteText}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 10 — Downloads
//
// The page itself is the document; this is how it leaves the building. Four
// formats because four different desks ask for this record: a PDF for a review
// meeting, a workbook for the programme office, a flat CSV for whoever only
// wants the sessions, and the dossier JSON for an audit trail or a script.
// ---------------------------------------------------------------------------

function DownloadsSection({
  studentId,
  name,
  usn,
}: {
  studentId: string;
  name: string;
  usn: string;
}) {
  // Built from our own value, and every route re-resolves the id server-side
  // before it reads anything, so nothing here is trusted on arrival.
  const scoped = `studentId=${encodeURIComponent(studentId)}`;
  const firstName = name.split(' ')[0] ?? name;

  return (
    <SectionCard
      title="Download this record"
      subtitle={`Everything above about ${firstName}, in the shape whoever asked for it needs`}
    >
      <Grid container spacing={4} sx={{ mb: 3.5 }}>
        <Grid size={{ xs: 12, md: 4 }}>
          <Typography variant="h4" component="h3" sx={{ mb: 0.75 }}>
            Excel workbook
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
            Nine sheets — progress, enrolments, certifications, every session,
            attendance, flags, notes, uploads and the courses {firstName} is on —
            with a cover sheet naming the student and the moment it was taken.
          </Typography>
          <Button
            component="a"
            href={`/api/export/xlsx?${scoped}`}
            download
            variant="contained"
            color="secondary"
          >
            Download .xlsx
          </Button>
        </Grid>

        <Grid size={{ xs: 12, md: 4 }}>
          <Typography variant="h4" component="h3" sx={{ mb: 0.75 }}>
            JSON
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
            Two shapes, deliberately. The <strong>dossier</strong> is this page&rsquo;s
            own structure, nested and readable. The <strong>tables</strong> file is
            the flat row-per-record shape a script or a warehouse loader expects.
          </Typography>
          <Stack direction="row" spacing={1.25} sx={{ flexWrap: 'wrap' }}>
            <Button
              component="a"
              href={`/api/export/student/${studentId}`}
              download
              variant="outlined"
              startIcon={<DataObjectRounded />}
            >
              Dossier
            </Button>
            <Button
              component="a"
              href={`/api/export/json?${scoped}`}
              download
              variant="outlined"
            >
              Tables
            </Button>
          </Stack>
        </Grid>

        <Grid size={{ xs: 12, md: 4 }}>
          <Typography variant="h4" component="h3" sx={{ mb: 0.75 }}>
            PDF
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
            Your browser&rsquo;s own print dialog with &ldquo;Save as PDF&rdquo; as the
            destination — exactly this page, navigation and buttons removed. Nothing
            is rendered on a server, so what you see is what you get.
          </Typography>
          <PrintDocumentButton />
        </Grid>
      </Grid>

      <Divider sx={{ mb: 2.5 }} />

      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        One table as CSV
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        UTF-8 with a byte-order mark, so {usn} and every name in the file open
        correctly in Excel on the first try.
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {EXPORT_TABLES.map((table) => (
          <Button
            key={table.key}
            component="a"
            href={`/api/export/csv?table=${table.param}&${scoped}`}
            download
            size="small"
            variant="outlined"
          >
            {table.label}
          </Button>
        ))}
      </Stack>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 9 — Uploads
// ---------------------------------------------------------------------------

function UploadsSection({ uploads }: { uploads: StudentRecord['uploads'] }) {
  const pending = uploads.filter((upload) => upload.status === 'PENDING_REVIEW').length;

  return (
    <SectionCard
      title="Uploads"
      subtitle={
        uploads.length === 0
          ? 'Certificates and documents submitted by this student'
          : `${uploads.length} file${uploads.length === 1 ? '' : 's'} · ${pending} awaiting a mentor check`
      }
    >
      {uploads.length === 0 ? (
        <EmptyState title="This student has not uploaded anything." />
      ) : (
        <DocTable
          minWidth={760}
          head={
            <TableRow>
              <TableCell>File</TableCell>
              <TableCell>Kind</TableCell>
              <TableCell>Evidence for</TableCell>
              <TableCell align="right">Size</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Uploaded</TableCell>
            </TableRow>
          }
        >
          {uploads.map((upload) => (
            <TableRow key={upload.id}>
              <TableCell>
                <Typography variant="subtitle2">{upload.title}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {upload.originalName}
                </Typography>
              </TableCell>
              <TableCell>{UPLOAD_KIND_LABEL[upload.kind]}</TableCell>
              <TableCell>
                {upload.cert ? `${upload.cert.courseCode} — ${upload.cert.name}` : '—'}
              </TableCell>
              <TableCell align="right" className="tabular">
                {formatBytes(upload.sizeBytes)}
              </TableCell>
              <TableCell>
                <StatusChip
                  tone={UPLOAD_TONE[upload.status]}
                  label={UPLOAD_STATUS_LABEL[upload.status]}
                />
              </TableCell>
              <TableCell className="tabular">{fmtDate(upload.uploadedAt)}</TableCell>
            </TableRow>
          ))}
        </DocTable>
      )}
    </SectionCard>
  );
}
