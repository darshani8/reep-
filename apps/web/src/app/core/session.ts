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
  tokenVersion?: number;
  /// Resolved live by the API on every /login and /me — the role baseline
  /// plus any grants. Drives the nav and the route guards; every endpoint
  /// re-decides for itself.
  capabilities?: string[];
}

/// What `POST /api/auth/login` answers INSTEAD of a session when the server
/// requires a second step (`LoginChallenge` in app/schemas/auth.py): the
/// password was right, a six-digit code has been emailed, and no cookie was
/// set. `otp_required` is the discriminator the client branches on.
export interface LoginChallenge {
  otp_required: true;
  email: string;
  expires_in_minutes: number;
}

/// Where each role lands after signing in — the port of HOME_FOR_ROLE.
export const HOME_FOR_ROLE: Record<Role, string> = {
  STUDENT: '/student',
  MENTOR: '/mentor',
  DIRECTOR: '/director',
  ADMIN: '/director',
  ALUMNI: '/alumni',
};
