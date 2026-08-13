/**
 * The single-use link that turns a typed address into a proven one.
 *
 * Everything auto-approval rests on rests on this. `rules.ts` will happily match
 * `someone@bgscet.ac.in` against the college domain rule and hand back
 * AUTO_APPROVED — which provisions a STUDENT account, and a STUDENT account
 * reads the leaderboards and the roster. The only thing standing between that
 * and anyone who can spell a college address is the fact that the link arrived
 * in the mailbox and came back. So the order is fixed: verify, *then* decide.
 *
 * Three properties, each a deliberate choice:
 *
 *  - **Only the hash is stored.** `EmailVerification.tokenHash` is unique and the
 *    plaintext exists in one email and nowhere else. A dump of that table
 *    confirms nobody's address. SHA-256 with no salt is right here and would be
 *    wrong for a password: the input is 32 bytes of CSPRNG output, so there is no
 *    dictionary to build and a per-row salt would only cost the unique index that
 *    makes the lookup a single indexed read.
 *  - **Single use.** `consumedAt` is set rather than the row deleted, so a second
 *    click on the same link is distinguishable from an expired one and gets the
 *    right sentence instead of "invalid link".
 *  - **24 hours.** Long enough for someone who registers at midnight and reads
 *    their mail after class; short enough that a link left in a shared inbox
 *    stops working within a day.
 *
 * `node:crypto` only — no `server-only`, no database, no clock of its own. The
 * caller passes `now`, the way `activity-rules.ts` does, so expiry can be tested
 * at the boundary rather than approximately.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/// 24 hours, in milliseconds. Stated once; the mail that quotes the deadline and
/// the check that enforces it both read this.
export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export type MintedVerification = {
  /**
   * The plaintext, for the link. This is the *only* moment it exists — it is
   * never returned by a query, never logged, and never rendered on a page the
   * applicant did not arrive at by following it.
   */
  token: string;
  /// What goes in `EmailVerification.tokenHash`.
  tokenHash: string;
  expiresAt: Date;
};

/**
 * A fresh token.
 *
 * 32 bytes, base64url — 256 bits, URL-safe, and no padding to be mangled by a
 * mail client that decides to wrap the line. `randomUUID` would have been 122
 * bits of entropy in a shape people recognise as guessable-adjacent; this is
 * neither.
 */
export function mintVerificationToken(now: Date): MintedVerification {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashVerificationToken(token),
    expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
  };
}

export function hashVerificationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison of two hashes.
 *
 * The lookup is by unique index, so this is belt and braces rather than the
 * primary defence — but a route that compares hashes with `===` after finding a
 * row by some other key is a timing oracle waiting for its first caller, and
 * having the safe comparison here means the unsafe one never has to be written.
 */
export function verificationHashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/// Why a link did not work. Each maps to a different sentence, and none of them
/// maps to an error page — see `verificationOutcome`.
export type VerificationFailure = 'unknown' | 'expired' | 'consumed';

export type VerificationCheck =
  | { ok: true }
  | { ok: false; failure: VerificationFailure };

/// The stored row, as much of it as the check needs.
export type StoredVerification = {
  expiresAt: Date;
  consumedAt: Date | null;
};

/**
 * Is this row still usable?
 *
 * Consumed is checked before expired on purpose: a link that was used and has
 * since aged out is *used*, and telling someone their link expired when it
 * actually worked sends them to the programme office for nothing.
 */
export function checkVerification(
  row: StoredVerification | null,
  now: Date,
): VerificationCheck {
  if (!row) return { ok: false, failure: 'unknown' };
  if (row.consumedAt !== null) return { ok: false, failure: 'consumed' };
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, failure: 'expired' };
  return { ok: true };
}

/**
 * What a failed link should *do*, which is never "show an error".
 *
 * An applicant who clicks a stale link has done nothing wrong, and the failure
 * mode of an error page here is that a real admission sits unread because the
 * person who filed it assumed the system had lost it. So a failure that we can
 * attribute to a known application routes it to the programme office — a human
 * confirms the address by other means — and only a token matching no row at all
 * has nothing to route, because there is nothing to attach it to.
 */
export function verificationOutcome(failure: VerificationFailure): {
  routeToReview: boolean;
  reason: string;
  message: string;
} {
  switch (failure) {
    case 'expired':
      return {
        routeToReview: true,
        reason: 'Email confirmation link expired before it was used.',
        message:
          'That link had passed its 24-hour deadline, so we could not confirm the address automatically. Your application has been passed to the programme office, who will confirm it with you directly — there is nothing further you need to do.',
      };
    case 'consumed':
      return {
        routeToReview: false,
        reason: 'Email confirmation link used a second time.',
        message:
          'That address is already confirmed — this link had been used once already, and each one works only once. Your application is with the programme office.',
      };
    case 'unknown':
      return {
        routeToReview: false,
        reason: 'Email confirmation link did not match any application.',
        message:
          'We could not match that link to an application. It may have been truncated by your mail client — try copying the whole address from the email. If it still does not work, register again and we will send a fresh link.',
      };
  }
}

/**
 * The link that goes in the email.
 *
 * Built from a base URL the caller supplies rather than from `process.env` here,
 * so this module stays free of ambient configuration and a test can assert on the
 * exact string an applicant will click.
 */
export function verificationLink(baseUrl: string, token: string): string {
  const root = baseUrl.replace(/\/+$/, '');
  return `${root}/register/verify?token=${encodeURIComponent(token)}`;
}
