import { notFound } from 'next/navigation';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';

import { FocusNotes } from '@/components/focus-notes';
import { FocusQualityPanel } from '@/components/focus-quality';
import { FocusTimeline } from '@/components/focus-timeline';
import {
  EmptyState,
  InfoBanner,
  MeterRow,
  PageIntro,
  SectionCard,
  StatCard,
  StatusChip,
  TechNote,
  type Tone,
} from '@/components/kit';
import { PaceCurveChart } from '@/components/reep-charts';
import {
  StaffActivityPanel,
  type StaffActivityCourse,
  type StaffActivityOption,
} from '@/components/staff-activity-panel';
import { earliestLoggableDay, isoDay } from '@/lib/activity-rules';
import { requireMentor } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { canSeeStudent } from '@/lib/mentor-scope';
import { getStudentDetail } from '@/lib/queries';
import type { Forecast } from '@/lib/analytics';
import {
  ACTIVITY_LABEL,
  ACTIVITY_ORDER,
  PACE_LABEL,
  SEVERITY_LABEL,
  STAGE_LABEL,
  STATUS_LABEL,
  formatHours,
  relativeDay,
} from '@/lib/reep';
import { UPLOAD_KIND_LABEL } from '@/lib/uploads';
import type {
  AlertSeverity,
  PaceStatus,
  ProgressStatus,
  UploadStatus,
} from '@prisma/client';

import {
  addNote,
  flagForFollowUp,
  logActivityForStudent,
  scheduleOneOnOne,
  sendNudge,
} from './actions';
import { CertGrid, type CertRow } from './cert-grid';
import { MeetingNotePanel } from './meeting-notes';

export const metadata = { title: 'Student — Mentor' };
export const dynamic = 'force-dynamic';

type StudentDetail = NonNullable<Awaited<ReturnType<typeof getStudentDetail>>>;

/**
 * Which tab is open lives in `?tab=` rather than in client state, so a mentor
 * can send "look at her attendance" as a link and every tab stays a Server
 * Component that fetches only what it renders.
 */
