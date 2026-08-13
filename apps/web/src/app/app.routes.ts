import { Routes, Route } from '@angular/router';

import { LoginComponent } from './features/login/login.component';
import { AppShellComponent } from './layout/app-shell.component';
import { authGuard } from './core/auth.guard';
import { StudentOverviewComponent } from './features/student/overview/student-overview.component';
import { PlaceholderComponent } from './features/placeholder/placeholder.component';

/**
 * Every nav destination in the shell needs a route, or clicking it goes nowhere
 * and navigation reads as broken. Built screens map to their component; the rest
 * map to a labelled PlaceholderComponent so each link navigates and highlights.
 * Migrating a screen is then a one-line swap: replace `placeholder(...)` with the
 * real component.
 */
function placeholder(path: string, title: string): Route {
  return { path, component: PlaceholderComponent, data: { title } };
}

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  {
    path: '',
    component: AppShellComponent,
    canActivate: [authGuard],
    children: [
      // --- student ---
      { path: 'student', component: StudentOverviewComponent },
      placeholder('student/certifications', 'Certifications'),
      placeholder('student/skilling', 'Skilling'),
      placeholder('student/time-log', 'Time log'),
      placeholder('student/courses', 'Courses'),
      placeholder('student/leaderboards', 'Leaderboards'),
      placeholder('student/uploads', 'Uploads'),
      placeholder('student/resume', 'Resume'),
      placeholder('student/jobs', 'Jobs'),
      placeholder('student/assistant', 'REEP Agent'),
      placeholder('student/profile', 'Profile'),

      // --- mentor ---
      placeholder('mentor', 'Cohort'),
      placeholder('mentor/student', 'Students'),
      placeholder('mentor/alerts', 'Alerts'),
      placeholder('mentor/uploads', 'Verifications'),
      placeholder('mentor/reports', 'Reports'),
      placeholder('mentor/leave', 'Leave'),
      placeholder('mentor/assistant', 'REEP Agent'),
      placeholder('mentor/settings', 'Thresholds'),

      // --- director ---
      placeholder('director', 'Analytics'),
      placeholder('director/registrations', 'Registrations'),
      placeholder('director/mentors', 'Mentor assignment'),
      placeholder('director/courses', 'Courses'),
      placeholder('director/certifications', 'Certifications'),
      placeholder('director/placement', 'Placement'),
      placeholder('director/jobs', 'Jobs sheet'),
      placeholder('director/assistant', 'REEP Agent'),
      placeholder('director/exports', 'Exports'),

      { path: '', pathMatch: 'full', redirectTo: 'student' },
    ],
  },
  { path: '**', redirectTo: '' },
];
