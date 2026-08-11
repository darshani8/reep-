import Grid from '@mui/material/Grid';
import Typography from '@mui/material/Typography';

import { EmptyState, PageIntro, SectionCard, StatCard, TechNote } from '@/components/kit';
import {
  MentorAssignBoard,
  type AssignCohortOption,
  type AssignMentorOption,
  type AssignStudentRow,
} from '@/components/mentor-assign-board';
import { MentorAssignLoad, type MentorLoadRow } from '@/components/mentor-assign-load';
import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  overallCompletionPct,
  type CertProgressWithCert,
  type EnrollmentWithCourse,
} from '@/lib/progress';
import { STAGE_LABEL, daysBetween, relativeDay } from '@/lib/reep';

export const metadata = { title: 'Mentor assignment — Director' };
export const dynamic = 'force-dynamic';

/// Students who have never checked in sort to the bottom of "Last active"
/// rather than the top; the label still says "Never".
const NEVER_ACTIVE_DAYS = 9999;

/// Seeded mentor names already carry the honorific, so prefixing unconditionally
/// gives "Prof. Prof. Anita Desai". Same rule as the mentor home screen.
function mentorName(mentor: { title: string; user: { name: string } }): string {
  const { title, user } = mentor;
  return (user.name.startsWith(title) ? user.name : `${title} ${user.name}`).trim();
}

