import 'server-only';

/**
 * Running the assistant, and keeping the receipt.
 *
 * Sits between the route and the loop for the same reason `ai/store.ts` sits
 * between the route and the resume generator: scope resolution, conversation
 * history and the audit row belong to the feature, not to an HTTP handler.
 *
 * Conversation history is read from this table rather than accepted from the
 * client. A browser that could post its own "here is what you told me earlier"
 * could put words in the assistant's mouth — not to widen its data access,
 * which the tools enforce regardless, but to make it repeat a fabricated fact
 * as established. The server already has the real transcript; it uses that.
 */

import { Prisma } from '@prisma/client';

import type { SessionPayload } from '@/lib/auth';
import { prisma } from '@/lib/db';

import { runAgent } from './loop';
import { resolveScope } from './scope';
import type { AgentAnswer } from './types';
import type { PriorTurn } from './prompt';

/// How much of the conversation the model is shown. Three exchanges is enough
/// for "what about her attendance?" to resolve, and short enough to leave the
/// context budget to the records themselves.
const HISTORY_TURNS = 3;

export async function ask({
  session,
  question,
  signal,
}: {
  session: SessionPayload;
  question: string;
  signal?: AbortSignal;
}): Promise<AgentAnswer | null> {
  const scope = await resolveScope(session);
  // A student session with no student record. Failing closed rather than
  // falling back to a wider scope is the whole point of returning null here.
  if (!scope) return null;

  const history = await recentTurns(session.userId);

  const outcome = await runAgent({ question, scope, history, signal });

  // The reader can leave mid-run. Writing the row anyway would fill the audit
  // log with answers nobody received.
  if (signal?.aborted) {
    const error = new Error('The request was cancelled.');
    error.name = 'AbortError';
    throw error;
  }

  const run = await prisma.agentRun.create({
    data: {
      actorId: session.userId,
      role: session.role,
      // Stamped as it was at run time, and never rewritten. Rows from before
      // mentors were narrowed say `programme` for a MENTOR actor; that is the
      // truth about what that run could read, and correcting it would erase the
      // only evidence of the wider access. See ScopeKind in `types.ts`.
      scope: scope.kind,
      question,
      answer: outcome.answer,
      status: outcome.status,
      trace: outcome.steps as unknown as Prisma.InputJsonValue,
      citations: outcome.citations as unknown as Prisma.InputJsonValue,
      model: outcome.model,
      steps: outcome.steps.length,
      durationMs: outcome.durationMs,
    },
    select: { id: true },
  });

  return {
    id: run.id,
    status: outcome.status,
    answer: outcome.answer,
    citations: outcome.citations,
    toolsUsed: outcome.steps.map((s) => s.tool),
    scope: scope.kind,
    model: outcome.model,
    steps: outcome.steps.length,
    durationMs: outcome.durationMs,
  };
}

/// Only runs that actually answered. Feeding a refusal or a crash back as
/// context teaches the model to repeat it.
async function recentTurns(actorId: string): Promise<PriorTurn[]> {
  const rows = await prisma.agentRun.findMany({
    where: { actorId, status: 'ANSWERED' },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_TURNS,
    select: { question: true, answer: true },
  });
  return rows.reverse();
}

/// The transcript a chat screen renders on load.
export async function conversation(actorId: string, take = 20) {
  const rows = await prisma.agentRun.findMany({
    where: { actorId },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      question: true,
      answer: true,
      status: true,
      citations: true,
      model: true,
      steps: true,
      durationMs: true,
      createdAt: true,
    },
  });
  return rows.reverse();
}
