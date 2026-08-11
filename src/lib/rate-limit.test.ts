import { describe, expect, it } from 'vitest';

import { createRateLimiter, retryAfterSeconds } from './rate-limit';

/**
 * The rule these tests exist for: registration is about to become the first
 * endpoint a stranger may write through, so the ceiling has to hold exactly —
 * the limit-th call allowed, the one after refused, and the window reopening
 * when it said it would and not before.
 *
 * `now` is passed in everywhere rather than faked with timers, which is the
 * whole reason the module takes it: these tests step time by exact
 * milliseconds and never wait for any.
 */

const MINUTE = 60_000;

function limiter(limit = 3, windowMs = MINUTE) {
  return createRateLimiter({ limit, windowMs });
}

describe('createRateLimiter', () => {
  it('allows exactly up to the limit and counts down remaining', () => {
    const rl = limiter(3);

    expect(rl.check('ip:1.2.3.4', 0)).toEqual({
      allowed: true,
      limit: 3,
      remaining: 2,
      resetAt: MINUTE,
    });
    expect(rl.check('ip:1.2.3.4', 10)).toMatchObject({ allowed: true, remaining: 1 });
    // The limit-th call is allowed. Off-by-one here is the difference between
    // a documented "3 per minute" and an actual 2.
    expect(rl.check('ip:1.2.3.4', 20)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('refuses the call after the limit', () => {
    const rl = limiter(3);
    for (const t of [0, 10, 20]) rl.check('ip:1.2.3.4', t);

    expect(rl.check('ip:1.2.3.4', 30)).toEqual({
      allowed: false,
      limit: 3,
      remaining: 0,
      resetAt: MINUTE,
    });
  });

  it('does not let refused calls push the window further out', () => {
    const rl = limiter(1);
    rl.check('ip:1.2.3.4', 0);

    // A flood of refusals must not extend the block: the window ends when it
    // was always going to end, or a caller hammering the endpoint would lock
    // themselves out indefinitely and Retry-After would be a lie.
    for (let t = 1; t < 5_000; t += 500) {
      expect(rl.check('ip:1.2.3.4', t)).toMatchObject({ allowed: false, resetAt: MINUTE });
    }
    expect(rl.check('ip:1.2.3.4', MINUTE)).toMatchObject({ allowed: true, resetAt: 2 * MINUTE });
  });

  it('opens a new window once the old one ends', () => {
    const rl = limiter(2);
    rl.check('ip:1.2.3.4', 0);
    rl.check('ip:1.2.3.4', 1);
    expect(rl.check('ip:1.2.3.4', 2)).toMatchObject({ allowed: false });

    // One millisecond before the reset is still the old window.
    expect(rl.check('ip:1.2.3.4', MINUTE - 1)).toMatchObject({ allowed: false });

    // `resetAt` is exclusive: a call at exactly that instant is the first of a
    // fresh window, with the full allowance back.
    expect(rl.check('ip:1.2.3.4', MINUTE)).toEqual({
      allowed: true,
      limit: 2,
      remaining: 1,
      resetAt: 2 * MINUTE,
    });
  });

  it('anchors a new window on the first call in it, not on the old boundary', () => {
    const rl = limiter(1);
    rl.check('ip:1.2.3.4', 0);

    // Silent for an hour, then one call: the window runs a minute from *that*
    // call, not from some grid the caller cannot see.
    expect(rl.check('ip:1.2.3.4', 60 * MINUTE)).toMatchObject({
      allowed: true,
      resetAt: 61 * MINUTE,
    });
  });

  it('keeps separate keys entirely separate', () => {
    const rl = limiter(2);

    rl.check('ip:1.2.3.4', 0);
    rl.check('ip:1.2.3.4', 1);
    expect(rl.check('ip:1.2.3.4', 2)).toMatchObject({ allowed: false });

    // A second visitor is untouched by the first one's exhaustion.
    expect(rl.check('ip:5.6.7.8', 3)).toMatchObject({ allowed: true, remaining: 1 });
    expect(rl.check('token:abc', 3)).toMatchObject({ allowed: true, remaining: 1 });
    expect(rl.check('ip:5.6.7.8', 4)).toMatchObject({ allowed: true, remaining: 0 });
    expect(rl.check('ip:5.6.7.8', 5)).toMatchObject({ allowed: false });

    // ...and the first is still blocked, i.e. nothing was reset by the others.
    expect(rl.check('ip:1.2.3.4', 6)).toMatchObject({ allowed: false });
    expect(rl.check('token:abc', 6)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('reports resetAt as the first call in the window plus the window length', () => {
    const rl = limiter(3, 15_000);
    const first = rl.check('ip:1.2.3.4', 1_700_000_000_000);

    expect(first.resetAt).toBe(1_700_000_000_000 + 15_000);
    // Later calls inside the window report the same instant — the window does
    // not slide, so a caller can cache the value for its Retry-After.
    expect(rl.check('ip:1.2.3.4', 1_700_000_009_000).resetAt).toBe(first.resetAt);
    expect(rl.check('ip:1.2.3.4', 1_700_000_014_999).resetAt).toBe(first.resetAt);
  });
});

describe('evict', () => {
  it('drops ended windows and keeps live ones', () => {
    const rl = limiter(5);
    rl.check('ip:1.2.3.4', 0);
    rl.check('ip:5.6.7.8', 0);
    rl.check('ip:9.9.9.9', 30_000);
    expect(rl.size()).toBe(3);

    // Nothing has ended yet.
    expect(rl.evict(30_000)).toBe(0);
    expect(rl.size()).toBe(3);

    // The two windows opened at 0 have; the one opened at 30s has not.
    expect(rl.evict(MINUTE)).toBe(2);
    expect(rl.size()).toBe(1);

    expect(rl.evict(90_000)).toBe(1);
    expect(rl.size()).toBe(0);
  });

  it('does not hand back allowance to a key whose window is still open', () => {
    const rl = limiter(1);
    rl.check('ip:1.2.3.4', 0);
    rl.evict(100);

    expect(rl.check('ip:1.2.3.4', 200)).toMatchObject({ allowed: false, resetAt: MINUTE });
  });

  it('sweeps by itself so a long-running process cannot grow without bound', () => {
    const rl = limiter(1);

    // One entry per distinct caller is exactly the growth an abusive client is
    // in a position to cause, and no request path will remember to call evict.
    for (let i = 0; i < 500; i += 1) rl.check(`ip:10.0.0.${i}`, 0);
    expect(rl.size()).toBe(500);

    // A single call in a later window clears every window that has ended.
    rl.check('ip:1.2.3.4', 5 * MINUTE);
    expect(rl.size()).toBe(1);
  });
});

describe('retryAfterSeconds', () => {
  it('rounds up so a sub-second wait never becomes an immediate retry', () => {
    // Rounding down gives 0, which clients read as "try now" — and that retry
    // is refused again, which is the loop the header exists to prevent.
    expect(retryAfterSeconds({ resetAt: 400 }, 0)).toBe(1);
    expect(retryAfterSeconds({ resetAt: 1_000 }, 0)).toBe(1);
    expect(retryAfterSeconds({ resetAt: 1_001 }, 0)).toBe(2);
    expect(retryAfterSeconds({ resetAt: MINUTE }, 0)).toBe(60);
  });

  it('never returns zero or a negative for a window that has already ended', () => {
    expect(retryAfterSeconds({ resetAt: 0 }, 5_000)).toBe(1);
  });

  it('reads straight off a refusal', () => {
    const rl = limiter(1, 30_000);
    rl.check('ip:1.2.3.4', 0);
    const refused = rl.check('ip:1.2.3.4', 10_000);

    expect(refused.allowed).toBe(false);
    expect(retryAfterSeconds(refused, 10_000)).toBe(20);
  });
});

describe('config validation', () => {
  it('refuses a configuration that would silently disable or invert the limit', () => {
    // Loud at construction, where it is a boot failure, rather than a limiter
    // that refuses everything (indistinguishable from an outage) or one that
    // allows everything while looking configured.
    expect(() => createRateLimiter({ limit: 0, windowMs: MINUTE })).toThrow(RangeError);
    expect(() => createRateLimiter({ limit: -1, windowMs: MINUTE })).toThrow(RangeError);
    expect(() => createRateLimiter({ limit: 2.5, windowMs: MINUTE })).toThrow(RangeError);
    expect(() => createRateLimiter({ limit: 3, windowMs: 0 })).toThrow(RangeError);
    expect(() => createRateLimiter({ limit: 3, windowMs: -MINUTE })).toThrow(RangeError);
    expect(() => createRateLimiter({ limit: 3, windowMs: Number.NaN })).toThrow(RangeError);
  });

  it('accepts a limit of one', () => {
    expect(() => createRateLimiter({ limit: 1, windowMs: 1 })).not.toThrow();
  });
});
