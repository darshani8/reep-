import Box from '@mui/material/Box';

import { AgentChat, type ChatTurn } from '@/components/agent-chat';
import { InfoBanner, PageIntro } from '@/components/kit';
import { scopeNote, suggestions } from '@/lib/ai/agent/copy';
import { resolveScope } from '@/lib/ai/agent/scope';
import { conversation } from '@/lib/ai/agent/store';
import { llmConfig } from '@/lib/ai/llm';
import type { SessionPayload } from '@/lib/auth';

/**
 * One screen, three routes.
 *
 * The student, mentor and director assistants are the same page — not similar
 * pages. What differs is resolved server-side from the session and shown to the
 * reader as the scope line, which is the honest way to present a tool whose
 * reach depends on who is holding it. Building three screens would have meant
 * three places for that line to drift out of step with what `scope.ts`
 * actually permits.
 */

export async function AssistantScreen({ session }: { session: SessionPayload }) {
  const scope = await resolveScope(session);
  const config = llmConfig();

  if (!scope) {
    return (
      <Box>
        <PageIntro title="REEP Agent" />
        <InfoBanner tone="warning" title="No record to read">
          This account has no student record attached, so there is nothing for the assistant to
          answer from.
        </InfoBanner>
      </Box>
    );
  }

  const rows = await conversation(session.userId, 20);
  const turns: ChatTurn[] = rows.map((row) => ({
    id: row.id,
    question: row.question,
    answer: row.answer,
    status: row.status,
    citations: Array.isArray(row.citations) ? (row.citations as string[]) : [],
    model: row.model,
    durationMs: row.durationMs,
  }));

  return (
    <Box>
      <PageIntro
        title="REEP Agent"
        subtitle="Answers built from REEP's own records, with the records it used shown under each reply."
      />

      {!config && (
        <InfoBanner tone="info" title="No model configured">
          Set <code>LLM_BASE_URL</code> and <code>LLM_MODEL</code> in <code>.env</code> and run{' '}
          <code>npm run ai:setup</code>. Until then the assistant will say so rather than guess.
        </InfoBanner>
      )}

      <AgentChat
        scopeNote={scopeNote(scope.kind)}
        suggestions={suggestions(scope.kind)}
        initialTurns={turns}
        modelHint={
          config ? `${config.model} · several records per answer, so give it a moment` : undefined
        }
      />
    </Box>
  );
}
