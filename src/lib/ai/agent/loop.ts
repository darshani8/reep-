import 'server-only';

/**
 * The loop.
 *
 * Observe, decide, act, repeat — with three things bolted on that a textbook
 * agent leaves out, each of them forced by what this actually runs on:
 *
 * **A hard step budget.** A step is a call to a 12B model on a laptop GPU,
 * which is tens of seconds. Four steps is already a long wait; a loop that
 * "keeps going until it is confident" is not a feature here, it is a hang. When
 * the budget runs out the agent answers from what it gathered rather than
 * throwing, for the same reason the resume generator falls back to a
 * deterministic composer: a partial answer that says what is missing beats an
 * error page.
 *
 * **A trust boundary on every decision.** `adoptDecision` is to this what
 * `adoptModelOutput` is to the resume generator. A tool name the model invented
 * is not dispatched. Arguments that fail their schema are handed back as a
 * correction rather than crashing the run. Citations are filtered against the
 * fact ids the tools actually returned, so an answer cannot cite a record that
 * was never read.
 *
 * **A refusal that ends the run.** When a tool denies an out-of-scope lookup,
 * the loop stops asking. Left to itself a model will try the same lookup
 * through a different tool, and while every one of those would also refuse, the
 * result is four wasted model calls and a transcript that reads like probing.
 */

import { completeJson, llmConfig, studentDataEgressAllowed } from '../llm';

import { adoptDecision } from './decide';
import { AGENT_SYSTEM, DECISION_SCHEMA, renderState, type PriorTurn } from './prompt';
import { findTool, toolsFor } from './tools';
import type { AgentScope } from './scope';
import type { AgentStep, AgentStatus } from './types';

/// Four calls at ~30-60s each is the most a reader will sit through. Most
/// questions resolve in two.
const MAX_STEPS = 4;
/// One tool, one chance to fix its own arguments. A model that gets it wrong
/// twice is not going to get it right on the third try, and each attempt costs
/// a full model call.
const MAX_ARG_RETRIES = 1;

export type AgentOutcome = {
  status: AgentStatus;
  answer: string;
  citations: string[];
  steps: AgentStep[];
  model: string | null;
  durationMs: number;
};

