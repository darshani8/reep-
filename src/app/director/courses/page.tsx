import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Typography from '@mui/material/Typography';

import { EmptyState, PageIntro, SectionCard, StatCard, TechNote } from '@/components/kit';
import { DirectorCoursesGrid, type CourseRowView } from '@/components/director-courses-grid';
import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getDirectorAnalytics } from '@/lib/queries';
import { COURSE_MODEL_LABEL, DIMENSION_LABEL, STAGE_LABEL, formatHours } from '@/lib/reep';

export const metadata = { title: 'Courses — Director' };
export const dynamic = 'force-dynamic';

export default async function DirectorCoursesPage() {
  await requireRole('DIRECTOR', 'ADMIN');

  // The analytics query carries the aggregates; the curriculum metadata (stage,
  // dimension, model, hours) comes straight from the catalogue.
  const [{ allCourses }, courses] = await Promise.all([
    getDirectorAnalytics(),
    prisma.course.findMany({ orderBy: { code: 'asc' } }),
  ]);

  const statsByCode = new Map(allCourses.map((course) => [course.courseCode, course]));

  const rows: CourseRowView[] = courses.map((course) => {
    const stats = statsByCode.get(course.code);
    const totalHours = course.teachingHours + course.selfLearningHoursRequired;

    return {
      id: course.code,
      code: course.code,
      name: course.name,
      stage: STAGE_LABEL[course.stage],
      dimension: DIMENSION_LABEL[course.dimension],
      model: COURSE_MODEL_LABEL[course.modelType],
      hoursLabel: formatHours(totalHours),
      hoursSplit: `${course.teachingHours} taught + ${course.selfLearningHoursRequired} self`,
      totalHours,
      enrolledCount: stats?.enrolledCount ?? 0,
      completionPct: stats?.completionPct ?? 0,
      atRiskCount: stats?.atRiskCount ?? 0,
    };
  });

  // Weakest first: the reason a director opens this screen is to find the
  // course the cohort is stuck in.
  const sorted = [...rows].sort((a, b) => a.completionPct - b.completionPct);

  const taught = rows.filter((row) => row.enrolledCount > 0);
  const meanCompletion =
    taught.length > 0
      ? taught.reduce((sum, row) => sum + row.completionPct, 0) / taught.length
      : 0;
  const enrolments = rows.reduce((sum, row) => sum + row.enrolledCount, 0);
  const belowHalf = taught.filter((row) => row.completionPct < 50).length;
  const weakest = taught.length > 0 ? sorted.find((row) => row.enrolledCount > 0) : undefined;

  return (
    <>
      <PageIntro
        title="Courses"
        subtitle={`${rows.length} courses in the REEP curriculum, ${enrolments} enrolments between them.`}
      />

      <Grid container spacing={4} sx={{ mb: 7 }}>
        <Grid size={{ xs: 6, sm: 4 }}>
          <StatCard
            label="Average completion"
            value={`${meanCompletion.toFixed(0)}%`}
            hint={`Across the ${taught.length} courses with students on them`}
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 4 }}>
          <StatCard
            label="Courses below 50%"
            value={belowHalf}
            tone={belowHalf > 0 ? 'critical' : 'good'}
            hint="Where the group as a whole is stuck"
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 4 }}>
          <StatCard
            label="Total enrolments"
            value={enrolments}
            hint="One per student, per course"
          />
        </Grid>
      </Grid>

      <SectionCard title="All courses" subtitle="Weakest completion first">
        {rows.length === 0 ? (
          <EmptyState title="No courses have been set up yet." />
        ) : (
          <>
            {weakest && (
              <Box sx={{ mb: 2.5, maxWidth: '72ch' }}>
                <Typography variant="body1">
                  {weakest.code} needs attention first: its {weakest.enrolledCount} students
                  average {weakest.completionPct}% completion.
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {weakest.name} · {weakest.stage} · {weakest.hoursLabel}
                </Typography>
              </Box>
            )}
            <DirectorCoursesGrid rows={sorted} />
          </>
        )}
      </SectionCard>

      <TechNote>
        Mean completion is the same per-course figure a student sees on their own
        journey rail — teaching hours attended plus certification hours earned, over
        the hours the course is worth — averaged across everyone enrolled. Courses
        nobody is enrolled on yet still appear, so the catalogue is complete, but they
        are left out of the averages above: a completion rate over zero students is
        noise, not a signal. The &ldquo;bottlenecks&rdquo; filter uses the same 50%
        line the analytics screen colours its bars with, and the export writes exactly
        the rows and columns on screen so a printed pack matches the dashboard.
      </TechNote>
    </>
  );
}
