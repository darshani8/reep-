import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { EmptyState, PageIntro, SectionCard, StatCard, TechNote } from '@/components/kit';
import { requireStudent } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { relativeDay } from '@/lib/reep';
import { UPLOAD_KIND_LABEL, formatBytes, isImage } from '@/lib/uploads';

import { FileCard, type FileCardRow } from './file-card';
import { UploadPanel } from './upload-panel';

export const metadata = { title: 'Uploads — Student' };
export const dynamic = 'force-dynamic';

export default async function StudentUploadsPage() {
  const { studentId } = await requireStudent();

  const [uploads, certProgress] = await Promise.all([
    prisma.upload.findMany({
      where: { studentId },
      orderBy: { uploadedAt: 'desc' },
      include: { cert: { select: { name: true, courseCode: true } } },
    }),
    prisma.certificationProgress.findMany({
      where: { studentId },
      include: { cert: { select: { code: true, name: true, courseCode: true } } },
      orderBy: { cert: { courseCode: 'asc' } },
    }),
  ]);

  const certifications = certProgress.map((row) => ({
    code: row.cert.code,
    name: row.cert.name,
    courseCode: row.cert.courseCode,
  }));

  const rows: FileCardRow[] = uploads.map((upload) => ({
    id: upload.id,
    title: upload.title,
    kindLabel: UPLOAD_KIND_LABEL[upload.kind],
    status: upload.status,
    mimeType: upload.mimeType,
    sizeLabel: formatBytes(upload.sizeBytes),
    uploadedLabel: relativeDay(upload.uploadedAt),
    certName: upload.cert ? `${upload.cert.courseCode} — ${upload.cert.name}` : null,
    reviewNote: upload.reviewNote,
    isImage: isImage(upload.mimeType),
  }));

  const verified = rows.filter((r) => r.status === 'VERIFIED').length;
  const pending = rows.filter((r) => r.status === 'PENDING_REVIEW').length;
  const rejected = rows.filter((r) => r.status === 'REJECTED').length;

  // Certifications the student says are complete but has not evidenced yet.
  const completedWithoutProof = certProgress.filter(
    (row) =>
      row.status === 'COMPLETED' &&
      !uploads.some((u) => u.certCode === row.certCode && u.status !== 'REJECTED'),
  );

  return (
    <>
      <PageIntro
        title="Uploads"
        subtitle="Certificates, your CV, a photo, and any documents your mentor asks for."
      />

      <Grid container spacing={2.5} sx={{ mb: 5 }}>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard label="Files uploaded" value={rows.length} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard label="Verified" value={verified} tone="good" />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Awaiting mentor"
            value={pending}
            tone={pending > 0 ? 'warning' : 'neutral'}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Needs re-upload"
            value={rejected}
            tone={rejected > 0 ? 'critical' : 'neutral'}
          />
        </Grid>
      </Grid>

      <Grid container spacing={{ xs: 0, lg: 5 }}>
        <Grid size={{ xs: 12, lg: 5 }}>
          <SectionCard title="Add a file">
            <UploadPanel certifications={certifications} />
          </SectionCard>

          {completedWithoutProof.length > 0 && (
            <SectionCard
              title="Still missing a certificate"
              subtitle="You have marked these complete, but nothing is filed against them"
            >
              <Stack spacing={1}>
                {completedWithoutProof.map((row) => (
                  <Typography key={row.certCode} variant="body2">
                    {row.cert.courseCode} — {row.cert.name}
                  </Typography>
                ))}
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                Uploading the certificate lets your mentor mark the progress verified rather
                than self-reported.
              </Typography>
            </SectionCard>
          )}
        </Grid>

        <Grid size={{ xs: 12, lg: 7 }}>
          <SectionCard
            title="Your files"
            subtitle={rows.length === 1 ? '1 file' : `${rows.length} files`}
          >
            {rows.length === 0 ? (
              <EmptyState
                title="Nothing uploaded yet."
                hint="Start with the completion certificate for a course you have finished — that is the one your mentor needs most."
              />
            ) : (
              <Stack>
                {rows.map((row) => (
                  <FileCard key={row.id} row={row} />
                ))}
              </Stack>
            )}
          </SectionCard>
        </Grid>
      </Grid>

      <TechNote>
        Files are stored outside the web root and served only through{' '}
        <code>/api/uploads/[id]</code>, which re-checks ownership on every read — a student sees
        only their own files, a mentor only their mentees&apos;. Stored filenames are generated
        rather than taken from the upload, so a crafted filename cannot escape the storage
        directory. Verifying a certificate proof flips that certification&apos;s progress from
        self-reported to mentor-verified, which is the manual half of the provider-API sync.
      </TechNote>
    </>
  );
}
