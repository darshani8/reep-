import { Routes, Route } from '@angular/router';

import { AppShellComponent } from './layout/app-shell.component';
import { authGuard } from './core/auth.guard';

/**
 * Every nav destination in the shell needs a route, or clicking it goes nowhere
 * and navigation reads as broken. Built screens map to their component; the rest
 * map to a labelled PlaceholderComponent so each link navigates and highlights.
 * Migrating a screen is then a one-line swap: replace `placeholder(...)` with a
 * real `loadComponent`.
 *
 * ROUTES ARE LAZY (`loadComponent`, not `component`). A static `import` at the
 * top of this file pulls the component into the initial bundle no matter which
 * route the user visits — which is how every screen in the app ended up in one
 * 1.23 MB `main` chunk with no lazy chunks at all. A student on a phone was
 * downloading the mentor and director UIs, plus the resume builder and the
 * assistant, before the login form could paint.
 *
 * Only the two things needed to render the first frame stay eager: the shell
 * (every authenticated route lives inside it) and the guard. Adding a screen
 * here means adding a `loadComponent` — a plain `component:` reference silently
 * un-splits the bundle again and only shows up as a budget failure later.
 */
function placeholder(path: string, title: string): Route {
  return {
    path,
    loadComponent: () =>
      import('./features/placeholder/placeholder.component').then((m) => m.PlaceholderComponent),
    data: { title },
  };
}

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/login/login.component').then((m) => m.LoginComponent),
  },
  {
    path: 'register',
    loadComponent: () =>
      import('./features/register/registration.component').then((m) => m.RegistrationComponent),
  },
  {
    path: '',
    component: AppShellComponent,
    canActivate: [authGuard],
    children: [
      // --- student ---
      {
        path: 'student',
        loadComponent: () =>
          import('./features/student/overview/student-overview.component').then(
            (m) => m.StudentOverviewComponent,
          ),
      },
      {
        path: 'student/certifications',
        loadComponent: () =>
          import('./features/student/certifications/certifications.component').then(
            (m) => m.CertificationsComponent,
          ),
      },
      {
        path: 'student/academics',
        loadComponent: () =>
          import('./features/student/academics/academics.component').then(
            (m) => m.AcademicsComponent,
          ),
      },
      {
        path: 'student/skilling',
        loadComponent: () =>
          import('./features/student/skilling/skilling.component').then((m) => m.SkillingComponent),
      },
      {
        path: 'student/time-log',
        loadComponent: () =>
          import('./features/student/time-log/time-log.component').then((m) => m.TimeLogComponent),
      },
      {
        path: 'student/courses',
        loadComponent: () =>
          import('./features/student/courses/courses.component').then((m) => m.CoursesComponent),
      },
      {
        path: 'student/records',
        loadComponent: () =>
          import('./features/student/records/records.component').then((m) => m.RecordsComponent),
      },
      {
        path: 'student/leaderboards',
        loadComponent: () =>
          import('./features/student/leaderboards/leaderboards.component').then(
            (m) => m.LeaderboardsComponent,
          ),
      },
      {
        path: 'student/uploads',
        loadComponent: () =>
          import('./features/student/uploads/uploads.component').then((m) => m.UploadsComponent),
      },
      {
        path: 'student/resume',
        loadComponent: () =>
          import('./features/student/resume/resume-builder.component').then(
            (m) => m.ResumeBuilderComponent,
          ),
      },
      {
        path: 'student/jobs',
        loadComponent: () =>
          import('./features/student/jobs/jobs.component').then((m) => m.JobsComponent),
      },
      {
        path: 'student/offers',
        loadComponent: () =>
          import('./features/student/offers/offers.component').then((m) => m.OffersComponent),
      },
      // The three assistant routes share one dynamic import, so the bundler emits
      // a SINGLE chunk that all three reuse — a student who has already opened the
      // assistant does not re-download it under another role's path.
      {
        path: 'student/assistant',
        loadComponent: () =>
          import('./features/assistant/assistant.component').then((m) => m.AssistantComponent),
      },
      {
        path: 'student/profile',
        loadComponent: () =>
          import('./features/student/profile/profile.component').then((m) => m.ProfileComponent),
      },

      // --- mentor ---
      placeholder('mentor', 'Cohort'),
      placeholder('mentor/student', 'Students'),
      placeholder('mentor/alerts', 'Alerts'),
      placeholder('mentor/uploads', 'Verifications'),
      placeholder('mentor/reports', 'Reports'),
      placeholder('mentor/leave', 'Leave'),
      {
        path: 'mentor/assistant',
        loadComponent: () =>
          import('./features/assistant/assistant.component').then((m) => m.AssistantComponent),
      },
      placeholder('mentor/settings', 'Thresholds'),

      // --- director ---
      placeholder('director', 'Analytics'),
      placeholder('director/registrations', 'Registrations'),
      placeholder('director/mentors', 'Mentor assignment'),
      placeholder('director/courses', 'Courses'),
      placeholder('director/certifications', 'Certifications'),
      placeholder('director/placement', 'Placement'),
      placeholder('director/jobs', 'Jobs sheet'),
      {
        path: 'director/assistant',
        loadComponent: () =>
          import('./features/assistant/assistant.component').then((m) => m.AssistantComponent),
      },
      placeholder('director/exports', 'Exports'),

      { path: '', pathMatch: 'full', redirectTo: 'student' },
    ],
  },
  { path: '**', redirectTo: '' },
];
