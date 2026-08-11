/**
 * The trust boundary, on its own.
 *
 * Split out of `loop.ts` for the same reason `llm-parse.ts` is split out of
 * `llm.ts`: this half touches no network, no database and no environment, so it
 * can be imported and asserted against directly by `scripts/test-agent.ts`.
 * `loop.ts` cannot — it is `server-only`, and importing it outside a server
 * component throws by design.
 *
 * That matters more here than it did for the resume parser, because this is the
 * function standing between a 12B model's improvisation and a tool call. The
 * checks it makes are cheap; being able to prove they hold is not.
 */

import type { Decision } from './types';

/**
 * Turn whatever came back into a decision, or an answer.
 *
 * Three properties, in the order they matter:
 *
 *  1. **A tool is dispatched only if the caller listed it.** `allowed` is the
 *     scope's own catalogue, so a student's run naming `find_students` — a tool
 *     it was never shown, but might guess at — falls through to the answer
 *     branch and is never called.
 *  2. **Unparseable is not fatal.** A model that put its reply in `reasoning`
 *     and left `tool` empty has, in practice, answered. Treating that as a
 *     crash would fail runs that were fine.
 *  3. **Citations are strings the model chose, and are filtered later.** This
 *     function only normalises them; `runAgent` drops any id the tools did not
 *     actually return. Both halves are needed — this one cannot know what was
 *     read, and that one cannot know what was claimed.
 */
export function adoptDecision(raw: unknown, allowed: string[]): Decision {
  const data = (typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw
    : {}) as Record<string, unknown>;

  const reasoning = text(data.reasoning);
  const answer = text(data.answer);
  const wanted = text(data.tool);

  if (wanted && allowed.includes(wanted)) {
    const args =
      typeof data.args === 'object' && data.args !== null && !Array.isArray(data.args)
        ? (data.args as Record<string, unknown>)
        : {};
    return { kind: 'call', reasoning, tool: wanted, args };
  }

  return {
    kind: 'answer',
    reasoning,
    answer:
      answer ||
      reasoning ||
      'The assistant did not produce an answer. Try rephrasing the question.',
    citations: Array.isArray(data.citations)
      ? data.citations.map(text).filter((s) => s.length > 0)
      : [],
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
