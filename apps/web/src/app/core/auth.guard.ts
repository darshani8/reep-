/**
 * The guard the Next middleware + per-page `requireSession()` did.
 *
 * The middleware only checked the cookie existed and each page re-verified it;
 * here one guard does both — it asks the backend to verify the session cookie
 * (GET /api/auth/session) and, failing that, sends the visitor to /login with a
 * same-origin `next` so they return to where they were headed.
 */

import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthService } from './auth.service';
import { HOME_FOR_ROLE } from './session';

export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.isSignedIn()) return true;

  const session = await auth.refresh();
  if (session) return true;

  return router.createUrlTree(['/login'], { queryParams: { next: state.url } });
};

/**
 * The landing route (`''`) used to be a blanket `redirectTo: 'student'`, which
 * bounced every non-student role off student-only screens (403s dressed up as
 * error states) on every visit to `/`. This guard picks the role's own home
 * instead. It runs inside the shell, i.e. after authGuard, so the session is
 * already resolved; the fallback covers a race, not a real path.
 */
export const homeRedirectGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const session = auth.session() ?? (await auth.refresh());
  return router.createUrlTree([session ? HOME_FOR_ROLE[session.role] : '/login']);
};