const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'certifications', label: 'Certifications' },
  { key: 'attendance', label: 'Attendance' },
  { key: 'focus', label: 'Focus log' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

/// The wireframe opens on the focus log — it is the reason this screen exists.
const DEFAULT_TAB: TabKey = 'focus';

function parseTab(raw: string | string[] | undefined): TabKey {
  const token = Array.isArray(raw) ? raw[0] : raw;
  return TABS.some((t) => t.key === token) ? (token as TabKey) : DEFAULT_TAB;
}

const PACE_TONE: Record<PaceStatus, Tone> = {
  ON_TRACK: 'good',
  BEHIND: 'warning',
  AT_RISK: 'critical',
};

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

/// Programme attendance floor, mirrored from the default placement criteria.
const ATTENDANCE_FLOOR = 85;

export default async function MentorStudentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const session = await requireMentor();
  const [{ id }, rawSearch] = await Promise.all([params, searchParams]);
  const tab = parseTab(rawSearch.tab);

  const data = await getStudentDetail(id);
  if (!data) notFound();

  // A mentor sees their own mentees and nobody else's. Directors and admins
  // carry no mentor row and have programme-wide scope, so they pass; a mentor
  // account with no mentor row has no scope at all and passes nothing.
  // Rendering is not the security boundary on its own — the Server Actions
  // re-check ownership on every write too.
  if (!canSeeStudent(session, data.student.mentorId)) notFound();

  const {
    student,
    overallPct,
    attendancePct,
    certPace,
    certs,
    curve,
    focus,
    consistency,
    recentSessions,
    forecast,
    notes,
    alerts,
    enrollments,
  } = data;

  const firstName = student.user.name.split(' ')[0] ?? student.user.name;
  const openAlerts = alerts.filter((a) => a.resolvedAt == null);

  // The same definition the mentor roster uses, so a student tagged at risk on
  // the cohort screen is tagged at risk here.
  const atRisk =
    certPace.status === 'AT_RISK' || openAlerts.some((a) => a.severity === 'CRITICAL');

  // --- log-on-their-behalf panel ------------------------------------------
  // The bounds come from the same function the Server Action validates against,
  // so the picker cannot offer a day the write will then refuse.
  const earliestDay = earliestLoggableDay(student);
  const activityOptions: StaffActivityOption[] = ACTIVITY_ORDER.map((activity) => ({
    value: activity,
    label: ACTIVITY_LABEL[activity],
  }));
  const courseOptions: StaffActivityCourse[] = enrollments
    .map(({ enrollment }) => ({
      code: enrollment.course.code,
      name: enrollment.course.name,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));

  return (
    <>
      <PageIntro
        title={student.user.name}
        subtitle={`${student.usn} · ${STAGE_LABEL[student.currentStage]} · Semester ${student.currentSemester}`}
        action={
          atRisk ? (
            <StatusChip tone="critical" size="medium" label="At risk" />
          ) : certPace.status === 'BEHIND' ? (
            <StatusChip tone="warning" size="medium" label="Behind pace" />
          ) : (
            <StatusChip tone="good" size="medium" label="On track" />
          )
        }
      />

      {openAlerts.length > 0 && (
        <InfoBanner
          tone={openAlerts.some((a) => a.severity === 'CRITICAL') ? 'critical' : 'warning'}
          title={`${openAlerts.length} open flag${openAlerts.length === 1 ? '' : 's'}`}
        >
          {openAlerts
            .slice(0, 2)
            .map((alert) => alert.message.replace(/^[^—]+—\s*/, ''))
            .join(' · ')}
          {openAlerts.length > 2 ? ` · and ${openAlerts.length - 2} more` : ''}
        </InfoBanner>
      )}

      {/* The theme already draws the hairline under a tab bar; a wrapper with its
          own border would double it. */}
      <Tabs
        value={tab}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        sx={{ mb: 4 }}
        className="no-print"
      >
        {TABS.map((entry) => (
          <Tab
            key={entry.key}
            value={entry.key}
            label={entry.label}
            href={`/mentor/student/${id}?tab=${entry.key}`}
          />
        ))}
      </Tabs>

      {tab === 'overview' && (
        <OverviewTab
          firstName={firstName}
          overallPct={overallPct}
          attendancePct={attendancePct}
          certPace={certPace}
          focusScore={focus.focusScore}
          progressPerHour={focus.progressPerHour}
          forecast={forecast}
          enrollments={enrollments}
          alerts={alerts}
        />
      )}

      {tab === 'certifications' && <CertificationsTab certs={certs} />}

      {tab === 'attendance' && (
        <AttendanceTab studentId={student.id} attendancePct={attendancePct} />
      )}

      {tab === 'focus' && (
        // The sections carry their own bottom margin, so the columns need no
        // spacing of their own — one rhythm down the whole page.
        <Grid container columnSpacing={6}>
          <Grid size={{ xs: 12, lg: 7 }}>
            <SectionCard title="Progress pace: actual vs expected">
              <Typography variant="body1" sx={{ mb: 0.5 }}>
                {paceSentence(firstName, certPace)}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                {certPace.actualPct.toFixed(0)}% of the certification work is done. The
                curve expects {certPace.expectedPct.toFixed(0)}% by today.
              </Typography>

              <PaceCurveChart
                data={curve.map((point) => ({
                  label: point.label,
                  expected: point.expected,
                  actual: point.actual,
                }))}
                behind={certPace.status !== 'ON_TRACK'}
              />
            </SectionCard>

            <SectionCard
              title="Recent lab check-ins"
              subtitle={`Newest ${recentSessions.length} of ${student.labSessions.length} · active on ${consistency.activeDays} of the last ${consistency.windowDays} days`}
            >
              <FocusTimeline sessions={recentSessions} />
            </SectionCard>
          </Grid>

          <Grid size={{ xs: 12, lg: 5 }}>
            <SectionCard
              title="Focus quality"
              subtitle="How much progress each logged hour is producing"
            >
              <FocusQualityPanel focus={focus} consistency={consistency} firstName={firstName} />
            </SectionCard>

            <SectionCard
              title="Mentor notes"
              subtitle="Newest first — each one dated by the meeting and by when it was written"
            >
              <FocusNotes
                notes={notes.map((note) => ({
                  id: note.id,
                  noteText: note.noteText,
                  meetingAt: note.meetingAt,
                  createdAt: note.createdAt,
                  linkedAction: note.linkedAction,
                  authorName: `${note.mentor.title} ${note.mentor.user.name}`,
                }))}
              />
            </SectionCard>
          </Grid>
        </Grid>
      )}

      <StaffActivityPanel
        studentId={student.id}
        studentName={student.user.name}
        activities={activityOptions}
        courses={courseOptions}
        todayISO={isoDay(new Date())}
        earliestISO={isoDay(earliestDay)}
        earliestLabel={fullDate(earliestDay)}
        defaultActivity="ONLINE_COURSE"
        onLog={logActivityForStudent}
      />

      <UploadsPanel studentId={student.id} firstName={firstName} />

      <MeetingNotePanel
        studentId={student.id}
        studentName={student.user.name}
        defaultMeetingAt={localDateTimeValue(new Date())}
        onFlag={flagForFollowUp}
        onNudge={sendNudge}
        onSchedule={scheduleOneOnOne}
        onAddNote={addNote}
      />

      <TechNote>
        Focus here is measured from pace and from check-ins, and from nothing else. The
        inputs are badge and lab-PC check-ins, the completion percentage each provider
        reports at check-in and check-out, and notes a mentor writes after actually
        looking. There is no keystroke logging, no webcam proctoring and no
        browser-activity monitoring — and no field in the schema that could carry one,
        so the design cannot quietly drift that way later. That keeps the screen
        defensible on student privacy while still catching the case that matters:
        someone physically present in the lab whose completion number has not moved in
        weeks. Every button on the action bar writes a <code>MentorNote</code> with its
        linked action, so a student can be shown the whole record of what was said
        about them and when. Each note carries two timestamps and the log prints both:{' '}
        <code>meetingAt</code> is when the conversation happened and is editable, because
        Friday&rsquo;s 1:1 is often typed up on Monday and a booked 1:1 has not happened
        yet; <code>createdAt</code> is when the row was written and is not editable,
        which is what makes it evidence. &ldquo;Log time&rdquo; writes through the same{' '}
        <code>recordActivity()</code> the student&rsquo;s own form uses, so a mentor cannot
        enter a day the student would have been refused; the row lands as{' '}
        <code>MANUAL</code> and already mentor-confirmed rather than{' '}
        <code>SELF_REPORTED</code>, carries the name of whoever entered it, and — like every
        hand-entered row — adds hours without touching platform progress.
      </TechNote>
    </>
  );
}

/// What `<input type="datetime-local">` wants: `YYYY-MM-DDTHH:mm`, in the
/// server's local time, with no offset — the same wall-clock reading the browser
/// will show and the action will parse back.
function localDateTimeValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/// Formatted on the server, so no Date crosses into a client component.
function fullDate(date: Date): string {
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/// The gap, in words, above the chart — nobody should have to read it off a line.
function paceSentence(firstName: string, pace: StudentDetail['certPace']): string {
  const gap = Math.round(pace.expectedPct - pace.actualPct);
  if (gap >= 1) return `${firstName} is ${gap} points behind the expected curve.`;
  if (gap <= -1) {
    return `${firstName} is ${Math.abs(gap)} points ahead of the expected curve.`;
  }
  return `${firstName} is sitting exactly on the expected curve.`;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewTab({
  firstName,
  overallPct,
  attendancePct,
  certPace,
  focusScore,
  progressPerHour,
  forecast,
  enrollments,
  alerts,
}: {
  firstName: string;
  overallPct: number;
  attendancePct: number;
  certPace: StudentDetail['certPace'];
  focusScore: number;
  progressPerHour: number;
  forecast: Forecast;
  enrollments: StudentDetail['enrollments'];
  alerts: StudentDetail['alerts'];
}) {
  const openAlerts = alerts.filter((a) => a.resolvedAt == null);
  const courses = [...enrollments].sort((a, b) => a.completionPct - b.completionPct);

  return (
    <>
      <Grid container spacing={2.5} sx={{ mb: 5 }}>
        <Grid size={{ xs: 6, lg: 3 }}>
          <StatCard
            label="Overall completion"
            value={`${overallPct.toFixed(0)}%`}
            tone={PACE_TONE[certPace.status]}
            progress={overallPct}
            hint="Weighted across every enrolled course"
          />
        </Grid>
        <Grid size={{ xs: 6, lg: 3 }}>
          <StatCard
            label="Lecture attendance"
            value={`${attendancePct.toFixed(0)}%`}
            tone={attendancePct >= ATTENDANCE_FLOOR ? 'good' : 'warning'}
            hint={`The programme floor is ${ATTENDANCE_FLOOR}%`}
          />
        </Grid>
        <Grid size={{ xs: 6, lg: 3 }}>
          <StatCard
            label="Certification pace"
            value={paceDelta(certPace.deviationPct)}
            tone={PACE_TONE[certPace.status]}
            hint={`${PACE_LABEL[certPace.status]} — ${certPace.actualPct.toFixed(0)}% done, ${certPace.expectedPct.toFixed(0)}% expected`}
          />
        </Grid>
        <Grid size={{ xs: 6, lg: 3 }}>
          <StatCard
            label="Focus score"
            value={focusScore}
            tone={focusScore >= 70 ? 'good' : focusScore >= 45 ? 'warning' : 'critical'}
            hint={`${progressPerHour.toFixed(2)} progress points per logged hour`}
          />
        </Grid>
      </Grid>

      <SectionCard title="Will they finish?">
        <Typography variant="body1" sx={{ maxWidth: '78ch' }}>
          {forecastSentence(firstName, forecast)}
        </Typography>
      </SectionCard>

      <Grid container columnSpacing={6}>
        <Grid size={{ xs: 12, lg: 7 }}>
          <SectionCard
            title="Course progress"
            subtitle="Weakest first — that is where a 1:1 starts"
          >
            {courses.length === 0 ? (
              <EmptyState title="No enrolled courses." />
            ) : (
              <Stack spacing={2.5} sx={{ pt: 0.5 }}>
                {courses.map(({ enrollment, completionPct }) => (
                  <Box key={enrollment.id}>
                    <MeterRow
                      label={enrollment.course.code}
                      value={completionPct}
                      tone={
                        completionPct >= 70
                          ? 'good'
                          : completionPct >= 40
                            ? 'warning'
                            : 'critical'
                      }
                      labelWidth={92}
                    />
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ mt: 0.5, display: 'block', pl: '108px' }}
                    >
                      {enrollment.course.name} · teaching{' '}
                      {enrollment.teachingHoursAttended.toFixed(0)} of{' '}
                      {enrollment.course.teachingHours}h · self-learn{' '}
                      {formatHours(enrollment.selfLearningHoursLogged)} of{' '}
                      {enrollment.course.selfLearningHoursRequired}h
                    </Typography>
                  </Box>
                ))}
              </Stack>
            )}
          </SectionCard>
        </Grid>

        <Grid size={{ xs: 12, lg: 5 }}>
          <SectionCard
            title="Flags raised"
            subtitle={`${openAlerts.length} open of ${alerts.length} ever raised`}
          >
            {alerts.length === 0 ? (
              <EmptyState title="No flag has ever fired for this student." />
            ) : (
              <Stack>
                {alerts.slice(0, 8).map((alert) => (
                  <Box
                    key={alert.id}
                    sx={{
                      py: 1.75,
                      borderTop: 1,
                      borderColor: 'divider',
                      '&:first-of-type': { borderTop: 0, pt: 0 },
                    }}
                  >
                    <Stack
                      direction="row"
                      spacing={1.5}
                      sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}
                    >
                      <Typography
                        variant="body2"
                        color={alert.resolvedAt ? 'text.disabled' : 'text.primary'}
                        sx={{ flex: 1 }}
                      >
                        {alert.message}
                      </Typography>
                      {alert.resolvedAt ? (
                        <StatusChip tone="neutral" label="Resolved" />
                      ) : (
                        <StatusChip
                          tone={SEVERITY_TONE[alert.severity]}
                          label={SEVERITY_LABEL[alert.severity]}
                        />
                      )}
                    </Stack>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ mt: 0.5, display: 'block' }}
                    >
                      Raised {relativeDay(alert.triggeredAt).toLowerCase()}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            )}
          </SectionCard>
        </Grid>
      </Grid>
    </>
  );
}

/// Signed gap from the expected curve, in percentage points.
function paceDelta(deviationPct: number): string {
  const points = Math.round(deviationPct);
  if (points === 0) return 'On curve';
  return `${points > 0 ? '+' : '−'}${Math.abs(points)} pts`;
}

function forecastSentence(firstName: string, f: Forecast): string {
  const weeks = f.weeksRemaining.toFixed(0);

  if (f.velocityPctPerWeek <= 0.01) {
    return `Nothing has been logged in the last four weeks, so there is no pace to project from. With ${weeks} weeks left to the cohort deadline, ${firstName} needs ${f.requiredPctPerWeek.toFixed(1)} progress points a week from a standing start.`;
  }

  if (f.willFinishOnTime) {
    return `At ${f.velocityPctPerWeek.toFixed(1)} progress points a week, ${firstName} reaches ${f.projectedCompletionPct.toFixed(0)}% by the cohort deadline in ${weeks} weeks. Holding this pace is enough — nothing needs to change.`;
  }

  const short = Math.round(100 - f.projectedCompletionPct);
  const ask =
    f.extraHoursPerWeekNeeded > 0
      ? ` At ${firstName}'s own rate of progress that is roughly ${f.extraHoursPerWeekNeeded} more logged hours a week.`
      : '';

  return `At ${f.velocityPctPerWeek.toFixed(1)} progress points a week, ${firstName} reaches ${f.projectedCompletionPct.toFixed(0)}% by the cohort deadline in ${weeks} weeks — ${short} points short. Staying on the curve needs ${f.requiredPctPerWeek.toFixed(1)} points a week.${ask}`;
}

// ---------------------------------------------------------------------------
// Certifications
// ---------------------------------------------------------------------------

function CertificationsTab({ certs }: { certs: StudentDetail['certs'] }) {
  if (certs.length === 0) {
    return (
      <SectionCard title="Certifications">
        <EmptyState title="No certifications assigned to this student yet." />
      </SectionCard>
    );
  }

  const completed = certs.filter((row) => row.status === 'COMPLETED').length;
  const overdue = certs.filter((row) => row.status === 'OVERDUE').length;
  const notStarted = certs.filter((row) => row.status === 'NOT_STARTED').length;

  const rows: CertRow[] = certs.map(({ cert, status, pace }) => ({
    id: cert.id,
    name: cert.cert.name,
    provider: cert.cert.provider,
    courseCode: cert.cert.courseCode,
    progressPct: cert.progressPct,
    expectedPct: pace.expectedPct,
    due: cert.dueDate.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }),
    statusLabel: STATUS_LABEL[status],
    statusTone: CERT_TONE[status],
    optional: cert.cert.isOptional,
    selfReported: cert.selfReported,
  }));

  return (
    <>
      <Grid container spacing={2.5} sx={{ mb: 5 }}>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard label="Assigned" value={certs.length} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard label="Completed" value={completed} tone="good" />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Not started"
            value={notStarted}
            tone={notStarted > 0 ? 'warning' : 'neutral'}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Overdue"
            value={overdue}
            tone={overdue > 0 ? 'critical' : 'neutral'}
            hint="Behind the curve, not merely past the date"
          />
        </Grid>
      </Grid>

      <SectionCard
        title="Every certification"
        subtitle="Provider-reported progress against what the curve expects today"
      >
        <CertGrid rows={rows} />
      </SectionCard>
    </>
  );
}

