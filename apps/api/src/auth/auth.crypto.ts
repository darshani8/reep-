/**
 * Password hashing, ported verbatim from src/lib/auth.ts.
 *
 * The stored format is `scrypt:<salt>:<derived>`. Verification MUST stay
 * byte-identical to the Next app's, because both read the same `User.passwordHash`
 * column in the same database — a different scheme here would reject every
 * seeded account. `timingSafeEqual` guards against a timing oracle exactly as
 * the original does.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, digest] = stored.split(':');
  if (scheme !== 'scrypt' || !salt || !digest) return false;
  const derived = scryptSync(password, salt, 64);
  const expected = Buffer.from(digest, 'hex');
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
