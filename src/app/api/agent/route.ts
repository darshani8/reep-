import { NextResponse } from 'next/server';
import { z } from 'zod';

import { scopeNote, suggestions } from '@/lib/ai/agent/copy';
import { resolveScope } from '@/lib/ai/agent/scope';
import { ask, conversation } from '@/lib/ai/agent/store';
import { llmConfig } from '@/lib/ai/llm';
import { getSession } from '@/lib/auth';

/**
 * POST /api/agent — ask the assistant one question.
 *
 * Modelled on `/api/resume/generate`, and for the same reasons: a route handler
 * rather than a Server Action, because a Server Action cannot be cancelled and
 * a run here is several model calls on local hardware. The request's own signal
 * goes all the way down to the fetch that talks to Ollama, so closing the tab
 * frees the GPU and writes no row.
 *
 * There is no `role` or `studentId` in the body, and there never should be.
 * Scope is derived from the session cookie inside `ask()` — see `scope.ts`.
 */

export const dynamic = 'force-dynamic';

/**
 * GET /api/agent — what the floating panel needs to open.
 *
 * The launcher sits on every screen, so this must not run on every page render;
 * it is fetched once, the first time a reader actually opens the panel. Scope
 * and the copy describing it come from the server rather than the client, for
 * the same reason the page does it that way: the sentence promising a student
 * that nobody else's record is reachable should be produced by the thing that
 * enforces it.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Sign in to use the agent.' }, { status: 401 });
  }

  const scope = await resolveScope(session);
  if (!scope) {
    return NextResponse.json(
      { error: 'Your account has no student record, so there is nothing to read.' },
      { status: 403 },
    );
  }

  const rows = await conversation(session.userId, 20);
  const config = llmConfig();

  return NextResponse.json({
    scope: scope.kind,
    scopeNote: scopeNote(scope.kind),
    suggestions: suggestions(scope.kind),
    // Named so the panel can set expectations about the wait, and say plainly
    // when no model is configured rather than failing on the first question.
    model: config?.model ?? null,
    turns: rows.map((row) => ({
      id: row.id,
      question: row.question,
      answer: row.answer,
      status: row.status,
      citations: Array.isArray(row.citations) ? (row.citations as string[]) : [],
    })),
  });
}

const Body = z.object({
  question: z.string().trim().min(3).max(2_000),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Sign in to use the assistant.' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const parsed = Body.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'Ask a question of at least three characters.',
        issues: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  let answer: Awaited<ReturnType<typeof ask>>;
  try {
    answer = await ask({
      session,
      question: parsed.data.question,
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal.aborted) {
      // Nothing left to answer to. 499 is the conventional "client closed
      // request" and exists here for the operator log.
      return new NextResponse(null, { status: 499 });
    }
    throw error;
  }

  if (!answer) {
    return NextResponse.json(
      { error: 'Your account has no student record, so there is nothing to read.' },
      { status: 403 },
    );
  }

  return NextResponse.json(answer, { status: 200 });
}
