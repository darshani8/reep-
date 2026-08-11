import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';

import { EmptyState, PageIntro, SectionCard, StatCard, StatusChip, TechNote } from '@/components/kit';
import { requireMentor } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { menteeWhere } from '@/lib/mentor-scope';
import { relativeDay } from '@/lib/reep';
import { UPLOAD_KIND_LABEL, formatBytes, isImage } from '@/lib/uploads';

import { ReviewCard, type ReviewRow } from './review-panel';

export const metadata = { title: 'Verifications — Mentor' };
export const dynamic = 'force-dynamic';

export default async function MentorUploadsPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const session = await requireMentor();
  const { state: rawState } = await searchParams;
  // Anything that is not "reviewed" is the queue, so a hand-edited query string
  // lands somewhere sensible rather than on an empty list.
  const state = rawState === 'reviewed' ? 'reviewed' : 'pending';

  // A director has no mentor group; show the whole programme rather than nothing.
  const scope = menteeWhere(session);

  const uploads = await prisma.upload.findMany({
    where: {
      student: scope,
      ...(state === 'pending' ? { status: 'PENDING_REVIEW' } : {}),
      ...(state === 'reviewed' ? { status: { in: ['VERIFIED', 'REJECTED'] } } : {}),
    },
    orderBy: { uploadedAt: 'desc' },
    include: {
      cert: { select: { name: true, courseCode: true } },
      student: { include: { user: { select: { name: true } } } },
    },
    take: 60,
  });

  const certProgress = await prisma.certificationProgress.findMany({
    where: {
      studentId: { in: [...new Set(uploads.map((u) => u.studentId))] },
      certCode: { in: uploads.map((u) => u.certCode).filter((c): c is string => c != null) },
    },
    select: { studentId: true, certCode: true, progressPct: true, selfReported: true },
  });

  const rows: ReviewRow[] = uploads.map((upload) => {
    const progress = certProgress.find(
      (p) => p.studentId === upload.studentId && p.certCode === upload.certCode,
    );
    return {
      id: upload.id,
      title: upload.title,
      studentName: upload.student.user.name,
      studentId: upload.studentId,
      certLabel: upload.cert ? `${upload.cert.courseCode} — ${upload.cert.name}` : null,
      kindLabel: UPLOAD_KIND_LABEL[upload.kind],
      uploadedLabel: relativeDay(upload.uploadedAt).toLowerCase(),
      sizeLabel: formatBytes(upload.sizeBytes),
      isImage: isImage(upload.mimeType),
      claimedProgressPct: progress?.progressPct ?? null,
      selfReported: progress?.selfReported ?? true,
    };
  });

  const [pendingCount, verifiedCount, rejectedCount] = await Promise.all([
    prisma.upload.count({ where: { student: scope, status: 'PENDING_REVIEW' } }),
    prisma.upload.count({ where: { student: scope, status: 'VERIFIED' } }),
    prisma.upload.count({ where: { student: scope, status: 'REJECTED' } }),
  ]);

  return (
    <>
      <PageIntro
        title="Verifications"
        subtitle="Certificate proofs and documents your mentees have uploaded."
      />

      <Grid container spacing={2.5} sx={{ mb: 5 }}>
        <Grid size={{ xs: 12, sm: 4 }}>
          <StatCard
            label="Awaiting your check"
            value={pendingCount}
            tone={pendingCount > 0 ? 'warning' : 'neutral'}
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 4 }}>
          {/* A running total, not a verdict — the colour would mean nothing. */}
          <StatCard label="Verified" value={verifiedCount} />
        </Grid>
        <Grid size={{ xs: 6, sm: 4 }}>
          <StatCard label="Rejected" value={rejectedCount} tone="neutral" />
        </Grid>
      </Grid>

      {/* Two views of the same list, so this is a tab bar rather than a pair of
          filled buttons competing with the Verify action below. */}
      <Tabs value={state} sx={{ mb: 3 }} className="no-print">
        <Tab value="pending" label="Awaiting check" href="/mentor/uploads?state=pending" />
        <Tab value="reviewed" label="Reviewed" href="/mentor/uploads?state=reviewed" />
      </Tabs>

      <SectionCard
        title={state === 'reviewed' ? 'Already reviewed' : 'Waiting on you'}
        subtitle={`${rows.length} file${rows.length === 1 ? '' : 's'}`}
      >
        {rows.length === 0 ? (
          <EmptyState
            title={
              state === 'reviewed'
                ? 'Nothing has been reviewed yet.'
                : 'Nothing waiting — the queue is clear.'
            }
            hint="Students upload certificates from their Uploads screen. They appear here for you to check against the platform-reported progress."
          />
        ) : state === 'reviewed' ? (
          <Stack>
            {uploads.map((upload) => (
              <Stack
                key={upload.id}
                direction={{ xs: 'column', sm: 'row' }}
                spacing={{ xs: 0.5, sm: 2 }}
                sx={{
                  py: 1.75,
                  borderTop: 1,
                  borderColor: 'divider',
                  alignItems: { sm: 'center' },
                  '&:first-of-type': { borderTop: 0, pt: 0 },
                }}
              >
                <Typography variant="body2" sx={{ width: { sm: 160 } }}>
                  {upload.student.user.name}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                  {upload.cert
                    ? `${upload.cert.courseCode} — ${upload.cert.name}`
                    : UPLOAD_KIND_LABEL[upload.kind]}
                </Typography>
                <StatusChip
                  tone={upload.status === 'VERIFIED' ? 'good' : 'critical'}
                  label={upload.status === 'VERIFIED' ? 'Verified' : 'Rejected'}
                />
                <Typography variant="caption" color="text.disabled" sx={{ width: { sm: 96 } }}>
                  {relativeDay(upload.reviewedAt ?? upload.uploadedAt)}
                </Typography>
              </Stack>
            ))}
          </Stack>
        ) : (
          <Stack>
            {rows.map((row) => (
              <ReviewCard key={row.id} row={row} />
            ))}
          </Stack>
        )}
      </SectionCard>

      <TechNote>
        This is the &ldquo;spot-checked by the mentor&rdquo; half of the certification-progress
        note in the wireframes: where the provider API cannot be reached, the student self-reports
        and uploads the certificate, and verifying it here flips that certification from
        self-reported to verified. A mentor can only see uploads belonging to their own mentees —
        the check lives in <code>src/lib/upload-access.ts</code> and runs on every file read.
      </TechNote>
    </>
  );
}
