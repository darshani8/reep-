/**
 * The authenticated frame every role screen sits in — the REEP v2 desktop shell.
 *
 * A title bar, a 220px sidebar (profile card + grouped nav) and a scrolling main
 * area the child route renders into. The nav switches on the session's role:
 * students get the full student navigation, staff (MENTOR/DIRECTOR/ADMIN) get
 * the faculty pages (mentee log, leave, upskilling), alumni get profile + jobs.
 *
 * Every visual token for .desktop-frame, .desktop-nav, .nav-profile and the rest
 * lives globally in src/styles/reep-v2.scss — AGENTS.md's rule is that the design
 * system is global CSS classes and a component does not redefine them. This file
 * owns only the frame's behaviour: who is signed in, and signing out.
 */

import { Component, computed, inject, signal } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { environment } from '../../environments/environment';
import { AuthService } from '../core/auth.service';
import type { Role } from '../core/session';
import { AgentOrbComponent } from './agent-orb.component';

const ROLE_LABEL: Record<Role, string> = {
  STUDENT: 'Student',
  MENTOR: 'Mentor',
  DIRECTOR: 'Director',
  ADMIN: 'Admin',
  ALUMNI: 'Alumni',
};

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, UpperCasePipe, AgentOrbComponent],
  templateUrl: './app-shell.component.html',
  styleUrl: './app-shell.component.scss',
})
export class AppShellComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly session = this.auth.session;
  readonly roleLabel = computed(() => ROLE_LABEL[this.session()?.role ?? 'STUDENT'] ?? 'Student');

  /** Which of the three navigation sets to render. STUDENT is the fallback
   *  while /auth/me is in flight — the guard has already verified a session
   *  exists, so this only decides which links paint first. */
  readonly navKind = computed<'student' | 'staff' | 'admin' | 'alumni'>(() => {
    const role = this.session()?.role;
    // Admin is its own set, not staff-plus-extras. A DIRECTOR/ADMIN was getting
    // the mentor navigation, so every screen built for them — analytics,
    // approvals, registrations, assignment — was routed and unreachable.
    if (role === 'DIRECTOR' || role === 'ADMIN') return 'admin';
    if (role === 'MENTOR') return 'staff';
    if (role === 'ALUMNI') return 'alumni';
    return 'student';
  });

  /** The signed-in person's name, or a neutral placeholder while /auth/me is in
   *  flight. Never a hardcoded demo name — the prototype's "Asha Rao" is sample
   *  data, and shipping it would show every student someone else's name for as
   *  long as the session takes to resolve. */
  readonly displayName = computed(() => this.session()?.name?.trim() || 'Signed in');

  /** The USN under the sidebar name.
   *
   *  Fetched rather than read off the session on purpose: the session's claims
   *  are a fixed contract (see ProfileOut's note in routers/student.py) and a
   *  sidebar is not a reason to widen a signed cookie. One request, only for a
   *  STUDENT, and a failure is silent — the card simply shows the name, which
   *  is the correct fallback for staff too. */
  private readonly _usn = signal<string | null>(null);
  readonly usn = this._usn.asReadonly();

  constructor() {
    if (this.session()?.role === 'STUDENT') void this.loadUsn();
  }

  private async loadUsn(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/profile`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const body = (await res.json()) as { usn?: string | null };
      this._usn.set(body.usn?.trim() || null);
    } catch {
      // The sidebar is not worth an error state. Name only.
    }
  }

  async signOut(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/login']);
  }
}
