/**
 * The authenticated frame every role screen sits in — the 2026-09 shell.
 *
 * A 52px app bar, a 220px sidebar of grouped pill items, and a scrolling main
 * area the child route renders into. The navigation switches on the session's
 * role: students get the student items with their identity card on top, staff
 * get the faculty pages, the Main Admin gets the console's six groups, alumni
 * get profile and jobs.
 *
 * Every visual token lives globally in src/styles/reep-v2.scss — AGENTS.md's
 * rule is that the design system is global CSS classes and a component does not
 * redefine them. This file owns only the frame's behaviour: who is signed in,
 * which links they get, and the account menu.
 *
 * THE NAVIGATION IS DATA, NOT MARKUP. It was five hand-written blocks of
 * anchors; the console's six groups would have made it six. One model, one
 * loop, and the two things that are easy to get wrong become properties you
 * can see: whether an item needs a capability, and whether its screen exists
 * yet.
 *
 * A SCREEN THAT IS NOT BUILT IS NOT A LINK. Seven items on the approved admin
 * boards (Colleges, Faculty, Data imports, Audit log, My account) are Phase 2
 * routes. Angular's wildcard sends an unmatched path through homeRedirectGuard
 * back to /admin, so a `routerLink` to one of them would look live, do
 * nothing, and read as a broken console. They render as disabled rows that say
 * when they arrive — the same rule 06-phase-prompts.md sets for Phase 2's
 * plan-driven controls: never a dead control that looks live.
 */

import { Component, computed, effect, inject, signal } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { Title } from '@angular/platform-browser';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { environment } from '../../environments/environment';
import { AuthService } from '../core/auth.service';
import type { Role } from '../core/session';
import { AgentOrbComponent } from './agent-orb.component';

/** One row in the sidebar. */
interface NavigationItem {
  /** What the person reads. The product's vocabulary, not the schema's. */
  readonly label: string;
  /** Material Symbols ligature. Every glyph here must be in the subset
   *  (tools/fonts/icon-names.txt) or it renders as nothing at all. */
  readonly icon: string;
  /** The route, or null when the screen has not been built yet. */
  readonly path: string | null;
  /** Only render the row when the session holds this capability. */
  readonly capability?: string;
  /** Only render the row for the Main Admin, whatever their capabilities. */
  readonly mainAdminOnly?: boolean;
  /** Shown on a row whose screen does not exist yet. */
  readonly arrivesIn?: string;
  /** Match the route exactly, for a path that prefixes its siblings. */
  readonly exact?: boolean;
}

/** A titled run of rows. A blank title renders the rows with no heading. */
interface NavigationGroup {
  readonly title: string;
  readonly items: readonly NavigationItem[];
}

const PHASE_TWO = 'Available with Phase 2';

/**
 * The Main Admin console, in the groups the approved boards use
 * (docs/redesign-2026-09/01-design-system.md §3).
 *
 * Placement is deliberately not a row: it is reached from Jobs & placement and
 * from the Analytics tiles, which is how the boards route it.
 */
