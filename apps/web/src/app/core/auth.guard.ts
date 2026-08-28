import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthService } from './auth.service';
import { HOME_FOR_ROLE } from './session';
import type { Role } from './session';

export const authGuard: CanActivateFn = async (_route, state) => {
    const auth = inject(AuthService);
    const router = inject(Router);

    if (auth.isSignedIn()) return true;

    const session = await auth.refresh();
    if (session) return true;

    return router.createUrlTree(['/login'], { queryParams: { next: state.url } });
};

/** UI navigation guard only; every API endpoint repeats this decision server-side. */
export const roleGuard = (...allowed: Role[]): CanActivateFn => async () => {
    const auth = inject(AuthService);
    const router = inject(Router);
    const session = auth.session() ?? (await auth.refresh());
    if (session && allowed.includes(session.role)) return true;
    return router.createUrlTree([session ? HOME_FOR_ROLE[session.role] : '/login']);
};

export const homeRedirectGuard: CanActivateFn = async () => {
    const auth = inject(AuthService);
    const router = inject(Router);
    const session = auth.session() ?? (await auth.refresh());
    return router.createUrlTree([session ? HOME_FOR_ROLE[session.role] : '/login']);
};
