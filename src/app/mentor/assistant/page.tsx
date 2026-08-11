import { AssistantScreen } from '@/components/assistant-screen';
import { requireMentor } from '@/lib/auth';

export const metadata = { title: 'REEP Agent — Mentor' };
export const dynamic = 'force-dynamic';

export default async function MentorAssistantPage() {
  const session = await requireMentor();
  return <AssistantScreen session={session} />;
}