// ---------------------------------------------------------------------------
// Attendance
//
// The per-course split is the one thing `getStudentDetail` does not carry — it
// only needs the rolled-up percentage — so this tab reads the raw records
// rather than widening the shared query for every other screen.
// ---------------------------------------------------------------------------

type CourseAttendance = {
  code: string;
  name: string;
  held: number;
  attended: number;
  pct: number;
  lastAbsence: Date | null;
};

async function attendanceByCourse(studentId: string): Promise<CourseAttendance[]> {
  const records = await prisma.attendanceRecord.findMany({
    where: { studentId },
    include: { course: { select: { name: true } } },
    orderBy: [{ courseCode: 'asc' }, { sessionNo: 'asc' }],
  });

  const byCourse = new Map<string, CourseAttendance>();
  for (const record of records) {
    const row = byCourse.get(record.courseCode) ?? {
      code: record.courseCode,
      name: record.course.name,
      held: 0,
      attended: 0,
      pct: 0,
      lastAbsence: null,
    };

    row.held += 1;
    if (record.present) row.attended += 1;
    else if (!row.lastAbsence || record.sessionDate > row.lastAbsence) {
      row.lastAbsence = record.sessionDate;
    }
    byCourse.set(record.courseCode, row);
  }

  return [...byCourse.values()]
    .map((row) => ({ ...row, pct: row.held > 0 ? (row.attended / row.held) * 100 : 0 }))
    // Worst first: a mentor opens this tab to find the class being skipped.
    .sort((a, b) => a.pct - b.pct);
}

