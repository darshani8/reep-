/**
 * Session tokens, ported from src/lib/auth.ts.
 *
 * Same library (jose), same algorithm (HS256), same twelve-hour expiry, same
 * claims, verified with the same AUTH_SECRET. A token this file signs is
 * therefore the exact token the Next app signed — which is what lets the two
 * stacks share a cookie while the migration is in flight.
 */

import { SignJWT, jwtVerify } from 'jose';

import { SESSION_TTL_SECONDS, type SessionPayload } from './session.types';

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'AUTH_SECRET is missing or too short (need >= 32 chars). See apps/api/.env.',
    );
  }
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}
