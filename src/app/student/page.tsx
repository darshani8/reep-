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
import { SgpaChart, SubjectMarksChart, SubjectMarksKey } from '@/components/marks-chart';
import { MocksChart, MocksKey } from '@/components/mocks-chart';
import { RankedBarChart } from '@/components/reep-charts';
import { SkillBadges } from '@/components/skill-badges';
import { SkillRecommendations } from '@/components/skill-recommendations';
import { StreakTile } from '@/components/streak-tile';
import { SwocChart, SwocHighlights } from '@/components/swoc-chart';
import { GlassPanel, NeuPanel, NeuStat, SurfaceScene } from '@/components/surfaces';
import { requireStudent } from '@/lib/auth';
import { getStudentLanding } from '@/lib/landing/queries';
import { ATTENDANCE_COMFORT_PCT } from '@/lib/landing/tiles';
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

/// Pace is one of the two things on this page that earn a hue: it is a status
/// the student is meant to act on. Attendance is the other, and only because it
/// is the one number a placement decision is refused on. Everything else —
/// stages, dimensions, marks, mocks, streaks — is a measurement, and reads in
/// ink.
const PACE_TONE: Record<PaceStatus, Tone> = {
  ON_TRACK: 'good',
  BEHIND: 'warning',
  AT_RISK: 'critical',
};

/**
 * The screen a student lands on, and the one they see most.
 *
 * Eight tiles, all of them fed by a single `getStudentLanding` call — eight
 * independent panels is exactly the shape that produces eight sequential
 * queries by accident, so the page holds no `await` of its own beyond that one.
 *
 * Nothing here re-derives anything. The badge wall and the five suggestions are
 * the same components `/student/skilling` renders, from the same board; the
 * stage rail and dimension meters are the same `progress.ts` figures every
 * other screen quotes. A landing page that computed its own version of a number
 * shown elsewhere would be the fastest way to make the whole product look
 * unreliable.
 *
 * Every tile is written for two students at once: one with three semesters of
 * marks, twelve SWOC entries and a 40-day streak, and a fresher who signed in
 * for the first time ninety seconds ago. The second is the harder case and the
 * one that gets skipped, so each panel below states what its empty state is —
 * a sentence about what will appear and how, never a blank box and never a
 * chart with no axis.
 */
