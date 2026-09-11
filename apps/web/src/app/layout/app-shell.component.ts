/**
 * The authenticated frame every role screen sits in — the REEP v2 desktop shell.
 *
 * A title bar, a 220px sidebar (profile card + grouped nav) and a scrolling main
 * area the child route renders into. The nav switches on the session's role:
 * students get the full student navigation, staff (MENTOR/ADMIN) get
 * the faculty pages (mentee log, leave, upskilling), alumni get profile + jobs.
 *
 * Every visual token for .desktop-frame, .desktop-nav, .nav-profile and the rest
 * lives globally in src/styles/reep-v2.scss — AGENTS.md's rule is that the design
 * system is global CSS classes and a component does not redefine them. This file
 * owns only the frame's behaviour: who is signed in, and signing out.
 */

import { Component, computed, effect, inject, signal } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { Title } from '@angular/platform-browser';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { environment } from '../../environments/environment';
import { AuthService } from '../core/auth.service';
import type { Role } from '../core/session';

/// Every admin.* capability the Main Admin can grant, and the screen it opens.
/// A capability with no row here is a grant that changes nothing on screen, so
/// this list and the catalogue in app/models/governance.py are kept in step;
/// each route below carries the SAME key as a capabilityGuard.
const ADMIN_LINKS = [
  { capability: 'admin.analytics', path: '/admin', label: 'Analytics', icon: 'insights' },
  { capability: 'admin.registrations', path: '/admin/registrations', label: 'Registrations', icon: 'pending_actions' },
  { capability: 'admin.mentors', path: '/admin/mentors', label: 'Faculty & Students', icon: 'groups' },
  { capability: 'admin.students', path: '/admin/students', label: 'Students', icon: 'how_to_reg' },
  { capability: 'admin.institution', path: '/admin/institution', label: 'Institution', icon: 'school' },
  { capability: 'admin.catalogue', path: '/admin/catalogue', label: 'Catalogue', icon: 'menu_book' },
  { capability: 'admin.jobs', path: '/admin/jobs', label: 'Jobs Sheet', icon: 'work' },
  { capability: 'admin.placement', path: '/admin/placement', label: 'Placement', icon: 'verified' },
  { capability: 'admin.interview_questions', path: '/admin/interview-questions', label: 'Interview Questions', icon: 'edit_note' },
  { capability: 'admin.swoc', path: '/admin/swoc', label: 'SWOC Notes', icon: 'rate_review' },
  { capability: 'admin.exports', path: '/admin/exports', label: 'Exports', icon: 'download' },
] as const;
import { AgentOrbComponent } from './agent-orb.component';

// The vocabulary the college uses: a MENTOR-role account is a faculty member,
// and the one ADMIN is the Main Admin. There is no DIRECTOR — see core/session.ts.
const ROLE_LABEL: Record<Role, string> = {
  STUDENT: 'Student',
  MENTOR: 'Faculty',
  ADMIN: 'Main Admin',
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
  readonly roleLabel = computed(() => ROLE_LABEL[this.session()?.role as Role] ?? 'Student');
  /** The one account that may open Governance (routers/governance.py is ADMIN-only). */
  readonly isMainAdmin = computed(() => this.session()?.role === 'ADMIN');

  /** Which of the three navigation sets to render. STUDENT is the fallback
   *  while /auth/me is in flight — the guard has already verified a session
   *  exists, so this only decides which links paint first. */
  /** Admin screens a STAFF session has been GRANTED. Only entries whose API
   *  endpoints actually check the capability belong here — a link to a screen
   *  whose API still answers 403 by role is worse than no link. Analytics is
   *  wired; the rest join as their endpoints do. */
  readonly adminLinksHeld = computed(() => {
    const caps = this.session()?.capabilities ?? [];
    return ADMIN_LINKS.filter((l) => caps.includes(l.capability));
  });

  readonly navKind = computed<'student' | 'staff' | 'admin' | 'alumni'>(() => {
    const role = this.session()?.role;
    // Admin is its own set, not staff-plus-extras. The office account was
    // getting the mentor navigation, so every screen built for it — analytics,
    // approvals, registrations, assignment — was routed and unreachable.
    //
    // ONLY 'ADMIN' reaches this set. A retired DIRECTOR cookie used to as well,
    // which painted the whole console for an account the API refuses on every
    // request: a sidebar of fifteen links that all answer 403.
    if (role === 'ADMIN') return 'admin';
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

  private readonly title = inject(Title);

  constructor() {
    if (this.session()?.role === 'STUDENT') void this.loadUsn();

    // The browser tab said "REEP · Student" on EVERY screen for every role,
    // because index.html hardcodes it and nothing ever set it again. A Main
    // Admin with six REEP tabs open could not tell them apart, and the tab
    // contradicted the title bar two pixels away. The role is the useful
    // distinction (the shell is one workspace per role), so it is what the tab
    // carries. `effect`, not a one-shot read: `session()` resolves
    // asynchronously from /auth/me, so the first paint has no role yet.
    effect(() => {
      this.title.setTitle(`REEP · ${this.roleLabel()}`);
    });
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