export async function runAgent({
  question,
  scope,
  history,
  signal,
}: {
  question: string;
  scope: AgentScope;
  history: PriorTurn[];
  signal?: AbortSignal;
}): Promise<AgentOutcome> {
  const config = llmConfig();
  const startedAt = Date.now();

  if (!config) {
    // Not an error the reader caused, and not one they can fix — say what is
    // actually wrong rather than "something went wrong".
    return {
      status: 'FAILED',
      answer:
        'The assistant is not configured on this server. An administrator needs to set LLM_BASE_URL and LLM_MODEL — see the AI Resume Builder section of the README.',
      citations: [],
      steps: [],
      model: null,
      durationMs: Date.now() - startedAt,
    };
  }

  // The same gate the resume writer passes through, and for the same reason: to
  // answer, this agent reads the student's own REEP records — marks, attendance,
  // the lot — through its tools and puts them in the prompt. If the configured
  // model runs off this machine, that record would be POSTed to a third party
  // (a hosted OpenAI-compatible endpoint such as Gemini or Groq). It refuses
  // unless an administrator has said so out loud, rather than leaking the record
  // the way the resume path did before Phase 0. A loopback model is always fine.
  if (!studentDataEgressAllowed(config)) {
    return {
      status: 'REFUSED',
      answer:
        `The assistant reads your REEP records to answer, and the model configured here (${config.baseUrl}) runs off this machine. ` +
        'To keep student data on the machine it will not be sent to a third-party model unless an administrator sets ' +
        'LLM_ALLOW_REMOTE_STUDENT_DATA=true. Point LLM_BASE_URL at a local model, or ask an administrator.',
      citations: [],
      steps: [],
      model: null,
      durationMs: Date.now() - startedAt,
    };
  }

  const tools = toolsFor(scope);
  const steps: AgentStep[] = [];
  /// Fact ids the tools have actually returned. Nothing outside this set may be
  /// cited, whatever the model claims.
  const known = new Set<string>();
  /// Calls already made, as `tool(args)`. A model that cannot answer sometimes
  /// re-reads the same record instead of admitting it — one live run spent
  /// all four of its steps calling student_record({}) over and over.
  const seen = new Set<string>();
  /**
   * Stop gathering and commit to an answer on the next turn.
   *
   * Set when the model repeats a call it has already made. Telling it so in an
   * observation was not enough — it read "you already have this", agreed, and
   * asked again. A model that repeats itself has finished gathering whether or
   * not it knows that, so the decision is taken away from it.
   */
  let forceAnswer = false;
  let argRetries = 0;

  for (let i = 0; i < MAX_STEPS; i += 1) {
    if (signal?.aborted) throw abortError();

    const finalTurn = forceAnswer || i === MAX_STEPS - 1;

    const { data } = await completeJson({
      config,
      system: AGENT_SYSTEM,
      user: renderState({
        question,
        scope,
        tools,
        steps,
        history,
        contextTokens: config.contextTokens,
        stepsLeft: finalTurn ? 1 : MAX_STEPS - i,
      }),
      schema: DECISION_SCHEMA as unknown as Record<string, unknown>,
      schemaName: 'agent_decision',
      signal,
    });

    // On the final turn nothing is dispatched, whatever it asks for. The prompt
    // already says "answer now"; without this the model spends the last step on
    // one more tool call and the run ends EXHAUSTED with a reply it had every
    // means to write.
    const decision = adoptDecision(data, finalTurn ? [] : tools.map((t) => t.name));

    if (decision.kind === 'answer') {
      const cited = decision.citations.filter((id) => known.has(id));
      // A small model routinely writes a properly grounded answer and then
      // leaves `citations` empty. Everything it could have drawn on is what the
      // tools returned this run, so those are shown rather than nothing —
      // still "cited means read", just attributed on the model's behalf.
      return done('ANSWERED', decision.answer, cited.length > 0 ? cited : [...known], known);
    }

    const tool = findTool(scope, decision.tool)!;
    const parsed = tool.args.safeParse(decision.args);

    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'args'}: ${issue.message}`)
        .join('; ');
      steps.push({ tool: tool.name, args: decision.args, error: `Invalid arguments — ${message}`, ms: 0 });

      argRetries += 1;
      if (argRetries > MAX_ARG_RETRIES) {
        return done(
          'EXHAUSTED',
          `The assistant could not work out how to look this up. Try asking more specifically — for example naming a USN.`,
          [],
          known,
        );
      }
      continue;
    }

    const signature = `${tool.name}(${JSON.stringify(parsed.data)})`;
    if (seen.has(signature)) {
      steps.push({
        tool: tool.name,
        args: parsed.data as Record<string, unknown>,
        factId: `${tool.name}#repeat`,
        digest:
          'You have already read this exact record — it is above. Answer now from what you ' +
          'have, or say what is missing.',
        ms: 0,
      });
      // Not just a wasted call: the next turn answers, tools or not.
      forceAnswer = true;
      continue;
    }
    seen.add(signature);

    const stepStart = Date.now();
    let result: Awaited<ReturnType<typeof tool.run>>;
    try {
      result = await tool.run(parsed.data, scope);
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      // One tool falling over is not the run falling over: the model can often
      // answer from what it already has, or reach for a different record.
      console.warn(`[agent] tool ${tool.name} failed:`, error);
      steps.push({
        tool: tool.name,
        args: parsed.data as Record<string, unknown>,
        error: error instanceof Error ? error.message : String(error),
        ms: Date.now() - stepStart,
      });
      continue;
    }

    steps.push({
      tool: tool.name,
      args: parsed.data as Record<string, unknown>,
      factId: result.factId,
      digest: result.digest,
      denied: result.denied,
      ms: Date.now() - stepStart,
    });

    if (result.denied) {
      // Stop here. The refusal is the answer, and letting the loop continue
      // just produces three more refusals and a transcript that looks like an
      // attempt to get around them.
      return done('REFUSED', result.digest, [], known);
    }

    known.add(result.factId);
  }

  // Budget spent. Ask for a closing answer over what was gathered rather than
  // returning nothing — but say plainly that it was cut short.
  return done(
    'EXHAUSTED',
    summarise(steps),
    [...known],
    known,
  );

  function done(
    status: AgentStatus,
    answer: string,
    citations: string[],
    knownIds: Set<string>,
  ): AgentOutcome {
    return {
      status,
      answer,
      // The last gate: an id the tools never produced does not reach the reader,
      // so "cited" always means "read". Deduplicated because a model that used
      // one record for three sentences lists it three times, and the reader
      // gets the same chip repeated.
      citations: [...new Set(citations.filter((id) => knownIds.has(id)))],
      steps,
      model: config!.model,
      durationMs: Date.now() - startedAt,
    };
  }
}

/// What to say when the step budget ran out before the model committed. Reads
/// back what was gathered rather than pretending to conclude from it.
function summarise(steps: AgentStep[]): string {
  const read = steps.filter((s) => s.digest && !s.denied);
  if (read.length === 0) {
    return 'The assistant could not gather anything to answer this. Try a narrower question — for example about one student, one course, or one cohort.';
  }
  return [
    'The assistant ran out of steps before finishing. Here is what it read:',
    '',
    ...read.map((s) => `${s.factId}\n${s.digest}`),
  ].join('\n');
}

function abortError(): Error {
  const error = new Error('The request was cancelled.');
  error.name = 'AbortError';
  return error;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === 'AbortError';
}
