/**
 * The session payload, identical to the React app's `SessionPayload` in
 * src/lib/auth.ts and to the Angular client's `core/session.ts`. One shape,
 * three places, so a token is interchangeable across the migration.
 */

import type { Role } from '@prisma/client';

export interface SessionPayload {
  userId: string;
  email: string;
  name: string;
  role: Role;
  studentId?: string;
  mentorId?: string;
}

/// The cookie name the Next middleware, the Node auth module and now the API
/// all agree on — ported from src/lib/session-shared.ts unchanged.
export const SESSION_COOKIE = 'reep_session';

/// Twelve hours, matching src/lib/auth.ts.
export const SESSION_TTL_SECONDS = 60 * 60 * 12;
