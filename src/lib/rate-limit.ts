/**
 * A fixed-window rate limiter, held in one process's memory.
 *
 * Every write this app has today sits behind the session cookie, so the cheapest
 * abuse control has always been "you need an account". Registration ends that:
 * it is the first endpoint a stranger may POST to, and an endpoint that creates
 * rows for anyone who asks needs a ceiling before it ships, not after someone
 * finds it.
 *
 * **This counts in one process and nowhere else.** `npm start` is
 * `next start -p 3100` — a single Node process on one machine — so the map below
 * is the whole truth and this is adequate today. Run two instances, or move to a
 * platform that quietly starts a second one under load, and each keeps its own
 * counters: the effective ceiling becomes `limit × instances` and *nothing*
 * fails, warns or logs. That is the boundary, and it is a silent one, which is
 * why it is written here rather than left to be discovered. Crossing it means
 * moving the counters to Postgres or Redis — not raising the limit. (`next dev`
 * re-evaluates modules on edit and so drops the counts; that is a development
 * convenience, not part of the design.)
 *
 * Nothing here reads the clock, the environment or the request. The caller
 * passes `now`, the way `activity-rules.ts` takes dates instead of calling
 * `new Date()`, so a test can step time exactly and the module keeps no ambient
 * state of its own. No `server-only`, so it is importable from a test or a
 * script.
 */

export type RateLimitConfig = {
  /// How many calls one key may make within a single window.
  limit: number;
  /// The length of a window in milliseconds.
  windowMs: number;
};

/// The verdict on one call. Everything a route needs for a 429 and for the
/// `X-RateLimit-*` / `Retry-After` headers, so it never has to guess at times
/// the limiter already knows.
export type RateLimitResult = {
  /// Whether the call may proceed. A refusal is *not* counted — see `check`.
  allowed: boolean;
  /// The configured ceiling, echoed back so a caller has it without the config.
  limit: number;
  /// Calls left in this window after this one. Zero on a refusal.
  remaining: number;
  /**
   * Epoch ms at which this key's window ends, exclusive: a call at exactly
   * `resetAt` starts a fresh window. On a refusal this is the moment the caller
   * may try again, which is what makes `retryAfterSeconds` honest rather than a
   * guessed constant.
   */
  resetAt: number;
};

export type RateLimiter = {
  /// Count one call against `key` and say whether it may proceed.
  check(key: string, now: number): RateLimitResult;
  /// Drop every window that has already ended. Returns how many were dropped.
  evict(now: number): number;
  /// How many keys are currently held. For tests and for a health line.
  size(): number;
};

type Window = {
  count: number;
  /// Epoch ms the window ends at, exclusive.
  resetAt: number;
};

/**
 * A limiter over an arbitrary key.
 *
 * The key is the caller's to compose — `ip:1.2.3.4`, `token:abc`,
 * `email:someone@bgscet.ac.in` — because only the caller knows which of those
 * it can actually trust behind its proxy. Prefixing is a convention worth
 * keeping: two limiters sharing a map would otherwise let an IP and an email
 * that happen to be the same string collide.
 *
 * A *fixed* window, deliberately. It admits a burst across a boundary — with
 * 5/minute a caller may spend 5 at 0:59 and 5 more at 1:01 — and that is
 * accepted, because the thing being stopped is sustained automated volume, and
 * a sliding log or token bucket costs more state and more explaining than this
 * endpoint is worth. If per-second smoothness ever matters, that is the point to
 * change the algorithm rather than the numbers.
 */
export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const { limit, windowMs } = config;

  // Loud at construction rather than quiet at request time. These are built at
  // module scope, so a bad config fails at boot where it is obvious; a `limit`
  // of 0 that merely refused everything would look exactly like an outage, and
  // a negative window would hand out an unlimited endpoint that reads as
  // configured.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`rate limit must be a positive integer, got ${limit}`);
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError(`rate limit window must be a positive number of ms, got ${windowMs}`);
  }

  const windows = new Map<string, Window>();

  /**
   * When the next amortised sweep is due; null until the first call, because
   * the module never reads the clock and so does not know "now" before then.
   */
  let nextSweepAt: number | null = null;

  function evict(now: number): number {
    let dropped = 0;
    for (const [key, window] of windows) {
      if (now >= window.resetAt) {
        windows.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  function check(key: string, now: number): RateLimitResult {
    // A key that is never seen again would otherwise sit in the map forever, and
    // one entry per distinct IP is exactly the sort of growth an abusive caller
    // is in a position to cause. `evict` stays public so a caller may sweep on
    // its own terms, but nothing in a request path will remember to, so the
    // sweep is also run here — at most once per window, so the O(n) pass is
    // paid rarely instead of on every request. A timer would do this more
    // evenly and would also be ambient state holding the process open.
    if (nextSweepAt === null || now >= nextSweepAt) {
      if (nextSweepAt !== null) evict(now);
      nextSweepAt = now + windowMs;
    }

    const existing = windows.get(key);
    const window: Window =
      existing && now < existing.resetAt ? existing : { count: 0, resetAt: now + windowMs };

    if (window.count >= limit) {
      // Refused calls are not counted. Counting them would push `resetAt` no
      // further (the window is fixed) but would let a flood overflow `count`
      // and, more to the point, would make `remaining` a lie the moment anyone
      // wanted to show it. The window ends when it was always going to end.
      windows.set(key, window);
      return { allowed: false, limit, remaining: 0, resetAt: window.resetAt };
    }

    window.count += 1;
    windows.set(key, window);
    return { allowed: true, limit, remaining: limit - window.count, resetAt: window.resetAt };
  }

  return { check, evict, size: () => windows.size };
}

/**
 * `Retry-After`, in whole seconds, from a result.
 *
 * The header takes seconds, so a 400 ms wait has to round *up* — rounding down
 * gives 0, which well-behaved clients read as "immediately" and so produces a
 * retry that is refused again. Never less than 1 for the same reason.
 */
export function retryAfterSeconds(result: Pick<RateLimitResult, 'resetAt'>, now: number): number {
  return Math.max(1, Math.ceil((result.resetAt - now) / 1000));
}
