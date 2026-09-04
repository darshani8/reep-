import { Routes, Route } from '@angular/router';

import { AppShellComponent } from './layout/app-shell.component';
import { authGuard, homeRedirectGuard, roleGuard } from './core/auth.guard';

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
          import('./features/student/home/home.component').then((m) => m.StudentHomeComponent),
      },
      // The previous, much larger overview screen. Still routed rather than
      // deleted: the v2 landing is a programme map, and everything the old
      // screen showed (SWOC, attendance, VTU marks, readiness, recommendations)
      // is real and still reachable while those blocks find their own homes.
      {
        path: 'student/overview',
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
      // The Time Allocation Ledger. It replaced the old free-form time log at
      // this path, and the legacy screen is now DELETED rather than parked at a
      // second route: the only thing it still showed that the ledger did not was
      // SKILLING-hours-against-the-weekly-target, and that now renders on the
      // ledger itself, beside the days it is accumulated from.
      {
        path: 'student/time-log',
        loadComponent: () =>
          import('./features/student/ledger/ledger.component').then((m) => m.LedgerComponent),
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
        path: 'student/badges',
        loadComponent: () =>
          import('./features/student/badges/badges.component').then((m) => m.BadgesComponent),
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
      // The durable half of the mock interviewer: past interviews, their
      // transcripts and their practice reports. Its own chunk on purpose — a
      // student who never opens it never downloads it, and it shares the report
      // card with the assistant screen, which the bundler resolves into a chunk
      // the two reuse rather than a copy in each.
      {
        path: 'student/interviews',
        loadComponent: () =>
          import('./features/student/interviews/interviews.component').then(
            (m) => m.InterviewsComponent,
          ),
      },
      {
        path: 'student/english',
        loadComponent: () =>
          import('./features/student/english/english.component').then(
            (m) => m.EnglishBaselineComponent,
          ),
      },
      {
        path: 'student/mentor-log',
        loadComponent: () =>
          import('./features/student/mentor-log/mentor-log.component').then(
            (m) => m.MentorLogComponent,
          ),
      },
      {
        path: 'student/profile',
        loadComponent: () =>
          import('./features/student/profile/profile.component').then((m) => m.ProfileComponent),
      },

      // --- mentor / faculty ---
      {
        path: 'mentor',
        canActivate: [roleGuard('MENTOR', 'DIRECTOR', 'ADMIN')],
        loadComponent: () =>
          import('./features/mentor/notebook/mentor-notebook.component').then(
            (m) => m.MentorNotebookComponent,
          ),
      },
      {
        path: 'mentor/notebook',
        canActivate: [roleGuard('MENTOR', 'DIRECTOR', 'ADMIN')],
        loadComponent: () =>
          import('./features/mentor/notebook/mentor-notebook.component').then(
            (m) => m.MentorNotebookComponent,
          ),
      },
      placeholder('mentor/student', 'Students'),
      {
        path: 'mentor/mentees',
        loadComponent: () =>
          import('./features/mentor/mentee-log/mentee-log.component').then(
            (m) => m.MenteeLogComponent,
          ),
      },
      // The skill-claim review queue: the ONLY route by which a skill becomes
      // verified, and mentor-scoped on the server as well as here.
      {
        path: 'mentor/verifications',
        canActivate: [roleGuard('MENTOR', 'DIRECTOR', 'ADMIN')],
        loadComponent: () =>
          import('./features/mentor/verifications/verifications.component').then(
            (m) => m.MentorVerificationsComponent,
          ),
      },
      // Badge Centre came out of the mentor navigation — the handoff replaced it
      // with the verification queue above, which reviews the same evidence in
      // terms of the claim it backs. The route stays so an existing link still
      // resolves rather than falling through to the ** redirect.
      {
        path: 'mentor/badge-centre',
        loadComponent: () =>
          import('./features/mentor/badge-centre/badge-centre.component').then(
            (m) => m.BadgeCentreComponent,
          ),
      },
      {
        path: 'mentor/upskilling',
        loadComponent: () =>
          import('./features/mentor/upskilling/upskilling.component').then(
            (m) => m.UpskillingComponent,
          ),
      },
      placeholder('mentor/alerts', 'Alerts'),
      placeholder('mentor/uploads', 'Verifications'),
      placeholder('mentor/reports', 'Reports'),
      {
        path: 'mentor/leave',
        loadComponent: () =>
          import('./features/mentor/leave/leave.component').then((m) => m.LeaveComponent),
      },
      {
        path: 'mentor/assistant',
        loadComponent: () =>
          import('./features/assistant/assistant.component').then((m) => m.AssistantComponent),
      },
      placeholder('mentor/settings', 'Thresholds'),

      // --- admin (the DIRECTOR/ADMIN roles; the UI calls it Admin) ---
      {
        path: 'director',
        canActivate: [roleGuard('DIRECTOR', 'ADMIN')],
        loadComponent: () =>
          import('./features/director/analytics/analytics.component').then(
            (m) => m.DirectorAnalyticsComponent,
          ),
      },
      {
        path: 'director/leave-approvals',
        canActivate: [roleGuard('DIRECTOR', 'ADMIN')],
        loadComponent: () =>
          import('./features/director/leave-approvals/leave-approvals.component').then(
            (m) => m.DirectorLeaveApprovalsComponent,
          ),
      },
      {
        path: 'director/registrations',
        canActivate: [roleGuard('DIRECTOR', 'ADMIN')],
        loadComponent: () =>
          import('./features/director/registrations/registrations.component').then(
            (m) => m.DirectorRegistrationsComponent,
          ),
      },
      {
        path: 'director/mentors',
        canActivate: [roleGuard('DIRECTOR', 'ADMIN')],
        loadComponent: () =>
          import('./features/director/mentors-students/mentors-students.component').then(
            (m) => m.DirectorMentorsStudentsComponent,
          ),
      },
      // Courses and certifications are ONE screen: a certification only means
      // anything against the course it certifies, so they are read together.
      // Both paths resolve to it rather than leaving one a dead placeholder.
      {
        path: 'director/catalogue',
        canActivate: [roleGuard('DIRECTOR', 'ADMIN')],
        loadComponent: () =>
          import('./features/director/catalogue/catalogue.component').then(
            (m) => m.DirectorCatalogueComponent,
          ),
      },
      { path: 'director/courses', redirectTo: 'director/catalogue' },
      { path: 'director/certifications', redirectTo: 'director/catalogue' },
      {
        path: 'director/placement',
        canActivate: [roleGuard('DIRECTOR', 'ADMIN')],
        loadComponent: () =>
          import('./features/director/placement/placement.component').then(
            (m) => m.DirectorPlacementComponent,
          ),
      },
      {
        path: 'director/jobs',
        canActivate: [roleGuard('DIRECTOR', 'ADMIN')],
        loadComponent: () =>
          import('./features/director/jobs-sheet/jobs-sheet.component').then(
            (m) => m.DirectorJobsSheetComponent,
          ),
      },
      {
        path: 'director/assistant',
        loadComponent: () =>
          import('./features/assistant/assistant.component').then((m) => m.AssistantComponent),
      },
      {
        path: 'director/exports',
        canActivate: [roleGuard('DIRECTOR', 'ADMIN')],
        loadComponent: () =>
          import('./features/director/exports/exports.component').then(
            (m) => m.DirectorExportsComponent,
          ),
      },

      // --- alumni ---
      {
        path: 'alumni',
        loadComponent: () =>
          import('./features/alumni/profile/alumni-profile.component').then(
            (m) => m.AlumniProfileComponent,
          ),
      },
      {
        path: 'alumni/jobs',
        loadComponent: () =>
          import('./features/alumni/jobs/alumni-jobs.component').then((m) => m.AlumniJobsComponent),
      },

      // Role-aware landing: `redirectTo: 'student'` sent every role to the
      // student home; the guard reads the resolved session and returns the
      // UrlTree for that role's own home instead, so it never activates.
      { path: '', pathMatch: 'full', canActivate: [homeRedirectGuard], children: [] },
    ],
  },
  { path: '**', redirectTo: '' },
];
