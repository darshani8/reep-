import { AppShell } from '@/components/app-shell';
import { requireMentor } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { mentorScope } from '@/lib/mentor-scope';

export default async function MentorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireMentor();

  // Only a mentor with a real mentor group gets a group named in the sidebar.
  // Reading the id straight off the session would have named one for anybody
  // carrying the field, which is the distinction `mentorScope` exists to draw.
  const scope = mentorScope(session);
  const mentor =
    scope.kind === 'mentees'
      ? await prisma.mentor.findUnique({
          where: { id: scope.mentorId },
          select: { mentorGroup: true, _count: { select: { mentees: true } } },
        })
      : null;

  const meta = mentor
    ? `Mentor Group ${mentor.mentorGroup} · ${mentor._count.mentees} students`
    : 'Viewing as programme staff';

  return (
    <AppShell role="mentor" userName={session.name} userMeta={meta}>
      {children}
    </AppShell>
  );
}
