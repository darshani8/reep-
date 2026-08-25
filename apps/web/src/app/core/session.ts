/**
 * The session shape, shared by contract with the FastAPI backend
 * (apps/api-py/app/routers/auth.py `_payload_for`): the claims the
 * `reep_session` cookie carries, exactly as the UI expects them.
 */

export type Role = 'STUDENT' | 'MENTOR' | 'DIRECTOR' | 'ADMIN' | 'ALUMNI';

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
  ALUMNI: '/alumni',
};
