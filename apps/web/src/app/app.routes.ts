import { Routes } from '@angular/router';

import { LoginComponent } from './features/login/login.component';
import { AppShellComponent } from './layout/app-shell.component';
import { authGuard } from './core/auth.guard';
import { StudentOverviewComponent } from './features/student/overview/student-overview.component';
import { PlaceholderComponent } from './features/placeholder/placeholder.component';

/**
 * Login sits outside the shell; everything else renders inside it behind the
 * auth guard. Migrated screens replace their PlaceholderComponent one slice at a
 * time — the route stays, the component swaps.
 */
export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  {
    path: '',
    component: AppShellComponent,
    canActivate: [authGuard],
    children: [
      { path: 'student', component: StudentOverviewComponent },
      // Role roots that keep a coherent landing until their screens are ported.
      { path: 'mentor', component: PlaceholderComponent },
      { path: 'director', component: PlaceholderComponent },
      { path: '', pathMatch: 'full', redirectTo: 'student' },
    ],
  },
  { path: '**', redirectTo: '' },
];
