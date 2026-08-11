/**
 * Getting JSON out of whatever a model actually sent back.
 *
 * Separated from `llm.ts` for the same reason `activity-rules.ts` is separated
 * from `activity-log.ts`: this half touches no network, no environment and no
 * secrets, so it can be read and tested on its own — while `llm.ts` stays
 * `server-only` because it holds `LLM_API_KEY` and must never reach a client
 * bundle.
 *
 * Everything here exists because open-weights models are chattier than their
 * API contract suggests. A frontier model asked for JSON returns JSON; a 12B
 * model asked for JSON returns JSON about 90% of the time and, the rest of the
 * time, JSON wearing a hat.
 */

/**
 * Rough token estimate.
 *
 * Deliberately crude: the point is to catch "this prompt is twice the window",
 * not to predict billing. ~3.4 chars per token is a reasonable average for the
 * JSON-heavy English this prompt is made of, and erring low would defeat the
 * purpose, so the divisor is on the pessimistic side.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.4);
}

/**
 * Is this base URL a server on this machine?
 *
 * `LLM_BASE_URL` is just a string, and `.env.example` documents OpenRouter,
 * Groq and Gemini as perfectly good values for it. So "a model is configured"
 * and "the student's record stays here" are two different facts, and the code
 * has to be able to tell them apart before the UI promises either one.
 *
 * Fails closed: anything unparseable is treated as remote. A malformed URL is
 * not a reason to assume the safe case.
 */
export function isLoopbackHost(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return false;
  }

  // A bracketed IPv6 literal arrives from `hostname` already unwrapped, but a
  // hand-written value may not be.
  const host = url.hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // The unspecified address means "every interface on this machine", which is
  // what Ollama binds by default; as a destination it resolves back here.
  if (host === '0.0.0.0' || host === '::' || host === '::1') return true;
  if (host === '0:0:0:0:0:0:0:1') return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const octets = v4.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  // The whole 127.0.0.0/8 block, not just 127.0.0.1.
  return octets[0] === 127;
}

/**
 * Find and parse the JSON object in a model reply.
 *
 * Returns `undefined` rather than throwing when there is nothing to find, so
 * the caller can decide whether to retry with a different response format.
 *
 * The brace scan is not a regex because the payload contains prose with braces
 * in it — a lazy match stops at the first `}` inside a sentence, a greedy one
 * runs past the object's end into trailing commentary. Walking the string while
 * tracking string-literal state is the only version that survives a resume
 * bullet containing `{` or an escaped quote.
 */
export function extractJson(raw: string): unknown {
  const text = stripPreamble(raw);

  // The common case: the whole reply is the object.
  const direct = tryParse(text);
  if (direct !== undefined) return direct;

  const start = text.indexOf('{');
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return tryParse(text.slice(start, i + 1));
    }
  }

  // Unbalanced — the model was cut off mid-object, usually by a token limit.
  // Returning undefined is the point: half an object parsed leniently would be
  // a resume missing sections nobody was told about.
  return undefined;
}

function tryParse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/// Reasoning traces, chat-template markers and markdown fences — all of which
/// arrive uninvited from one model or another.
function stripPreamble(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();
}
