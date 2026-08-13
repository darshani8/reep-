import 'server-only';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

import { prisma } from './db';
import { SESSION_COOKIE } from './session-shared';
import type { Role } from '@prisma/client';

export { SESSION_COOKIE };
const SESSION_TTL_SECONDS = 60 * 60 * 12;

export type SessionPayload = {
  userId: string;
  email: string;
  name: string;
  role: Role;
  /// Present for STUDENT, absent otherwise.
  studentId?: string;
  mentorId?: string;
};

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'AUTH_SECRET is missing or too short (need >= 32 chars). Copy .env.example to .env.',
    );
  }
  return new TextEncoder().encode(secret);
}

// --- password hashing -------------------------------------------------------

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

// --- session ----------------------------------------------------------------

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

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export async function setSessionCookie(token: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

// --- guards -----------------------------------------------------------------

export const HOME_FOR_ROLE: Record<Role, string> = {
  STUDENT: '/student',
  MENTOR: '/mentor',
  DIRECTOR: '/director',
  ADMIN: '/director',
};

export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

export async function requireRole(...roles: Role[]): Promise<SessionPayload> {
  const session = await requireSession();
  if (!roles.includes(session.role)) redirect(HOME_FOR_ROLE[session.role]);
  return session;
}

export async function requireStudent() {
  const session = await requireRole('STUDENT');
  if (!session.studentId) redirect('/login');
  return { session, studentId: session.studentId };
}

export async function requireMentor() {
  const session = await requireRole('MENTOR', 'DIRECTOR', 'ADMIN');
  return session;
}

// --- login ------------------------------------------------------------------

export async function authenticate(
  email: string,
  password: string,
): Promise<SessionPayload | null> {
  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    include: { student: true, mentor: true },
  });
  if (!user) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;

  const now = new Date();

  // `lastLoginAt` answers "are they still here?" and nothing else. A streak
  // needs the days in between, and a login *count* cannot tell thirty visits in
  // one evening from thirty consecutive days — hence one `LoginDay` row per
  // user per day, upserted in the same statement as the timestamp so a sign-in
  // can never be half-recorded.
  //
  // The day is the *local* calendar date reinterpreted at UTC midnight, which
  // is what a `@db.Date` column stores and what `currentDayKey` in `streak.ts`
  // reads back. Writing `now` straight into it would put an evening in IST on
  // the following day and hand the student a streak with a hole in it.
  const day = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

  await prisma.user.update({
    where: { id: user.id },
    data: {
      lastLoginAt: now,
      loginDays: {
        upsert: {
          where: { userId_day: { userId: user.id, day } },
          create: { day },
          // Nothing to change: the row's existence is the whole fact, so a
          // second sign-in on the same day is a no-op rather than a duplicate.
          update: {},
        },
      },
    },
  });

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    studentId: user.student?.id,
    mentorId: user.mentor?.id,
  };
}
