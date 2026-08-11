import { notFound } from 'next/navigation';

import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { Fact, MeterRow, PageIntro, SectionCard, TechNote } from '@/components/kit';
import { requireStudent } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { STAGE_LABEL, formatHours } from '@/lib/reep';

import { LIST_FIELDS, serializeList, type ListField } from './json-lists';
import { ProfileForm } from './profile-form';
import { WeeklyTargetForm } from './weekly-target-form';

export const metadata = { title: 'Profile — Student' };
export const dynamic = 'force-dynamic';

export default async function StudentProfilePage() {
  const { studentId } = await requireStudent();

  // The one screen that reads Prisma directly: it edits its own two rows rather
  // than rolling anything up, so a queries.ts helper would earn nothing.
  const [student, profile, photos] = await Promise.all([
    prisma.student.findUnique({
      where: { id: studentId },
      include: { user: true, cohort: true, mentor: { include: { user: true } } },
    }),
    prisma.studentProfile.findUnique({ where: { studentId } }),
    prisma.upload.findMany({
      where: { studentId, kind: 'PROFILE_PHOTO', status: { not: 'REJECTED' } },
      orderBy: { uploadedAt: 'desc' },
      take: 10,
    }),
  ]);
  if (!student) notFound();

  // A mentor-verified photo wins; otherwise show the newest one still waiting
  // for review, so a student sees the picture they just uploaded.
  const photo = photos.find((row) => row.status === 'VERIFIED') ?? photos[0] ?? null;
  const photoNote = !photo
    ? 'No photo yet. A clear head-and-shoulders picture goes on your resume header.'
    : photo.status === 'VERIFIED'
      ? 'Checked by your mentor.'
      : 'Uploaded — your mentor has not looked at it yet.';

  const initials = student.user.name
    .split(' ')
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const lists = Object.fromEntries(
    LIST_FIELDS.map((field) => [field, serializeList(field, profile?.[field])]),
  ) as Record<ListField, string>;

  // `wide` is for the values that have no spaces to wrap on — an email or a
  // cohort name squeezed into half a column just overflows it.
  const account: { label: string; value: React.ReactNode; wide?: boolean }[] = [
    { label: 'Name', value: student.user.name },
    { label: 'USN', value: student.usn },
    { label: 'Institute email', value: student.user.email, wide: true },
    {
      label: 'Cohort',
      value: `${student.cohort.name} · ${student.cohort.code}`,
      wide: true,
    },
    { label: 'Stage', value: STAGE_LABEL[student.currentStage] },
    { label: 'Semester', value: student.currentSemester },
    { label: 'Faculty mentor', value: student.mentor?.user.name ?? 'Not assigned yet', wide: true },
  ];

  // What the resume generator still has nothing to say about.
  const readiness = [
    { label: 'Phone', done: Boolean(profile?.phone) },
    { label: 'Contact email', done: Boolean(profile?.email) },
    { label: 'City', done: Boolean(profile?.city) },
    {
      label: 'A link',
      done: Boolean(profile?.linkedinUrl || profile?.githubUrl || profile?.portfolioUrl),
    },
    { label: 'Career summary', done: Boolean(profile?.careerSummary) },
    { label: 'Education', done: lists.education.length > 0 },
    { label: 'Work experience', done: lists.experience.length > 0 },
    { label: 'Projects', done: lists.projects.length > 0 },
    { label: 'Skills', done: lists.skills.length > 0 },
    { label: 'Achievements', done: lists.achievements.length > 0 },
  ];
  const filled = readiness.filter((item) => item.done).length;
  const readinessPct = (filled / readiness.length) * 100;
  const missing = readiness.filter((item) => !item.done);

  return (
    <>
      <PageIntro
        title="Your profile"
        subtitle="Your REEP account details, and everything the resume builder needs you to tell it."
      />

      <Grid container spacing={{ xs: 0, lg: 5 }}>
        <Grid size={{ xs: 12, lg: 5 }}>
          <SectionCard
            title="Your account"
            subtitle="Held by the programme office — ask them to change anything here"
          >
            <Stack direction="row" spacing={2.5} sx={{ alignItems: 'center', mb: 3.5 }}>
              <Avatar
                src={photo ? `/api/uploads/${photo.id}` : undefined}
                alt={student.user.name}
                sx={{
                  width: 88,
                  height: 88,
                  flexShrink: 0,
                  bgcolor: 'action.hover',
                  color: 'text.secondary',
                  fontSize: '1.5rem',
                  fontWeight: 500,
                }}
              >
                {initials}
              </Avatar>

              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" color="text.secondary">
                  {photoNote}
                </Typography>
                <Button href="/student/uploads" size="small" sx={{ mt: 1, ml: -1.25 }}>
                  {photo ? 'Change photo' : 'Add a photo'}
                </Button>
              </Box>
            </Stack>

            <Grid container spacing={2.5}>
              {account.map((row) => (
                <Grid key={row.label} size={{ xs: 12, sm: row.wide ? 12 : 6 }}>
                  <Fact label={row.label} value={row.value} />
                </Grid>
              ))}
            </Grid>
          </SectionCard>
        </Grid>

        <Grid size={{ xs: 12, lg: 7 }}>
          <SectionCard
            title="Resume readiness"
            subtitle="How much of this page the resume builder can draw on"
            action={
              <Button href="/student/resume" size="small">
                Resume Builder
              </Button>
            }
          >
            <MeterRow
              label="Filled in"
              value={readinessPct}
              tone={readinessPct >= 70 ? 'good' : 'warning'}
              labelWidth={72}
            />

            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              {missing.length === 0
                ? `All ${readiness.length} sections are filled in. The builder has everything it can use.`
                : `${filled} of ${readiness.length} sections filled in. Still empty: ${missing
                    .map((item) => item.label)
                    .join(', ')}. The builder leaves those out rather than inventing them.`}
            </Typography>
          </SectionCard>

          <SectionCard
            title="Weekly study target"
            subtitle="The target line on your Time Log charts"
          >
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
              You are aiming at {formatHours(student.weeklyHourTarget)} a week right now. Your
              mentor sees the same number, so agree it with them before moving it far.
            </Typography>

            <WeeklyTargetForm current={student.weeklyHourTarget} />
          </SectionCard>
        </Grid>
      </Grid>

      <SectionCard
        title="Details for your resume"
        subtitle="Everything the REEP database cannot know about you"
      >
        <Typography variant="body2" color="text.secondary" sx={{ mb: 4, maxWidth: '72ch' }}>
          The resume builder writes from two places: your REEP record — stages, courses,
          certifications, attendance, logged hours — and this form. It invents nothing for
          either. Whatever you leave blank here simply will not appear on the resume.
        </Typography>

        <ProfileForm
          defaults={{
            phone: profile?.phone ?? '',
            email: profile?.email ?? student.user.email,
            linkedinUrl: profile?.linkedinUrl ?? '',
            githubUrl: profile?.githubUrl ?? '',
            portfolioUrl: profile?.portfolioUrl ?? '',
            city: profile?.city ?? '',
            careerSummary: profile?.careerSummary ?? '',
            lists,
          }}
        />
      </SectionCard>

      <TechNote>
        Account details are read-only here because enrolment owns them, not the student — a USN
        or mentor change has to travel through the programme office. Everything else writes
        through the two Server Actions in <code>src/app/student/profile/actions.ts</code>, which
        re-check the session before touching the database: a Server Action is a POST endpoint
        anyone can call, so the page guard alone is not a guard. <code>StudentProfile</code> is
        upserted, so a student whose row was never seeded gets one on first save. The five list
        fields are <code>Json</code> columns edited as one-entry-per-line pipe-separated text —
        the resume schema is still settling, and a text box is a far cheaper thing to re-shape
        than a nested repeater UI. The weekly target is rejected outside 1–60 hours rather than
        silently clamped, because zero would divide by zero in the Time Log&apos;s pace maths.
        The photo is whichever <code>PROFILE_PHOTO</code> upload the mentor has verified, falling
        back to the newest one still awaiting review; its bytes are served through{' '}
        <code>/api/uploads/[id]</code>, which re-checks ownership on every read. Uploading is
        owned by the Uploads screen, so there is only one uploader in the product.
      </TechNote>
    </>
  );
}
