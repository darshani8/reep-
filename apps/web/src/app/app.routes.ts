import { Routes } from '@angular/router';

import { LoginComponent } from './features/login/login.component';

/**
 * Routes land here one migrated screen at a time. Login is slice one; the
 * student, mentor and director areas follow, each behind an auth guard once
 * the NestJS session endpoint is wired.
 */
export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: '', redirectTo: 'login', pathMatch: 'full' },
];
