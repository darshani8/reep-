/**
 * The authenticated frame every role screen sits in — the REEP v2 desktop shell.
 *
 * A .desktop-frame (title bar + shell) from docs/design-v2/student-app.html: a
 * 220px .desktop-nav on the left and a .desktop-main that the child route renders
 * into via <router-outlet>. The nav is the student navigation; it renders for
 * every role for now (the task's foundation phase), so a non-STUDENT session
 * still gets a working frame rather than a crash.
 *
 * The design system for every class here lives globally in
 * src/styles/reep-v2.scss — this component only lays out the frame and owns the
 * sign-out affordance.
 */

import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { AuthService } from '../core/auth.service';
import type { Role } from '../core/session';

const ROLE_LABEL: Record<Role, string> = {
  STUDENT: 'Student',
  MENTOR: 'Mentor',
  DIRECTOR: 'Director',
  ADMIN: 'Admin',
};

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './app-shell.component.html',
  styleUrl: './app-shell.component.scss',
})
export class AppShellComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly session = this.auth.session;
  readonly roleLabel = computed(() => ROLE_LABEL[this.session()?.role ?? 'STUDENT'] ?? 'Student');

  async signOut(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/login']);
  }
}
