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

export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.isSignedIn()) return true;

  const session = await auth.refresh();
  if (session) return true;

  return router.createUrlTree(['/login'], { queryParams: { next: state.url } });
};
