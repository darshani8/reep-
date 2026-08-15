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
import { SkillingComponent } from './features/student/skilling/skilling.component';
import { CoursesComponent } from './features/student/courses/courses.component';
import { UploadsComponent } from './features/student/uploads/uploads.component';
import { ResumeBuilderComponent } from './features/student/resume/resume-builder.component';
import { AssistantComponent } from './features/assistant/assistant.component';
import { RegistrationComponent } from './features/register/registration.component';
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
  { path: 'register', component: RegistrationComponent },
  {
    path: '',
    component: AppShellComponent,
    canActivate: [authGuard],
    children: [
      // --- student ---
      { path: 'student', component: StudentOverviewComponent },
      { path: 'student/certifications', component: CertificationsComponent },
      { path: 'student/academics', component: AcademicsComponent },
      { path: 'student/skilling', component: SkillingComponent },
      { path: 'student/time-log', component: TimeLogComponent },
      { path: 'student/courses', component: CoursesComponent },
      { path: 'student/leaderboards', component: LeaderboardsComponent },
      { path: 'student/uploads', component: UploadsComponent },
      { path: 'student/resume', component: ResumeBuilderComponent },
      { path: 'student/jobs', component: JobsComponent },
      { path: 'student/offers', component: OffersComponent },
      { path: 'student/assistant', component: AssistantComponent },
      { path: 'student/profile', component: ProfileComponent },

      // --- mentor ---
      placeholder('mentor', 'Cohort'),
      placeholder('mentor/student', 'Students'),
      placeholder('mentor/alerts', 'Alerts'),
      placeholder('mentor/uploads', 'Verifications'),
      placeholder('mentor/reports', 'Reports'),
      placeholder('mentor/leave', 'Leave'),
      { path: 'mentor/assistant', component: AssistantComponent },
      placeholder('mentor/settings', 'Thresholds'),

      // --- director ---
      placeholder('director', 'Analytics'),
      placeholder('director/registrations', 'Registrations'),
      placeholder('director/mentors', 'Mentor assignment'),
      placeholder('director/courses', 'Courses'),
      placeholder('director/certifications', 'Certifications'),
      placeholder('director/placement', 'Placement'),
      placeholder('director/jobs', 'Jobs sheet'),
      { path: 'director/assistant', component: AssistantComponent },
      placeholder('director/exports', 'Exports'),

      { path: '', pathMatch: 'full', redirectTo: 'student' },
    ],
  },
  { path: '**', redirectTo: '' },
];
