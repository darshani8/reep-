import { AssistantScreen } from '@/components/assistant-screen';
import { requireStudent } from '@/lib/auth';

export const metadata = { title: 'REEP Agent — Student' };
/// Every reply is written to agent_runs, and the transcript above it is read
/// back on load — neither survives caching.
export const dynamic = 'force-dynamic';

export default async function StudentAssistantPage() {
  const { session } = await requireStudent();
  return <AssistantScreen session={session} />;
}
