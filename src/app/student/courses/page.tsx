import { notFound } from 'next/navigation';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import {
  EmptyState,
  Fact,
  MeterRow,
  PageIntro,
  SectionCard,
  StatCard,
  StatusChip,
  TechNote,
  type Tone,
} from '@/components/kit';
import { requireStudent } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  certificationStatus,
  courseCompletionPct,
  type CertProgressWithCert,
  type EnrollmentWithCourse,
} from '@/lib/progress';
import { getStudentHome } from '@/lib/queries';
import {
  COURSE_MODEL_LABEL,
  DIMENSION_LABEL,
  STAGE_BLURB,
  STAGE_LABEL,
  STAGE_ORDER,
  STATUS_LABEL,
  formatHours,
} from '@/lib/reep';
import type { ProgressStatus, Stage } from '@prisma/client';

import { StageSection } from './stage-section';

export const metadata = { title: 'My Courses — Student' };
export const dynamic = 'force-dynamic';

const CERT_TONE: Record<ProgressStatus, Tone> = {
  COMPLETED: 'good',
  IN_PROGRESS: 'warning',
  NOT_STARTED: 'neutral',
  OVERDUE: 'critical',
};

type CertRow = {
  code: string;
  name: string;
  meta: string;
  optional: boolean;
  pct: number;
  status: ProgressStatus;
};

type CourseView = {
  code: string;
  name: string;
  stage: Stage;
  description: string | null;
  dimensionLabel: string;
  modelLabel: string;
  semester: number;
  completionPct: number;
  done: boolean;
  teaching: string | null;
  selfLearning: string | null;
  lectures: string | null;
  certs: CertRow[];
};

