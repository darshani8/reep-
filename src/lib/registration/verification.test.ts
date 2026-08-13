import { describe, expect, it } from 'vitest';

import {
  VERIFICATION_TTL_MS,
  checkVerification,
  hashVerificationToken,
  mintVerificationToken,
  verificationHashesMatch,
  verificationLink,
  verificationOutcome,
} from './verification';

const NOW = new Date('2026-08-11T09:00:00.000Z');

describe('mintVerificationToken', () => {
  it('never returns the same token twice', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintVerificationToken(NOW).token));
    expect(seen.size).toBe(200);
  });

  it('returns a hash of the token, not the token', () => {
    const minted = mintVerificationToken(NOW);
    expect(minted.tokenHash).not.toBe(minted.token);
    expect(minted.tokenHash).toBe(hashVerificationToken(minted.token));
    expect(minted.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('expires 24 hours after it was made', () => {
    const minted = mintVerificationToken(NOW);
    expect(minted.expiresAt.getTime() - NOW.getTime()).toBe(VERIFICATION_TTL_MS);
  });

  it('is URL-safe, so a mail client cannot mangle it into a different token', () => {
    for (let i = 0; i < 50; i += 1) {
      const { token } = mintVerificationToken(NOW);
      expect(token).toBe(encodeURIComponent(token));
    }
  });
});

describe('checkVerification', () => {
  const fresh = { expiresAt: new Date(NOW.getTime() + 1000), consumedAt: null };

  it('accepts a live, unused row', () => {
    expect(checkVerification(fresh, NOW)).toEqual({ ok: true });
  });

  it('calls a missing row unknown rather than expired', () => {
    expect(checkVerification(null, NOW)).toEqual({ ok: false, failure: 'unknown' });
  });

  it('expires exactly at the boundary, not a millisecond later', () => {
    const row = { expiresAt: NOW, consumedAt: null };
    expect(checkVerification(row, NOW)).toEqual({ ok: false, failure: 'expired' });
  });

  it('calls a used-and-since-expired link used, because it worked', () => {
    const row = {
      expiresAt: new Date(NOW.getTime() - 1000),
      consumedAt: new Date(NOW.getTime() - 2000),
    };
    expect(checkVerification(row, NOW)).toEqual({ ok: false, failure: 'consumed' });
  });
});

describe('verificationOutcome', () => {
  it('routes an expired link to a human rather than to an error', () => {
    const outcome = verificationOutcome('expired');
    expect(outcome.routeToReview).toBe(true);
    expect(outcome.message).toMatch(/nothing further you need to do/i);
  });

  it('leaves a second click alone — the application is already where it belongs', () => {
    expect(verificationOutcome('consumed').routeToReview).toBe(false);
  });

  it('has nothing to route when the token matches no application', () => {
    expect(verificationOutcome('unknown').routeToReview).toBe(false);
  });
});

describe('verificationHashesMatch', () => {
  it('matches identical hashes and nothing else', () => {
    const a = hashVerificationToken('one');
    expect(verificationHashesMatch(a, a)).toBe(true);
    expect(verificationHashesMatch(a, hashVerificationToken('two'))).toBe(false);
    expect(verificationHashesMatch(a, a.slice(0, 10))).toBe(false);
  });
});

describe('verificationLink', () => {
  it('builds one absolute link whatever the base URL looks like', () => {
    expect(verificationLink('http://localhost:3100/', 'abc')).toBe(
      'http://localhost:3100/register/verify?token=abc',
    );
    expect(verificationLink('https://reep.bgscet.ac.in', 'a+b/c')).toBe(
      'https://reep.bgscet.ac.in/register/verify?token=a%2Bb%2Fc',
    );
  });
});
