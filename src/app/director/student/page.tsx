import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

import { EmptyState, PageIntro, SectionCard, TechNote } from '@/components/kit';
import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { STAGE_LABEL } from '@/lib/reep';

export const metadata = { title: 'Student records — Director' };
export const dynamic = 'force-dynamic';

/**
 * The way in to a student's record.
 *
 * Deliberately not a dashboard — no meters, no risk flags, no ranking. Those
 * live on the analytics and placement screens; duplicating them here would
 * invite a director to make a judgement from a directory listing. This page
 * answers one question: which record do you want to open?
 */
export default async function DirectorStudentIndexPage() {
  await requireRole('DIRECTOR', 'ADMIN');

  const students = await prisma.student.findMany({
    include: {
      user: { select: { name: true } },
      cohort: { select: { code: true, batchLabel: true } },
      mentor: { include: { user: { select: { name: true } } } },
    },
    orderBy: [{ cohort: { code: 'asc' } }, { usn: 'asc' }],
  });

  return (
    <>
      <PageIntro
        title="Student records"
        subtitle="Open a student to see the full printable record — journey, courses, certifications, time, attendance, flags, notes and uploads on one page."
      />

      <SectionCard title={`${students.length} students`}>
        {students.length === 0 ? (
          <EmptyState title="No students have been enrolled yet." />
        ) : (
          <TableContainer>
            <Table size="small" sx={{ minWidth: 720 }}>
              <TableHead>
                <TableRow>
                  <TableCell>USN</TableCell>
                  <TableCell>Name</TableCell>
                  <TableCell>Cohort</TableCell>
                  <TableCell>Stage</TableCell>
                  <TableCell align="right">Semester</TableCell>
                  <TableCell>Faculty mentor</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {students.map((student) => (
                  <TableRow key={student.id}>
                    <TableCell className="tabular">{student.usn}</TableCell>
                    <TableCell>
                      {/*
                        The link fills its cell rather than hugging the name.
                        Inline, it was a 66x16 target — under the 24px minimum,
                        and this is the only route into a student record, so a
                        director on a laptop trackpad was aiming at a line of
                        text 16 pixels tall, forty-six times. The row is not
                        clickable, so nothing larger was catching the miss.
                      */}
                      <Link
                        href={`/director/student/${student.id}`}
                        sx={{ display: 'block', paddingBlock: 1, marginBlock: -1 }}
                      >
                        {student.user.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">{student.cohort.code}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {student.cohort.batchLabel}
                      </Typography>
                    </TableCell>
                    <TableCell>{STAGE_LABEL[student.currentStage]}</TableCell>
                    <TableCell align="right" className="tabular">
                      {student.currentSemester}
                    </TableCell>
                    <TableCell>
                      {student.mentor
                        ? `${student.mentor.title} ${student.mentor.user.name}`
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </SectionCard>

      <TechNote>
        The record page behind each name is a document rather than a screen: one long
        column, every section in a fixed order, and a print stylesheet that drops the
        navigation so a browser&apos;s &ldquo;Save as PDF&rdquo; produces something you can
        take into a review meeting. The same record is available as JSON from{' '}
        <code>/api/export/student/&lt;id&gt;</code>, behind the same director guard.
      </TechNote>
    </>
  );
}