export default async function StudentCoursesPage() {
  const { studentId } = await requireStudent();
  const data = await getStudentHome(studentId);
  if (!data) notFound();

  const { student } = data;
  const enrollments = student.enrollments as EnrollmentWithCourse[];
  const progressRows = student.certProgress as CertProgressWithCert[];
  const now = new Date();

  // The certifications the *courses* carry, not only the ones this student
  // already has a progress row against: a certification added to the syllabus
  // mid-term should still appear on the card, as "Not Started", rather than
  // quietly go missing.
  const catalogue = await prisma.certification.findMany({
    where: { courseCode: { in: enrollments.map((e) => e.courseCode) } },
    orderBy: [{ dueWeek: 'asc' }, { name: 'asc' }],
  });

  const courses: CourseView[] = enrollments
    .map((enrollment) => {
      const { course } = enrollment;
      const pct = courseCompletionPct(enrollment, progressRows);

      const certs: CertRow[] = catalogue
        .filter((cert) => cert.courseCode === course.code)
        .map((cert) => {
          const progress = progressRows.find((row) => row.certCode === cert.code);
          const status = progress
            ? certificationStatus(progress, now).status
            : ('NOT_STARTED' as ProgressStatus);

          const due = progress
            ? `due ${progress.dueDate.toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}`
            : `due in week ${cert.dueWeek}`;

          return {
            code: cert.code,
            name: cert.name,
            meta: `${cert.provider} · ${formatHours(cert.requiredHours)} · ${due}`,
            optional: cert.isOptional,
            pct: progress?.progressPct ?? 0,
            status,
          };
        });

      return {
        code: course.code,
        name: course.name,
        stage: course.stage,
        description: course.description,
        dimensionLabel: DIMENSION_LABEL[course.dimension],
        modelLabel: COURSE_MODEL_LABEL[course.modelType],
        semester: course.semester,
        completionPct: pct,
        // Trust the enrolment flag first; the derived % closes out the rows a
        // coordinator has not marked off yet.
        done: enrollment.status === 'COMPLETED' || pct >= 99.5,
        teaching:
          course.teachingHours > 0
            ? `${formatHours(enrollment.teachingHoursAttended)} of ${formatHours(course.teachingHours)}`
            : null,
        selfLearning:
          course.selfLearningHoursRequired > 0
            ? `${formatHours(enrollment.selfLearningHoursLogged)} of ${formatHours(course.selfLearningHoursRequired)}`
            : null,
        lectures:
          enrollment.lecturesTotal > 0
            ? `${enrollment.lecturesAttended} of ${enrollment.lecturesTotal}`
            : null,
        certs,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));

  const groups = STAGE_ORDER.map((stage) => ({
    stage,
    courses: courses.filter((course) => course.stage === stage),
  })).filter((group) => group.courses.length > 0);

  const finishedCourses = courses.filter((course) => course.done).length;
  const allCerts = courses.flatMap((course) => course.certs);
  const earnedCerts = allCerts.filter((cert) => cert.status === 'COMPLETED').length;

  return (
    <>
      <PageIntro
        title="My courses"
        subtitle="Everything you are enrolled on, grouped by REEP stage. Open a stage to see its courses."
        action={
          <Button href="/student/certifications" variant="outlined">
            Certification tracker
          </Button>
        }
      />

      <Grid container spacing={2.5} sx={{ mb: 3 }}>
        <Grid size={{ xs: 12, sm: 4 }}>
          <StatCard
            label="Courses enrolled"
            value={courses.length}
            hint={`Across ${groups.length} ${groups.length === 1 ? 'stage' : 'stages'}`}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <StatCard
            label="Courses finished"
            value={`${finishedCourses} of ${courses.length}`}
            tone={courses.length > 0 && finishedCourses === courses.length ? 'good' : 'neutral'}
            hint="Reboot closes out before Semester 1 starts"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <StatCard
            label="Certifications earned"
            value={`${earnedCerts} of ${allCerts.length}`}
            progress={allCerts.length > 0 ? (earnedCerts / allCerts.length) * 100 : 0}
          />
        </Grid>
      </Grid>

      {groups.length === 0 ? (
        <SectionCard title="Your courses">
          <EmptyState
            title="You are not enrolled on any courses yet."
            hint="The programme office loads enrolment at the start of each stage. It will appear here as soon as that happens."
          />
        </SectionCard>
      ) : (
        groups.map((group) => {
          const finished = group.courses.filter((course) => course.done).length;
          const isCurrent = group.stage === student.currentStage;

          return (
            <StageSection
              key={group.stage}
              title={STAGE_LABEL[group.stage]}
              blurb={STAGE_BLURB[group.stage]}
              meta={`${finished} of ${group.courses.length} finished`}
              current={isCurrent}
              // Finished stages fold away; anything with work left stays open.
              defaultExpanded={isCurrent || finished < group.courses.length}
              courseCodes={group.courses.map((course) => course.code)}
            >
              <Grid container spacing={{ xs: 4, lg: 5 }}>
                {group.courses.map((course) => (
                  <Grid key={course.code} size={{ xs: 12, lg: 6 }}>
                    <CourseEntry course={course} />
                  </Grid>
                ))}
              </Grid>
            </StageSection>
          );
        })
      )}

      <TechNote>
        Every course card carries <code>id=&quot;REE1xx&quot;</code>, so any screen can send a
        student straight to one course with <code>/student/courses#REE103</code> — that is how
        the tiles on the journey home navigate. If the stage is folded, the panel opens itself
        before scrolling, because a browser will not jump to something inside a collapsed
        panel. The completion bar is the same <code>courseCompletionPct()</code> the journey
        rail averages, so one course never shows two different numbers: instructor-led hours
        attended plus certification hours <em>earned</em> (a certification&apos;s required hours
        scaled by the provider&apos;s reported %), over the course&apos;s total hours; a course
        with no hours at all falls back to its lecture count. Certifications are read from the
        course, not only from this student&apos;s progress rows, so one added to the syllabus
        mid-term still shows up as Not Started instead of disappearing.
      </TechNote>
    </>
  );
}

// ---------------------------------------------------------------------------

/// One course, boxless: a heading, a measurement, the facts under it. A hairline
/// above separates it from the course beside it without drawing a frame.
function CourseEntry({ course }: { course: CourseView }) {
  return (
    <Box
      id={course.code}
      sx={{
        height: '100%',
        pt: 2.5,
        borderTop: 1,
        borderColor: 'divider',
        // Clear the fixed app bar when a deep link scrolls to this course.
        scrollMarginTop: 96,
      }}
    >
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h4" component="h3">{course.name}</Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 0.25 }}
          >
            {course.code} · {course.modelLabel} · Semester {course.semester} ·{' '}
            {course.dimensionLabel}
          </Typography>
        </Box>

        {course.done ? (
          <Box sx={{ flexShrink: 0 }}>
            <StatusChip tone="good" label="Finished" />
          </Box>
        ) : null}
      </Stack>

      {course.description ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          {course.description}
        </Typography>
      ) : null}

      <Box sx={{ mt: 2.5 }}>
        <MeterRow
          label="Complete"
          value={course.completionPct}
          tone={course.done ? 'good' : 'neutral'}
          labelWidth={76}
        />
      </Box>

      <Grid container spacing={2.5} sx={{ mt: 1.5 }}>
        {course.teaching ? (
          <Grid size={{ xs: 6, sm: 4 }}>
            <Fact label="Classes attended" value={course.teaching} />
          </Grid>
        ) : null}
        {course.selfLearning ? (
          <Grid size={{ xs: 6, sm: 4 }}>
            <Fact label="Self-learning logged" value={course.selfLearning} />
          </Grid>
        ) : null}
        {course.lectures ? (
          <Grid size={{ xs: 6, sm: 4 }}>
            <Fact label="Lectures attended" value={course.lectures} />
          </Grid>
        ) : null}
      </Grid>

      <Box sx={{ mt: 3 }}>
        <Typography variant="subtitle2" color="text.secondary">
          Certifications
        </Typography>

        {course.certs.length === 0 ? (
          <Typography variant="body2" color="text.disabled" sx={{ mt: 0.5 }}>
            None attached — this course is judged on attendance alone.
          </Typography>
        ) : (
          <Stack sx={{ mt: 1 }}>
            {course.certs.map((cert) => (
              <Stack
                key={cert.code}
                direction={{ xs: 'column', sm: 'row' }}
                spacing={{ xs: 0.75, sm: 2 }}
                sx={{
                  py: 1.5,
                  alignItems: { sm: 'center' },
                  borderTop: 1,
                  borderColor: 'divider',
                  '&:first-of-type': { borderTop: 0, pt: 0 },
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2">
                    {cert.name}
                    {cert.optional ? (
                      <Box component="span" sx={{ color: 'text.disabled' }}>
                        {' '}
                        (optional)
                      </Box>
                    ) : null}
                  </Typography>
                  <Typography variant="caption" color="text.disabled">
                    {cert.meta}
                  </Typography>
                </Box>

                <Stack
                  direction="row"
                  spacing={1.5}
                  sx={{ alignItems: 'center', flexShrink: 0 }}
                >
                  <Typography
                    variant="body2"
                    className="tabular"
                    sx={{ fontWeight: 500, width: 40, textAlign: 'right' }}
                  >
                    {cert.pct.toFixed(0)}%
                  </Typography>
                  <StatusChip tone={CERT_TONE[cert.status]} label={STATUS_LABEL[cert.status]} />
                </Stack>
              </Stack>
            ))}
          </Stack>
        )}
      </Box>
    </Box>
  );
}
