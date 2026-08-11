import 'server-only';

/**
 * One adapter, any OpenAI-compatible model server.
 *
 * The resume generator originally had a single model path — Anthropic's SDK —
 * and a deterministic fallback. This is the third: a plain HTTP client for the
 * `/v1/chat/completions` shape that Ollama, llama.cpp, LM Studio, vLLM,
 * OpenRouter, Groq and Google's Gemini compatibility endpoint all speak. Point
 * `LLM_BASE_URL` at any of them and the same code runs.
 *
 * That portability is the easy half. The hard half is that an open-weights
 * model running on a laptop is a much less obedient correspondent than a
 * frontier API, and this module is mostly about that:
 *
 *  - **It may not honour a JSON schema.** Support for `response_format` varies
 *    by server *and* by model, so the request degrades through three rungs
 *    rather than assuming the top one works.
 *  - **It may not return only JSON.** Smaller models wrap output in ``` fences,
 *    open with "Here is the resume:", or — if they are a reasoning model —
 *    emit a `<think>` block first. The extractor below expects all of that.
 *  - **It may quietly run out of context.** Ollama defaults to a 4096-token
 *    window; this prompt is roughly twice that. A truncated pack is the worst
 *    failure mode this feature has, because the model then invents the part it
 *    could not see — so the prompt size is measured and refused if it cannot
 *    plausibly fit.
 *
 * What this module deliberately does *not* do is trust the result. It returns
 * parsed JSON and nothing more; `adoptModelOutput` in `resume.ts` remains the
 * single trust boundary, dropping any claim that does not cite a real record.
 *
 * The reply parsing itself lives in `llm-parse.ts`, which holds no secrets and
 * so can be tested directly. This file stays `server-only` because it reads
 * `LLM_API_KEY`.
 */

import { estimateTokens, extractJson, isLoopbackHost } from './llm-parse';

export { estimateTokens, extractJson, isLoopbackHost };

export type LlmConfig = {
  baseUrl: string;
  model: string;
  apiKey: string | null;
  timeoutMs: number;
  /// What we believe the server's context window is, for the fit check below.
  contextTokens: number;
};

/// Local runtimes need no key; hosted ones do. An empty value is normal, not a
/// misconfiguration, so it is not treated as one.
export function llmConfig(): LlmConfig | null {
  const baseUrl = process.env.LLM_BASE_URL?.trim();
  const model = process.env.LLM_MODEL?.trim();
  if (!baseUrl || !model) return null;

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKey: process.env.LLM_API_KEY?.trim() || null,
    timeoutMs: positive(process.env.LLM_TIMEOUT_MS, 300_000),
    contextTokens: positive(process.env.LLM_CONTEXT_TOKENS, 16_384),
  };
}

/// Where the configured server actually is. `LLM_BASE_URL` is a URL, not a
/// promise, so this is the only thing entitled to answer "is it local?".
export type LlmHost = 'local' | 'remote';

export function llmHost(config: LlmConfig): LlmHost {
  return isLoopbackHost(config.baseUrl) ? 'local' : 'remote';
}

/**
 * Every machine a student's record can be sent to, as one closed set.
 *
 * `'anthropic'` is not an `LlmHost` because it is configured by a different
 * variable — `ANTHROPIC_API_KEY`, with no URL anywhere — which is exactly how
 * it slipped the gate: the check took an `LlmConfig`, the Anthropic path never
 * built one, so `resume.ts` entered that branch on the key alone and POSTed the
 * brief to api.anthropic.com. Naming the destination rather than the config is
 * what makes the third path expressible, and therefore checkable.
 */
export type StudentDataDestination = LlmHost | 'anthropic';

/// The escape hatch, named so it cannot be set by accident.
export const REMOTE_STUDENT_DATA_ENV = 'LLM_ALLOW_REMOTE_STUDENT_DATA';

/**
 * May this destination be shown a prompt containing a student's record?
 *
 * A resume brief carries a name, a USN, marks and attendance. The project's
 * stated position — see the docblock in `resume.ts` and the warning in
 * `.env.example` — is that this stays on the machine, and until now that was a
 * comment rather than a rule. It is a rule here.
 *
 * A loopback server is always allowed. Anywhere else — a hosted
 * OpenAI-compatible endpoint or Anthropic, the difference being which variable
 * configured it and nothing else — requires an operator to have said so out
 * loud, because the alternative is a student being told their record never left
 * while it is being POSTed to somebody else's datacentre. Public data such as a
 * job posting does not go through this gate.
 *
 * It takes a config *or* a destination on purpose. Every caller that already
 * holds an `LlmConfig` can keep passing it, so there is no second function to
 * pick between and no way to reach a model without having called this one.
 */
