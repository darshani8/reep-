import { AppShell } from '@/components/app-shell';
import { requireStudent } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { STAGE_LABEL } from '@/lib/reep';

export default async function StudentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { session, studentId } = await requireStudent();

  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: { usn: true, currentStage: true, currentSemester: true },
  });

  const meta = student
    ? `USN ${student.usn} · ${STAGE_LABEL[student.currentStage]} · Semester ${student.currentSemester}`
    : undefined;

  return (
    <AppShell role="student" userName={session.name} userMeta={meta}>
      {children}
    </AppShell>
  );
}
