/**
 * Authentication, ported from `authenticate()` in src/lib/auth.ts.
 *
 * The logic is reproduced exactly, including the LoginDay upsert that the
 * streak depends on: `lastLoginAt` answers "are they still here?", but a streak
 * needs one row per user per calendar day, written in the same statement so a
 * sign-in can never be half-recorded. The day is the local date reinterpreted
 * at UTC midnight — the same computation `streak.ts` reads back — so an evening
 * sign-in in IST does not land on the following day and punch a hole in the
 * streak.
 */

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { verifyPassword } from './auth.crypto';
import type { SessionPayload } from './session.types';

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async authenticate(email: string, password: string): Promise<SessionPayload | null> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: { student: true, mentor: true },
    });
    if (!user) return null;
    if (!verifyPassword(password, user.passwordHash)) return null;
    return this.establishSession(user);
  }

  /**
   * Sign in a user Google/Microsoft has already authenticated by a verified
   * institutional email — the SSO path (roadmap Phase A). It matches an EXISTING
   * account only; SSO never creates one, because an account is a registration
   * decision (cohort, USN, approval) an OAuth handshake has no business making.
   * A verified email with no REEP account returns null, and the caller sends the
   * visitor to registration rather than logging a stranger in.
   */
  async ssoSignIn(email: string): Promise<SessionPayload | null> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: { student: true, mentor: true },
    });
    if (!user) return null;
    return this.establishSession(user);
  }

  /// The shared tail of every sign-in: stamp lastLoginAt, record the LoginDay the
  /// streak reads, and project the session payload. One definition so a password
  /// login and an SSO login are recorded identically.
  private async establishSession(user: {
    id: string;
    email: string;
    name: string;
    role: SessionPayload['role'];
    student: { id: string } | null;
    mentor: { id: string } | null;
  }): Promise<SessionPayload> {
    const now = new Date();
    const day = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: now,
        loginDays: {
          upsert: { where: { userId_day: { userId: user.id, day } }, create: { day }, update: {} },
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
}