export function studentDataEgressAllowed(
  target: LlmConfig | StudentDataDestination,
): boolean {
  const destination = typeof target === 'string' ? target : llmHost(target);
  if (destination === 'local') return true;
  return (process.env[REMOTE_STUDENT_DATA_ENV] ?? '').trim().toLowerCase() === 'true';
}

function positive(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw?.trim() ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

type ChatMessage = { role: 'system' | 'user'; content: string };

/// How the response format was requested, hardest constraint first. Each rung
/// down asks less of the server; the extractor picks up whatever is left.
type FormatMode = 'json_schema' | 'json_object' | 'prose';

const LADDER: FormatMode[] = ['json_schema', 'json_object', 'prose'];

export type LlmResult = {
  /// Parsed JSON — still untrusted; the caller re-validates every field.
  data: unknown;
  /// Which rung actually worked, for the operator log.
  mode: FormatMode;
  promptTokens: number;
};

export async function completeJson({
  config,
  system,
  user,
  schema,
  schemaName = 'response',
  signal,
}: {
  config: LlmConfig;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  schemaName?: string;
  /// The caller's cancellation — in practice a route handler's `request.signal`,
  /// so that a reader who navigates away actually stops the model instead of
  /// leaving it holding the GPU for a page that no longer exists.
  signal?: AbortSignal;
}): Promise<LlmResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const promptTokens = estimateTokens(system + user);
  // Leave room for the answer. A resume of this shape runs 1.5-3k tokens, so a
  // prompt past two-thirds of the window will be truncated at one end or the
  // other — and a silently truncated evidence pack produces a confidently
  // fabricated resume, which is precisely what this feature exists to prevent.
  const ceiling = Math.floor(config.contextTokens * 0.62);
  if (promptTokens > ceiling) {
    throw new Error(
      `Prompt is ~${promptTokens} tokens but the model's usable window is ~${ceiling} ` +
        `(context ${config.contextTokens}). Raise LLM_CONTEXT_TOKENS and the server's own ` +
        `context setting, or use a model with a larger window.`,
    );
  }

  let lastError: Error | null = null;

  for (const mode of LADDER) {
    // Check between rungs as well as inside the request: an abort that lands
    // while one attempt is unwinding must not start the next one.
    if (signal?.aborted) throw abortError();

    try {
      const text = await chat({ config, messages, schema, schemaName, mode, signal });
      const data = extractJson(text);
      if (data === undefined) {
        throw new Error(`No JSON object found in the reply (${text.length} chars)`);
      }
      return { data, mode, promptTokens };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // A timeout or a dead server will fail identically on every rung, so
      // there is nothing to be gained by walking down it.
      if (isFatal(lastError)) throw lastError;
    }
  }

  throw lastError ?? new Error('The model server returned nothing usable.');
}

function abortError(): Error {
  const error = new Error('The request was cancelled.');
  error.name = 'AbortError';
  return error;
}

function isFatal(error: Error): boolean {
  return (
    error.name === 'AbortError' ||
    /timed out|ECONNREFUSED|fetch failed|Unauthorized|401|403/i.test(error.message)
  );
}

async function chat({
  config,
  messages,
  schema,
  schemaName,
  mode,
  signal,
}: {
  config: LlmConfig;
  messages: ChatMessage[];
  schema: Record<string, unknown>;
  schemaName: string;
  mode: FormatMode;
  signal?: AbortSignal;
}): Promise<string> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    // Low but not zero. Zero makes small models loop on repetitive list items;
    // this is a factual document, so there is nothing to gain above it either.
    temperature: 0.2,
    stream: false,
  };

  if (mode === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: schemaName, strict: true, schema },
    };
  } else if (mode === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  // Two independent reasons to stop: our own deadline, and the caller giving
  // up. `AbortSignal.any` fires on whichever comes first while keeping them
  // distinguishable afterwards — the caller's abort is a cancellation, ours is
  // a timeout, and they deserve different messages.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), config.timeoutMs);
  const combined = signal
    ? AbortSignal.any([deadline.signal, signal])
    : deadline.signal;

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (deadline.signal.aborted) {
      throw new Error(`Model server timed out after ${config.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 400);
    throw new Error(`Model server returned ${response.status}: ${detail}`);
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  const text = payload.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) throw new Error('Model server returned an empty message');
  return text;
}

