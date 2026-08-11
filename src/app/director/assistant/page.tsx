import { AssistantScreen } from '@/components/assistant-screen';
import { requireRole } from '@/lib/auth';

export const metadata = { title: 'REEP Agent — Director' };
export const dynamic = 'force-dynamic';

export default async function DirectorAssistantPage() {
  const session = await requireRole('DIRECTOR', 'ADMIN');
  return <AssistantScreen session={session} />;
}
