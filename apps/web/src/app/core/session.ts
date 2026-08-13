/**
 * The session shape, shared between the Angular client and (by contract) the
 * NestJS backend. This is the same `SessionPayload` the React app's
 * `src/lib/auth.ts` defines — ported verbatim so a token minted by the backend
 * carries exactly the fields the UI already expects.
 */

export type Role = 'STUDENT' | 'MENTOR' | 'DIRECTOR' | 'ADMIN';

export interface SessionPayload {
  userId: string;
  email: string;
  name: string;
  role: Role;
  /// Present for STUDENT, absent otherwise.
  studentId?: string;
  mentorId?: string;
}

/// Where each role lands after signing in — the port of HOME_FOR_ROLE.
export const HOME_FOR_ROLE: Record<Role, string> = {
  STUDENT: '/student',
  MENTOR: '/mentor',
  DIRECTOR: '/director',
  ADMIN: '/director',
};