async function AttendanceTab({
  studentId,
  attendancePct,
}: {
  studentId: string;
  attendancePct: number;
}) {
  const rows = await attendanceByCourse(studentId);
  const held = rows.reduce((sum, row) => sum + row.held, 0);
  const attended = rows.reduce((sum, row) => sum + row.attended, 0);
  const belowFloor = rows.filter((row) => row.pct < ATTENDANCE_FLOOR);

  return (
    <>
      <Grid container spacing={2.5} sx={{ mb: 5 }}>
        <Grid size={{ xs: 12, md: 4 }}>
          <StatCard
            label="Overall attendance"
            value={`${attendancePct.toFixed(0)}%`}
            tone={attendancePct >= ATTENDANCE_FLOOR ? 'good' : 'warning'}
            progress={attendancePct}
            hint={`${attended} of ${held} lectures attended`}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 4 }}>
          <StatCard
            label="Lectures missed"
            value={held - attended}
            hint="Across every enrolled course"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 4 }}>
          <StatCard
            label="Courses below the floor"
            value={belowFloor.length}
            tone={belowFloor.length === 0 ? 'neutral' : 'critical'}
            hint={`Under ${ATTENDANCE_FLOOR}% attendance`}
          />
        </Grid>
      </Grid>

      <SectionCard
        title="Attendance by course"
        subtitle="Instructor-led lectures only — lab check-ins live on the focus log"
      >
        {rows.length === 0 ? (
          <EmptyState
            title="No lecture attendance recorded."
            hint="These courses may be pure self-learn, which is tracked as lab check-ins rather than a register."
          />
        ) : (
          <Stack spacing={2.5} sx={{ pt: 0.5 }}>
            {rows.map((row) => (
              <Box key={row.code}>
                <MeterRow
                  label={row.code}
                  value={row.pct}
                  tone={
                    row.pct >= ATTENDANCE_FLOOR
                      ? 'good'
                      : row.pct >= 70
                        ? 'warning'
                        : 'critical'
                  }
                  labelWidth={92}
                />
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ mt: 0.5, display: 'block', pl: '108px' }}
                >
                  {row.name} · attended {row.attended} of {row.held}
                  {row.lastAbsence
                    ? ` · last missed ${relativeDay(row.lastAbsence).toLowerCase()}`
                    : ' · never absent'}
                </Typography>
              </Box>
            ))}
          </Stack>
        )}
      </SectionCard>
    </>
  );
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