export default async function MentorAssignmentPage() {
  await requireRole('DIRECTOR', 'ADMIN');

  const [cohorts, mentors, students] = await Promise.all([
    prisma.cohort.findMany({ orderBy: { code: 'asc' } }),
    prisma.mentor.findMany({
      include: { user: true },
      orderBy: { user: { name: 'asc' } },
    }),
    prisma.student.findMany({
      include: {
        user: true,
        cohort: true,
        mentor: { include: { user: true } },
        enrollments: { include: { course: true } },
        certProgress: { include: { cert: { include: { course: true } } } },
        labSessions: {
          orderBy: { checkInAt: 'desc' },
          take: 1,
          select: { checkInAt: true },
        },
      },
      orderBy: { user: { name: 'asc' } },
    }),
  ]);

  const now = new Date();

  // Rows are plain JSON — no Dates, no enums needing a lookup the grid cannot
  // do, and every percentage already rounded, because the client wrapper must
  // not be asked to re-derive anything the server already knows.
  const rows: AssignStudentRow[] = students.map((student) => {
    const lastActiveAt = student.labSessions[0]?.checkInAt ?? null;
    return {
      id: student.id,
      name: student.user.name,
      usn: student.usn,
      cohortId: student.cohortId,
      cohortCode: student.cohort.code,
      stageLabel: `${STAGE_LABEL[student.currentStage]} · Sem ${student.currentSemester}`,
      mentorId: student.mentorId,
      mentorName: student.mentor ? mentorName(student.mentor) : 'Unassigned',
      overallPct: Math.round(
        overallCompletionPct(
          student.enrollments as EnrollmentWithCourse[],
          student.certProgress as CertProgressWithCert[],
        ),
      ),
      idleDays: lastActiveAt ? daysBetween(now, lastActiveAt) : NEVER_ACTIVE_DAYS,
      lastActiveLabel: relativeDay(lastActiveAt, now),
    };
  });

  function meanOf(group: AssignStudentRow[]): number {
    if (group.length === 0) return 0;
    return Math.round(group.reduce((sum, row) => sum + row.overallPct, 0) / group.length);
  }

  const load: MentorLoadRow[] = mentors.map((mentor) => {
    const mine = rows.filter((row) => row.mentorId === mentor.id);
    return {
      id: mentor.id,
      name: mentorName(mentor),
      group: `${mentor.mentorGroup} · ${mentor.department}`,
      menteeCount: mine.length,
      meanPct: meanOf(mine),
    };
  });

  const unassigned = rows.filter((row) => row.mentorId === null);
  const assignedCount = rows.length - unassigned.length;

  const mentorOptions: AssignMentorOption[] = load.map((mentor) => ({
    id: mentor.id,
    name: mentor.name,
    group: mentor.group,
    menteeCount: mentor.menteeCount,
  }));

  const cohortOptions: AssignCohortOption[] = cohorts.map((cohort) => ({
    id: cohort.id,
    code: cohort.code,
  }));

  // The one sentence this screen is for: how far apart the heaviest and
  // lightest caseloads are.
  const sorted = [...load].sort((a, b) => b.menteeCount - a.menteeCount);
  const heaviest = sorted[0];
  const lightest = sorted[sorted.length - 1];
  const spread = heaviest && lightest ? heaviest.menteeCount - lightest.menteeCount : 0;

  return (
    <>
      <PageIntro
        title="Mentor assignment"
        subtitle={`Move students between the ${mentors.length} faculty mentors. A student's mentor decides whose roster, alert queue and upload review they appear on, so this is the one place a caseload changes.`}
      />

      <Grid container spacing={2.5} sx={{ mb: 5 }}>
        <Grid size={{ xs: 6, lg: 3 }}>
          <StatCard label="Students" value={rows.length} hint="Across every cohort" />
        </Grid>
        <Grid size={{ xs: 6, lg: 3 }}>
          <StatCard
            label="Assigned to a mentor"
            value={assignedCount}
            tone={unassigned.length === 0 ? 'good' : 'neutral'}
          />
        </Grid>
        <Grid size={{ xs: 6, lg: 3 }}>
          <StatCard
            label="Unassigned"
            value={unassigned.length}
            tone={unassigned.length > 0 ? 'warning' : 'good'}
            hint={
              unassigned.length > 0
                ? 'Nobody sees these students on a roster'
                : 'Everybody has a mentor'
            }
          />
        </Grid>
        <Grid size={{ xs: 6, lg: 3 }}>
          <StatCard
            label="Mentors"
            value={mentors.length}
            hint={
              mentors.length > 0
                ? `${Math.round(assignedCount / mentors.length)} students each on average`
                : undefined
            }
          />
        </Grid>
      </Grid>

      <SectionCard
        title="Mentor load"
        subtitle="Caseload against the largest, with each mentor's mean REEP completion beside it"
      >
        {mentors.length === 0 ? (
          <EmptyState
            title="No mentors have been set up yet."
            hint="Mentor accounts are created with a MENTOR role; until one exists there is nobody to assign students to."
          />
        ) : (
          <>
            <MentorAssignLoad
              mentors={load}
              unassignedCount={unassigned.length}
              unassignedMeanPct={meanOf(unassigned)}
            />
            {heaviest && lightest && spread > 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 3 }}>
                {heaviest.name} carries {heaviest.menteeCount} mentees against{' '}
                {lightest.name}&rsquo;s {lightest.menteeCount} — a {spread}-student gap. Select
                the students below and use the even split to close it.
              </Typography>
            ) : null}
          </>
        )}
      </SectionCard>

      <SectionCard
        title="All students"
        subtitle="Filter, select, then assign. Nothing is written until you press a button."
      >
        {rows.length === 0 ? (
          <EmptyState title="No students are enrolled yet." />
        ) : (
          <MentorAssignBoard rows={rows} mentors={mentorOptions} cohorts={cohortOptions} />
        )}
      </SectionCard>

      <TechNote>
        Assignment is a single nullable column — <code>Student.mentorId</code> — and it is the
        only thing that scopes a mentor&rsquo;s view of the programme. Every{' '}
        <code>/mentor</code> screen queries <code>students where mentorId = me</code>, the alert
        queue is that same set, and <code>accessForStudent</code> lets a mentor open or verify an
        upload only when the student is one of their mentees. So reassigning does not copy a
        record or move a file: the student&rsquo;s whole history — notes, flags, focus log,
        certificate proofs — follows them to the new mentor, and disappears from the old
        one&rsquo;s screens on the next load. Mentor notes keep their original author, so history
        stays attributable after a move. The write is one{' '}
        <code>updateMany</code> per target mentor, guarded server-side by{' '}
        <code>requireRole(&apos;DIRECTOR&apos;, &apos;ADMIN&apos;)</code> — a mentor POSTing the
        action directly is redirected, not obeyed. The even split is positional rather than
        random (student <em>i</em> to mentor <em>i mod n</em>), which is why the counts previewed
        before the button are exactly the counts written after it.
      </TechNote>
    </>
  );
}
