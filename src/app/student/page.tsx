import { notFound } from 'next/navigation';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import ListItemButton from '@mui/material/ListItemButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import {
  EmptyState,
  InfoBanner,
  MeterRow,
  PageIntro,
  ProgressMeter,
  SectionCard,
  StatusChip,
  TechNote,
  type Tone,
} from '@/components/kit';
import { GlassPanel, NeuPanel, NeuStat, SurfaceScene } from '@/components/surfaces';
import { requireStudent } from '@/lib/auth';
import { getStudentHome } from '@/lib/queries';
import {
  DIMENSION_LABEL,
  MODE_SHORT,
  PACE_LABEL,
  STAGE_BLURB,
  STAGE_LABEL,
} from '@/lib/reep';
import type { PaceStatus } from '@prisma/client';

export const metadata = { title: 'REEP Journey — Student' };
export const dynamic = 'force-dynamic';

/// Pace is the one thing on this page that earns a hue: it is a status the
/// student is meant to act on. Everything else — stages, dimensions — is a
/// measurement, and reads in ink.
const PACE_TONE: Record<PaceStatus, Tone> = {
  ON_TRACK: 'good',
  BEHIND: 'warning',
  AT_RISK: 'critical',
};

export default async function StudentHomePage() {
  const { studentId } = await requireStudent();
  const data = await getStudentHome(studentId);
  if (!data) notFound();

  const { student, stages, dimensions, currentCourses, upcoming, openAlerts, overallPct } =
    data;
  const firstName = student.user.name.split(' ')[0];

  return (
    <SurfaceScene>
      {/* --- the hero: everything you need before scrolling --------------- */}
      <GlassPanel sx={{ mb: 5 }}>
        <PageIntro
          title={`Welcome back, ${firstName}`}
          subtitle="Where you have got to in the programme, and what is coming next."
          action={
            <Button href="/student/time-log" variant="contained" color="secondary">
              Log study time
            </Button>
          }
          sx={{ mb: 3.5 }}
        />

        <Grid container spacing={2.5}>
          <Grid size={{ xs: 12, sm: 4 }}>
            <NeuStat
              label="Overall completion"
              value={`${overallPct.toFixed(0)}%`}
              progress={overallPct}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 4 }}>
            <NeuStat
              label="Courses in progress"
              value={currentCourses.length}
              hint="In your current stage"
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 4 }}>
            <NeuStat
              label="Open flags"
              value={openAlerts.length}
              tone={openAlerts.length > 0 ? 'warning' : 'good'}
              hint={
                openAlerts.length > 0 ? 'Your mentor can see these too' : 'Nothing outstanding'
              }
            />
          </Grid>
        </Grid>
      </GlassPanel>

      {openAlerts.length > 0 ? (
        <InfoBanner tone="warning" title="Needs attention">
          {openAlerts
            .slice(0, 2)
            .map((alert) => alert.message.replace(/^[^—]+—\s*/, ''))
            .join(' · ')}
          {openAlerts.length > 2 ? ` · and ${openAlerts.length - 2} more` : ''}
        </InfoBanner>
      ) : null}

      {/* --- the journey rail ------------------------------------------- */}
      {/* Four tiles of the same material, so the one you are standing on is
          told apart by an accent edge rather than by being a different object. */}
      <SectionCard
        title="Your REEP journey"
        subtitle="How far you are through each of the four stages"
      >
        <Grid container spacing={{ xs: 2.5, md: 3 }}>
          {stages.map((stage) => {
            const isCurrent = stage.stage === student.currentStage;
            return (
              <Grid key={stage.stage} size={{ xs: 12, sm: 6, lg: 3 }}>
                <NeuPanel
                  sx={{
                    height: '100%',
                    ...(isCurrent
                      ? {
                          boxShadow: 'var(--reep-neu-shadow-lift)',
                          outline: '1.5px solid',
                          outlineColor: 'secondary.main',
                          outlineOffset: '-1.5px',
                        }
                      : {}),
                  }}
                >
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ alignItems: 'baseline', justifyContent: 'space-between' }}
                  >
                    <Typography
                      variant="h4"
                      component="h3"
                      sx={{ color: isCurrent ? 'text.primary' : 'text.secondary' }}
                    >
                      {STAGE_LABEL[stage.stage]}
                    </Typography>
                    {isCurrent ? (
                      <Typography
                        variant="caption"
                        sx={{ color: 'secondary.main', fontWeight: 600, flexShrink: 0 }}
                      >
                        You are here
                      </Typography>
                    ) : null}
                  </Stack>

                  <Typography
                    className="tabular"
                    sx={{
                      mt: 1.25,
                      fontSize: '1.75rem',
                      fontWeight: 600,
                      lineHeight: 1.05,
                      letterSpacing: '-0.025em',
                      color: isCurrent ? 'text.primary' : 'text.secondary',
                    }}
                  >
                    {stage.pct.toFixed(0)}%
                  </Typography>

                  <ProgressMeter
                    value={stage.pct}
                    tone={isCurrent ? 'accent' : 'neutral'}
                    sx={{ mt: 1.25 }}
                    label={`${STAGE_LABEL[stage.stage]} progress`}
                  />

                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                    {stage.courseCount > 0
                      ? `${stage.completedCourses} of ${stage.courseCount} courses complete`
                      : 'Not started yet'}
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.disabled"
                    sx={{ mt: 0.5, display: 'block' }}
                  >
                    {STAGE_BLURB[stage.stage]}
                  </Typography>
                </NeuPanel>
              </Grid>
            );
          })}
        </Grid>
      </SectionCard>

      <Grid container spacing={{ xs: 0, lg: 5 }}>
        {/* --- development dimensions ----------------------------------- */}
        <Grid size={{ xs: 12, lg: 5 }}>
          <SectionCard
            title="Development dimensions"
            subtitle="Rolled up from each course's tagged dimension"
          >
            <Stack spacing={2.5}>
              {dimensions.map((dimension) => (
                <MeterRow
                  key={dimension.dimension}
                  label={DIMENSION_LABEL[dimension.dimension]}
                  value={dimension.pct}
                  tone="neutral"
                  labelWidth={104}
                />
              ))}
            </Stack>
          </SectionCard>
        </Grid>

        {/* --- current courses ------------------------------------------ */}
        <Grid size={{ xs: 12, lg: 7 }}>
          <SectionCard
            title="Current courses"
            subtitle={`${STAGE_LABEL[student.currentStage]} · Semester ${student.currentSemester}`}
            action={
              <Button href="/student/courses" size="small">
                All courses
              </Button>
            }
          >
            {currentCourses.length === 0 ? (
              <EmptyState title="No active courses in this stage yet." />
            ) : (
              <Stack>
                {currentCourses.map((entry) => (
                  <ListItemButton
                    key={entry.course.code}
                    href={`/student/courses#${entry.course.code}`}
                    sx={{
                      display: 'block',
                      px: 1.5,
                      mx: -1.5,
                      py: 1.75,
                      borderTop: 1,
                      borderColor: 'divider',
                      borderRadius: 0,
                      '&:first-of-type': { borderTop: 0, pt: 0 },
                    }}
                  >
                    <Stack
                      direction="row"
                      spacing={1.5}
                      sx={{ alignItems: 'baseline', justifyContent: 'space-between' }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="subtitle1">{entry.course.name}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {entry.course.code}
                        </Typography>
                      </Box>
                      <Box sx={{ flexShrink: 0 }}>
                        <StatusChip
                          tone={PACE_TONE[entry.paceStatus]}
                          label={PACE_LABEL[entry.paceStatus]}
                        />
                      </Box>
                    </Stack>

                    <Stack
                      direction="row"
                      spacing={2}
                      sx={{ mt: 1.25, alignItems: 'center' }}
                    >
                      <ProgressMeter
                        value={entry.completionPct}
                        tone={PACE_TONE[entry.paceStatus]}
                        sx={{ flex: 1 }}
                        label={`${entry.course.code} completion`}
                      />
                      <Typography
                        className="tabular"
                        variant="body2"
                        sx={{ width: 40, textAlign: 'right', flexShrink: 0, fontWeight: 500 }}
                      >
                        {entry.completionPct.toFixed(0)}%
                      </Typography>
                    </Stack>

                    <Typography
                      variant="caption"
                      color="text.disabled"
                      className="tabular"
                      sx={{ mt: 0.75, display: 'block' }}
                    >
                      {describeHours(entry)}
                    </Typography>
                  </ListItemButton>
                ))}
              </Stack>
            )}
          </SectionCard>
        </Grid>
      </Grid>

      {/* --- upcoming --------------------------------------------------- */}
      <SectionCard title="Upcoming" subtitle="The next few days">
        {upcoming.length === 0 ? (
          <EmptyState title="Nothing scheduled in the next few days." />
        ) : (
          <Stack>
            {upcoming.map((item) => (
              <Stack
                key={item.id}
                direction={{ xs: 'column', sm: 'row' }}
                spacing={{ xs: 0.5, sm: 3 }}
                sx={{
                  py: 1.75,
                  alignItems: { sm: 'center' },
                  borderTop: 1,
                  borderColor: 'divider',
                  '&:first-of-type': { borderTop: 0, pt: 0 },
                }}
              >
                <Typography
                  variant="subtitle2"
                  sx={{ width: { sm: 168 }, flexShrink: 0 }}
                >
                  {relativeLabel(item.startsAt)}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                  {item.title}
                </Typography>
                {item.location ? (
                  <Typography variant="caption" color="text.disabled">
                    {item.location}
                  </Typography>
                ) : null}
              </Stack>
            ))}
          </Stack>
        )}
      </SectionCard>

      <TechNote>
        Stage % is a weighted average of (teaching-hours attended +
        certification-hours completed) across that stage&apos;s courses, weighted by each
        course&apos;s total hours. Dimension scores roll up from each course&apos;s tagged
        Developmental Dimension using the same weighting. Both live in{' '}
        <code>src/lib/progress.ts</code>, so there is one definition of &ldquo;progress&rdquo;
        in the codebase. The depth on this screen is presentation only — the frosted hero,
        the extruded stage tiles and their carved meters all come from custom properties in{' '}
        <code>src/theme.ts</code> and compose the same <code>StatCard</code> and{' '}
        <code>ProgressMeter</code> every other screen uses, so no number, tone or contrast
        ratio changes with the styling. It flattens to plain surfaces for print, where the
        browser drops backgrounds, and for readers who have asked their system for reduced
        transparency.
      </TechNote>
    </SurfaceScene>
  );
}