export default async function StudentHomePage() {
  const { studentId } = await requireStudent();
  const data = await getStudentLanding(studentId);
  if (!data) notFound();

  const { home, attendance, marks, swoc, mocks, streak, streakRail, skills } = data;
  const { student, stages, dimensions, currentCourses, upcoming, openAlerts, overallPct } = home;
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
          <Grid size={{ xs: 6, md: 3 }}>
            <NeuStat
              label="Overall completion"
              value={`${overallPct.toFixed(0)}%`}
              progress={overallPct}
            />
          </Grid>
          <Grid size={{ xs: 6, md: 3 }}>
            <NeuStat
              label="Attendance"
              value={`${attendance.overallPct.toFixed(0)}%`}
              tone={attendance.overallPct >= ATTENDANCE_COMFORT_PCT ? 'good' : 'warning'}
              progress={attendance.overallPct}
              hint={
                attendance.sessions === 0
                  ? 'No sessions recorded yet'
                  : `${attendance.present} of ${attendance.sessions} sessions`
              }
            />
          </Grid>
          <Grid size={{ xs: 6, md: 3 }}>
            <NeuStat
              label={streak.current === 1 ? 'Day running' : 'Days running'}
              value={streak.current}
              hint={
                streak.longest > 0 ? `Your best is ${streak.longest}` : 'Your streak starts today'
              }
            />
          </Grid>
          <Grid size={{ xs: 6, md: 3 }}>
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

      {/* --- tile 1 · stage of REEP --------------------------------------- */}
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
        {/* --- tile 2 · attendance --------------------------------------- */}
        <Grid size={{ xs: 12, lg: 7 }}>
          <SectionCard
            title="Attendance"
            subtitle={
              attendance.sessions === 0
                ? 'Instructor-led sessions'
                : `${attendance.present} of ${attendance.sessions} instructor-led sessions attended · ${ATTENDANCE_COMFORT_PCT}% is the placement floor`
            }
          >
            {attendance.byCourse.length === 0 ? (
              <EmptyState
                title="No sessions recorded against you yet."
                hint="Attendance appears here as soon as your first instructor-led session is marked. Until then you are counted as fully present."
              />
            ) : (
              // Worst course first, on the shared ranked-bar chart the director
              // screens already use — a 100% course and a 60% course have to be
              // coloured by the same rule everywhere or the colour means
              // nothing.
              <RankedBarChart data={attendance.byCourse} scale="percentage" unit="%" />
            )}
          </SectionCard>
        </Grid>

        {/* --- tile 8 · login streak ------------------------------------- */}
        <Grid size={{ xs: 12, lg: 5 }}>
          <SectionCard title="Login streak" subtitle="Days you have signed in, back to back">
            <StreakTile streak={streak} rail={streakRail} />
          </SectionCard>
        </Grid>
      </Grid>

      {/* --- tile 3 · VTU marks ------------------------------------------ */}
      <SectionCard
        title="University marks"
        subtitle={
          marks.cgpa != null
            ? `SGPA by semester, and the subject breakdown for the latest one · CGPA ${marks.cgpa.toFixed(2)}`
            : 'SGPA by semester, and the subject breakdown for the latest one'
        }
        action={
          marks.latest?.resultClass ? (
            <Typography variant="caption" color="text.secondary">
              {marks.latest.resultClass}
            </Typography>
          ) : null
        }
      >
        <Grid container spacing={{ xs: 4, lg: 5 }}>
          <Grid size={{ xs: 12, lg: 6 }}>
            <SgpaChart data={marks.sgpaSeries} />
          </Grid>

          <Grid size={{ xs: 12, lg: 6 }}>
            {marks.latest == null ? (
              <EmptyState
                title="No semester on record yet."
                hint="Your subject marks appear here once the department uploads the internal assessment sheet for the semester you are sitting."
              />
            ) : (
              <Box>
                <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: '0.08em' }}>
                  Semester {marks.latest.semester}
                </Typography>
                <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 1.5 }}>
                  {marks.latest.published
                    ? `Published · SGPA ${marks.latest.sgpa?.toFixed(2)}${
                        marks.latest.backlogs > 0
                          ? ` · ${marks.latest.backlogs} backlog${marks.latest.backlogs === 1 ? '' : 's'}`
                          : ''
                      }`
                    : 'In progress — internals recorded, external paper not yet sat'}
                </Typography>
                <SubjectMarksChart data={marks.latest.subjects} />
                <SubjectMarksKey data={marks.latest.subjects} />
              </Box>
            )}
          </Grid>
        </Grid>
      </SectionCard>

      <Grid container spacing={{ xs: 0, lg: 5 }}>
        {/* --- tile 4 · SWOC -------------------------------------------- */}
        <Grid size={{ xs: 12, lg: 7 }}>
          <SectionCard
            title="How you are read"
            subtitle="SWOC from the placement cell, your mentor and the programme manager — kept separate on purpose"
          >
            {swoc.total === 0 ? (
              // The three desks are still named below, so a fresher learns who
              // writes about them before anyone has.
              <EmptyState
                title="Nothing recorded about you yet."
                hint="Three desks write here — the placement cell, your mentor and the programme manager. Their readings are never merged, so where they disagree you will see both."
              />
            ) : (
              <SwocChart data={swoc.bars} />
            )}
            <SwocHighlights highlights={swoc.highlights} />
          </SectionCard>
        </Grid>

        {/* --- tile 5 · mocks taken ------------------------------------- */}
        <Grid size={{ xs: 12, lg: 5 }}>
          <SectionCard
            title="Mocks taken"
            subtitle="Group discussions, interviews and aptitude tests sat with the placement cell"
          >
            {/* Rendered whatever the counts are: a nought against "Aptitude
                test" is the one number this tile exists to show. */}
            <MocksChart data={mocks.bars} />
            <MocksKey data={mocks.bars} />
          </SectionCard>
        </Grid>
      </Grid>

      <Grid container spacing={{ xs: 0, lg: 5 }}>
        {/* --- tile 6 · skills badges ----------------------------------- */}
        <Grid size={{ xs: 12, lg: 7 }}>
          <SectionCard
            title="Your skills"
            subtitle="Verified badges and claims still with your mentor"
            action={
              <Button href="/student/skilling" size="small">
                Claim a skill
              </Button>
            }
          >
            {skills == null ? (
              <EmptyState
                title="Your skill profile could not be loaded."
                hint="Open /student/skilling to see it in full. If it keeps happening, your mentor can check the roster."
              />
            ) : (
              <SkillBadges
                verified={skills.badges}
                claims={skills.openClaims}
                emptyHint="Upload the certificate for a course you have finished and your mentor will verify the skill behind it."
              />
            )}
          </SectionCard>
        </Grid>

        {/* --- tile 7 · top five skilling recommendations ---------------- */}
        <Grid size={{ xs: 12, lg: 5 }}>
          <SectionCard
            title="Learn this next"
            subtitle={
              skills == null || skills.openJobCount === 0
                ? 'Ranked against the postings on your jobs board'
                : `Ranked against ${skills.openJobCount} open posting${
                    skills.openJobCount === 1 ? '' : 's'
                  } for your cohort`
            }
          >
            <SkillRecommendations recommendations={skills?.recommendations ?? []} />
          </SectionCard>
        </Grid>
      </Grid>

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
        Every tile on this screen comes from one <code>getStudentLanding</code> call in{' '}
        <code>src/lib/landing/queries.ts</code> — eight panels is exactly the shape that turns
        into eight sequential queries by accident, so the whole page is a single{' '}
        <code>Promise.all</code> and the shaping happens in <code>landing/tiles.ts</code>, which
        imports neither Prisma nor <code>server-only</code> and is unit-tested. Stage % and the
        dimension meters are <code>src/lib/progress.ts</code>, so this page and{' '}
        <code>/student/courses</code> cannot disagree; the badges and the five suggestions are
        the same components and the same board as <code>/student/skilling</code>. The SWOC chart
        is grouped rather than stacked because the three desks are never merged — a taller bar
        would mean &ldquo;more agreement&rdquo; while reading as &ldquo;more strength&rdquo;. The
        streak is <code>src/lib/streak.ts</code> over <code>LoginDay</code> rows written by{' '}
        <code>authenticate()</code>, with no window cap: <code>consistency()</code> in{' '}
        <code>analytics.ts</code> measures study days over a fixed 30, which would tie every
        student who turned up all term. Sundays are stepped over rather than counted as misses.
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
