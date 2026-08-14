import { Routes, Route } from '@angular/router';

import { LoginComponent } from './features/login/login.component';
import { AppShellComponent } from './layout/app-shell.component';
import { authGuard } from './core/auth.guard';
import { StudentOverviewComponent } from './features/student/overview/student-overview.component';
import { JobsComponent } from './features/student/jobs/jobs.component';
import { CertificationsComponent } from './features/student/certifications/certifications.component';
import { ProfileComponent } from './features/student/profile/profile.component';
import { LeaderboardsComponent } from './features/student/leaderboards/leaderboards.component';
import { TimeLogComponent } from './features/student/time-log/time-log.component';
import { OffersComponent } from './features/student/offers/offers.component';
import { AcademicsComponent } from './features/student/academics/academics.component';
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
      { path: 'student/certifications', component: CertificationsComponent },
      { path: 'student/academics', component: AcademicsComponent },
      placeholder('student/skilling', 'Skilling'),
      { path: 'student/time-log', component: TimeLogComponent },
      placeholder('student/courses', 'Courses'),
      { path: 'student/leaderboards', component: LeaderboardsComponent },
      placeholder('student/uploads', 'Uploads'),
      placeholder('student/resume', 'Resume'),
      { path: 'student/jobs', component: JobsComponent },
      { path: 'student/offers', component: OffersComponent },
      placeholder('student/assistant', 'REEP Agent'),
      { path: 'student/profile', component: ProfileComponent },

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
