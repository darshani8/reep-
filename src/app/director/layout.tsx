import { AppShell } from '@/components/app-shell';
import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';

export default async function DirectorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireRole('DIRECTOR', 'ADMIN');

  const [cohorts, students] = await Promise.all([
    prisma.cohort.count(),
    prisma.student.count(),
  ]);

  return (
    <AppShell
      role="director"
      userName={session.name}
      userMeta={`${cohorts} cohorts · ${students} students`}
    >
      {children}
    </AppShell>
  );
}