/// "Teaching 12/20h · Self-Learn 40/69h", or a lecture count for the
/// instructor-led courses that have no hour denominator.
function describeHours(entry: {
  course: {
    modelType: string;
    teachingHours: number;
    selfLearningHoursRequired: number;
  };
  enrollment: {
    teachingHoursAttended: number;
    selfLearningHoursLogged: number;
    lecturesAttended: number;
    lecturesTotal: number;
  };
}): string {
  const { course, enrollment } = entry;

  if (course.modelType === 'INSTRUCTOR_LED') {
    return `Lecture ${enrollment.lecturesAttended}/${enrollment.lecturesTotal}`;
  }

  const parts: string[] = [];
  if (course.teachingHours > 0) {
    parts.push(
      `${MODE_SHORT.INSTRUCTOR_LED} ${enrollment.teachingHoursAttended.toFixed(0)}/${course.teachingHours}h`,
    );
  }
  if (course.selfLearningHoursRequired > 0) {
    const mode =
      course.modelType === 'SUPERVISED_SELF_LEARN'
        ? MODE_SHORT.SUPERVISED_LAB
        : MODE_SHORT.INDEPENDENT;
    parts.push(
      `${mode} ${enrollment.selfLearningHoursLogged.toFixed(0)}/${course.selfLearningHoursRequired}h`,
    );
  }
  return parts.join('   ·   ');
}

function relativeLabel(date: Date): string {
  const now = new Date();
  const startOf = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(date) - startOf(now)) / 86_400_000);
  const time = date.toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Tomorrow, ${time}`;
  if (days > 1 && days <= 6) {
    return `${date.toLocaleDateString('en-IN', { weekday: 'long' })}, ${time}`;
  }
  if (days < 0) return `${Math.abs(days)} days ago`;
  return `In ${days} days`;
}