const ADMIN_NAVIGATION: readonly NavigationGroup[] = [
  {
    title: 'Overview',
    items: [{ label: 'Analytics', icon: 'insights', path: '/admin', exact: true }],
  },
  {
    title: 'Institution',
    items: [
      { label: 'Colleges', icon: 'apartment', path: null, arrivesIn: PHASE_TWO },
      { label: 'Structure', icon: 'school', path: '/admin/institution' },
      { label: 'Faculty', icon: 'shield_person', path: null, arrivesIn: PHASE_TWO },
      { label: 'Students & batches', icon: 'how_to_reg', path: '/admin/students' },
      { label: 'Mentor mapping', icon: 'group', path: '/admin/mentors' },
      { label: 'Catalogue', icon: 'menu_book', path: '/admin/catalogue' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { label: 'Registrations', icon: 'pending_actions', path: '/admin/registrations' },
      { label: 'Data imports', icon: 'upload', path: null, arrivesIn: PHASE_TWO },
      { label: 'Leave approvals', icon: 'event_available', path: '/admin/leave-approvals' },
      { label: 'Jobs & placement', icon: 'work', path: '/admin/jobs' },
      { label: 'Exports', icon: 'download', path: '/admin/exports' },
    ],
  },
  {
    title: 'Student insight',
    items: [
      { label: 'Question bank', icon: 'edit_note', path: '/admin/interview-questions' },
      { label: 'Interview records', icon: 'mic', path: '/admin/interviews' },
      { label: 'SWOC notes', icon: 'rate_review', path: '/admin/swoc' },
    ],
  },
  {
    title: 'Governance',
    items: [
      {
        label: 'Roles & functions',
        icon: 'admin_panel_settings',
        path: '/admin/governance',
        mainAdminOnly: true,
      },
      { label: 'Audit log', icon: 'history', path: null, arrivesIn: PHASE_TWO },
    ],
  },
  {
    title: 'Tools',
    items: [{ label: 'REEP Agent', icon: 'smart_toy', path: '/admin/agent' }],
  },
];

/**
 * The student's items, unchanged from what the sidebar lists today — the
 * redesign restyles this console, it does not re-navigate it.
 *
 * Shorter than the route table on purpose: English Baseline, Certifications,
 * Courses, Records, Uploads and Profile are each reached from the screen that
 * owns the work, or from the identity card. Their routes are kept, so a
 * bookmark and a deep link still resolve.
 */
const STUDENT_NAVIGATION: readonly NavigationGroup[] = [
  {
    title: '',
    items: [
      { label: 'Home', icon: 'home', path: '/student', exact: true },
      { label: 'Jobs', icon: 'work', path: '/student/jobs' },
      { label: 'Skilling', icon: 'verified', path: '/student/skilling' },
      { label: 'Leaderboards', icon: 'leaderboard', path: '/student/leaderboards' },
      { label: 'Time Sheet', icon: 'schedule', path: '/student/time-log' },
    ],
  },
  {
    title: 'Programme',
    items: [{ label: 'Faculty / TPO Log', icon: 'event_note', path: '/student/mentor-log' }],
  },
  {
    title: 'Documents',
    items: [{ label: 'Resume Builder', icon: 'description', path: '/student/resume' }],
  },
];

/**
 * Faculty items, unchanged. The redesign does not touch the faculty console
 * (02-admin-console-spec.md, "Faculty screens (no redesign)"); it inherits the
 * shell and the tokens and nothing else.
 *
 * These rows are NOT capability-filtered today, and that is the truth of main
 * rather than an oversight: ROLE_BASELINE['MENTOR'] holds every scoped key, so
 * every faculty account has them all. B2.3 shrinks that baseline, and the same
 * task has to add `capability` to these four rows in the same change — until
 * then a filter here would hide screens people can still open.
 */
const FACULTY_NAVIGATION: readonly NavigationGroup[] = [
  {
    title: '',
    items: [
      { label: 'Notebook', icon: 'menu_book', path: '/mentor/notebook' },
      { label: 'Mentee Log', icon: 'groups', path: '/mentor/mentees' },
      { label: 'Leave Requests', icon: 'event_available', path: '/mentor/leave' },
      { label: 'Skill Verifications', icon: 'verified', path: '/mentor/verifications' },
      { label: 'Upskilling', icon: 'workspace_premium', path: '/mentor/upskilling' },
    ],
  },
  {
    title: 'More',
    items: [{ label: 'REEP Agent', icon: 'smart_toy', path: '/mentor/agent' }],
  },
];

const ALUMNI_NAVIGATION: readonly NavigationGroup[] = [
  {
    title: '',
    items: [
      { label: 'My Profile', icon: 'person', path: '/alumni', exact: true },
      { label: 'Jobs Sheet', icon: 'work', path: '/alumni/jobs' },
    ],
  },
];

/**
 * Every admin.* capability the Main Admin can grant, and the screen it opens.
 * A faculty account that holds one sees it under "Granted access". A
 * capability with no row here is a grant that changes nothing on screen, so
 * this list and the catalogue in app/models/governance.py are kept in step.
 */
const GRANTABLE_ADMIN_SCREENS: readonly (NavigationItem & { capability: string })[] = [
  { capability: 'admin.analytics', path: '/admin', label: 'Analytics', icon: 'insights' },
  {
    capability: 'admin.registrations',
    path: '/admin/registrations',
    label: 'Registrations',
    icon: 'pending_actions',
  },
  { capability: 'admin.mentors', path: '/admin/mentors', label: 'Mentor mapping', icon: 'group' },
  {
    capability: 'admin.students',
    path: '/admin/students',
    label: 'Students & batches',
    icon: 'how_to_reg',
  },
  { capability: 'admin.institution', path: '/admin/institution', label: 'Structure', icon: 'school' },
  { capability: 'admin.catalogue', path: '/admin/catalogue', label: 'Catalogue', icon: 'menu_book' },
  { capability: 'admin.jobs', path: '/admin/jobs', label: 'Jobs & placement', icon: 'work' },
  { capability: 'admin.placement', path: '/admin/placement', label: 'Placement', icon: 'verified' },
  {
    capability: 'admin.interview_questions',
    path: '/admin/interview-questions',
    label: 'Question bank',
    icon: 'edit_note',
  },
  { capability: 'admin.swoc', path: '/admin/swoc', label: 'SWOC notes', icon: 'rate_review' },
  { capability: 'admin.exports', path: '/admin/exports', label: 'Exports', icon: 'download' },
];

/**
 * The vocabulary the college uses: a MENTOR-role account is a faculty member,
 * and the one ADMIN is the Main Admin. There is no DIRECTOR — see
 * core/session.ts.
 */
const ROLE_LABEL: Record<Role, string> = {
  STUDENT: 'Student',
  MENTOR: 'Faculty',
  ADMIN: 'Main Admin',
  ALUMNI: 'Alumni',
};

/** The name of the workspace, shown beside the brand mark. */
const CONSOLE_NAME: Record<Role, string> = {
  STUDENT: 'Student',
  MENTOR: 'Faculty console',
  ADMIN: 'Admin console',
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
  private readonly title = inject(Title);

  readonly session = this.auth.session;
  readonly roleLabel = computed(() => ROLE_LABEL[this.session()?.role as Role] ?? 'Student');
  readonly consoleName = computed(() => CONSOLE_NAME[this.session()?.role as Role] ?? 'Student');

  /** The one account that may open Governance (routers/governance.py is
   *  ADMIN-only, and the route carries roleGuard('ADMIN')). */
  readonly isMainAdmin = computed(() => this.session()?.role === 'ADMIN');

  /** Which navigation set to render. STUDENT is the fallback while /auth/me is
   *  in flight — the guard has already verified a session exists, so this only
   *  decides which links paint first. */
  readonly navKind = computed<'student' | 'staff' | 'admin' | 'alumni'>(() => {
    const role = this.session()?.role;
    // Admin is its own set, not staff-plus-extras: the office account was
    // getting the faculty navigation, so every screen built for it was routed
    // and unreachable.
    if (role === 'ADMIN') return 'admin';
    if (role === 'MENTOR') return 'staff';
    if (role === 'ALUMNI') return 'alumni';
    return 'student';
  });

  /** The groups this session's sidebar shows, already filtered. */
  readonly navigation = computed<readonly NavigationGroup[]>(() => {
    const kind = this.navKind();
    const source =
      kind === 'admin'
        ? ADMIN_NAVIGATION
        : kind === 'staff'
          ? FACULTY_NAVIGATION
          : kind === 'alumni'
            ? ALUMNI_NAVIGATION
            : STUDENT_NAVIGATION;

    const held = this.session()?.capabilities ?? [];
    const isMainAdmin = this.isMainAdmin();
    const groups: NavigationGroup[] = [];

    for (const group of source) {
      const items = group.items.filter((item) => {
        if (item.mainAdminOnly && !isMainAdmin) return false;
        if (item.capability && !held.includes(item.capability)) return false;
        return true;
      });
      if (items.length) groups.push({ title: group.title, items });
    }

    const granted = this.grantedAdminScreens();
    if (granted.length) groups.push({ title: 'Granted access', items: granted });
    return groups;
  });

  /**
   * Admin screens a FACULTY session has been granted. Only screens whose API
   * actually checks the capability belong here — a link to a screen whose API
   * still answers 403 by role is worse than no link.
   */
  private readonly grantedAdminScreens = computed<readonly NavigationItem[]>(() => {
    if (this.navKind() !== 'staff') return [];
    const held = this.session()?.capabilities ?? [];
    return GRANTABLE_ADMIN_SCREENS.filter((screen) => held.includes(screen.capability));
  });

  /**
   * The signed-in person's name, or a neutral placeholder while /auth/me is in
   * flight. Never a hardcoded demo name — shipping one would show every
   * student someone else's name for as long as the session takes to resolve.
   */
  readonly displayName = computed(() => this.session()?.name?.trim() || 'Signed in');

  /** Up to two initials for the avatar, from the name the session carries. */
  readonly initials = computed(() => {
    const words = this.displayName()
      .split(/\s+/)
      .filter((word) => /[a-z]/i.test(word));
    if (!words.length) return '··';
    const first = words[0][0];
    const last = words.length > 1 ? words[words.length - 1][0] : '';
    return (first + last).toUpperCase();
  });

  /**
   * The environment this bundle was built for, for the admin bar's pill.
   * deploy.yml rewrites `sentryEnvironment` to the API's ENV at build time, so
   * this says `prod` on production and `development` on a laptop. It is shown
   * only to the Main Admin, who is the one person for whom "which deployment
   * am I looking at" is a real question.
   */
  readonly environmentLabel = computed(() => environment.sentryEnvironment.trim());

  /**
   * The USN under the sidebar name.
   *
   * Fetched rather than read off the session on purpose: the session's claims
   * are a fixed contract (see ProfileOut's note in routers/student.py) and a
   * sidebar is not a reason to widen a signed cookie. One request, only for a
   * STUDENT, and a failure is silent — the card simply shows the name.
   */
  private readonly _usn = signal<string | null>(null);
  readonly usn = this._usn.asReadonly();

  /** The account menu behind the avatar. */
  private readonly _accountMenuOpen = signal(false);
  readonly accountMenuOpen = this._accountMenuOpen.asReadonly();

  constructor() {
    if (this.session()?.role === 'STUDENT') void this.loadUsn();

    // The browser tab said "REEP · Student" on every screen for every role,
    // because index.html hardcodes it and nothing ever set it again. A Main
    // Admin with six REEP tabs open could not tell them apart. `effect`, not a
    // one-shot read: session() resolves asynchronously from /auth/me.
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

  toggleAccountMenu(): void {
    this._accountMenuOpen.update((open) => !open);
  }

  closeAccountMenu(): void {
    this._accountMenuOpen.set(false);
  }

  async signOut(): Promise<void> {
    this.closeAccountMenu();
    await this.auth.logout();
    await this.router.navigate(['/login']);
  }
}