async function UploadsPanel({
  studentId,
  firstName,
}: {
  studentId: string;
  firstName: string;
}) {
  const uploads = await prisma.upload.findMany({
    where: { studentId },
    orderBy: { uploadedAt: 'desc' },
    take: 6,
    include: { cert: { select: { name: true, courseCode: true } } },
  });

  const pending = uploads.filter((u) => u.status === 'PENDING_REVIEW').length;

  return (
    <SectionCard
      title="Uploads"
      subtitle={
        pending > 0
          ? `${pending} file${pending === 1 ? '' : 's'} waiting for you to check`
          : 'Certificates and documents from this student'
      }
      action={
        <Button href="/mentor/uploads" size="small" sx={{ color: 'text.secondary' }}>
          Verify uploads
        </Button>
      }
    >
      {uploads.length === 0 ? (
        <EmptyState
          title={`${firstName} has not uploaded anything yet.`}
          hint="Certificates uploaded from the student's own Uploads screen appear here, and verifying one turns that certification from self-reported into mentor-verified."
        />
      ) : (
        <Stack>
          {uploads.map((upload) => (
            <Stack
              key={upload.id}
              direction={{ xs: 'column', sm: 'row' }}
              spacing={{ xs: 0.5, sm: 2 }}
              sx={{
                py: 1.75,
                alignItems: { sm: 'center' },
                borderTop: 1,
                borderColor: 'divider',
                '&:first-of-type': { borderTop: 0, pt: 0 },
              }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="subtitle2">{upload.title}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {upload.cert
                    ? `${upload.cert.courseCode} — ${upload.cert.name}`
                    : UPLOAD_KIND_LABEL[upload.kind]}{' '}
                  · uploaded {relativeDay(upload.uploadedAt).toLowerCase()}
                </Typography>
              </Box>
              <StatusChip
                tone={UPLOAD_TONE[upload.status]}
                label={UPLOAD_STATUS_LABEL[upload.status]}
              />
            </Stack>
          ))}
        </Stack>
      )}
    </SectionCard>
  );
}
