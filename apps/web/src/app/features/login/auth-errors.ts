/**
 * One place to turn a refused password-path request into a sentence.
 *
 * The password endpoints answer JSON (`{detail}`), never a `?error=` redirect —
 * that vocabulary belongs to the Google callback and `messageFor` in
 * login.component.ts. FastAPI puts the human-readable message on `detail` and
 * it ALWAYS wins here; the per-status fallbacks below exist only for a proxy
 * that answered without a body. A 429 carries `Retry-After`, which is the one
 * number worth showing: "try again" with no time is a button people hammer.
 */

import type { HttpErrorResponse } from '@angular/common/http';

const NETWORK = 'Could not reach the sign-in service.';

function fallbackFor(status: number): string {
  switch (status) {
    case 400:
      return 'That code is not valid or has expired. Request a new one.';
    case 401:
      return 'Invalid email or password.';
    case 403:
      return 'That request is not allowed from this sign-in.';
    case 422:
      return 'Please check the form — some details are not valid.';
    case 429:
      return 'Too many attempts. Wait a few minutes and try again.';
    case 503:
      return 'Email & password sign-in is not available on this server right now.';
    default:
      return NETWORK;
  }
}

function withRetryAfter(text: string, status: number, retryAfter: string | null): string {
  const seconds = Number(retryAfter);
  if (status !== 429 || !Number.isFinite(seconds) || seconds <= 0) return text;
  return `${text} Try again in ${Math.ceil(seconds)} s.`;
}

/** For a `fetch` Response. Reads `detail` from the body when there is one. */
export async function detailOf(res: Response): Promise<string> {
  let text: string | null = null;
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body?.detail === 'string') text = body.detail;
  } catch {
    /* no JSON body — fall through to the status-based message */
  }
  return withRetryAfter(
    text ?? fallbackFor(res.status),
    res.status,
    res.headers.get('Retry-After'),
  );
}

/** The same, for an HttpClient failure (AuthService.login / setPassword). */
export function detailOfHttpError(err: HttpErrorResponse): string {
  if (err.status === 0) return NETWORK;
  const body = err.error as { detail?: unknown } | null;
  const text = typeof body?.detail === 'string' ? body.detail : fallbackFor(err.status);
  return withRetryAfter(text, err.status, err.headers?.get('Retry-After') ?? null);
}
