/**
 * The authenticated frame every role screen sits in — the Angular port of
 * src/components/app-shell.tsx.
 *
 * A 236px drawer (permanent from lg, an off-canvas overlay below it), a fixed
 * top bar carrying the signed-in name, the theme toggle and an account menu,
 * and a measured content column that the child route renders into. The nav
 * lists, the role labels and the active-row rule are ported unchanged.
 */

import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { AuthService } from '../core/auth.service';
import { ThemeService } from '../core/theme.service';
import { IconComponent } from '../shared/icon.component';
import { environment } from '../../environments/environment';
import type { Role } from '../core/session';

type ShellRole = 'student' | 'mentor' | 'director';

interface NavEntry {
  href: string;
  label: string;
  icon: string;
  /// True only for the role root, so /student does not light for /student/jobs.
  exact: boolean;
}

const ROLE_LABEL: Record<ShellRole, string> = {
  student: 'Student',
  mentor: 'Faculty mentor',
  director: 'Programme director',
};

function nav(root: string, items: [string, string, string][]): NavEntry[] {
  return items.map(([suffix, label, icon]) => {
    const href = suffix ? `${root}/${suffix}` : root;
    return { href, label, icon, exact: href === root };
  });
}

const NAV: Record<ShellRole, NavEntry[]> = {
  student: nav('/student', [
    ['', 'Overview', 'home'],
    ['certifications', 'Certifications', 'workspace_premium'],
    ['academics', 'Academics', 'school'],
    ['skilling', 'Skilling', 'psychology'],
    ['time-log', 'Time log', 'schedule'],
    ['courses', 'Courses', 'menu_book'],
    ['leaderboards', 'Leaderboards', 'leaderboard'],
    ['uploads', 'Uploads', 'cloud_upload'],
    ['resume', 'Resume', 'description'],
    ['jobs', 'Jobs', 'work'],
    ['offers', 'Offers', 'card_membership'],
    ['assistant', 'REEP Agent', 'chat_bubble'],
    ['profile', 'Profile', 'person'],
  ]),
  mentor: nav('/mentor', [
    ['', 'Cohort', 'groups'],
    ['student', 'Students', 'person_search'],
    ['alerts', 'Alerts', 'notifications'],
    ['uploads', 'Verifications', 'fact_check'],
    ['reports', 'Reports', 'assessment'],
    ['leave', 'Leave', 'event_busy'],
    ['assistant', 'REEP Agent', 'chat_bubble'],
    ['settings', 'Thresholds', 'tune'],
  ]),
  director: nav('/director', [
    ['', 'Analytics', 'insights'],
    ['registrations', 'Registrations', 'how_to_reg'],
    ['mentors', 'Mentor assignment', 'supervisor_account'],
    ['courses', 'Courses', 'menu_book'],
    ['certifications', 'Certifications', 'workspace_premium'],
    ['placement', 'Placement', 'work'],
    ['jobs', 'Jobs sheet', 'upload_file'],
    ['assistant', 'REEP Agent', 'chat_bubble'],
    ['exports', 'Exports', 'download'],
  ]),
};

function shellRole(role: Role): ShellRole {
  if (role === 'STUDENT') return 'student';
  if (role === 'MENTOR') return 'mentor';
  return 'director';
}

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, IconComponent],
  templateUrl: './app-shell.component.html',
  styleUrl: './app-shell.component.scss',
})
export class AppShellComponent {
  private readonly auth = inject(AuthService);
  readonly theme = inject(ThemeService);

  readonly mobileOpen = signal(false);
  readonly menuOpen = signal(false);
  readonly meta = signal<string | null>(null);

  readonly session = this.auth.session;
  readonly role = computed<ShellRole>(() => shellRole(this.session()?.role ?? 'STUDENT'));
  readonly roleLabel = computed(() => ROLE_LABEL[this.role()]);
  readonly items = computed(() => NAV[this.role()]);
  readonly userName = computed(() => this.session()?.name ?? '');

  readonly initials = computed(() =>
    this.userName()
      .replace(/^(Prof\.|Dr\.|Mr\.|Ms\.)\s*/i, '')
      .split(' ')
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase(),
  );

  constructor() {
    // The header meta line — USN · stage · semester — for a student, matching
    // the React StudentLayout. Fetched once; other roles show none.
    if (this.session()?.role === 'STUDENT') {
      void this.loadStudentMeta();
    }
  }

  private async loadStudentMeta(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/meta`, { credentials: 'include' });
      if (!res.ok) return;
      const m = (await res.json()) as { usn: string; stageLabel: string; currentSemester: number };
      this.meta.set(`USN ${m.usn} · ${m.stageLabel} · Semester ${m.currentSemester}`);
    } catch {
      // A missing meta line is not worth failing the whole shell over.
    }
  }

  closeMobile(): void {
    this.mobileOpen.set(false);
  }

  async signOut(): Promise<void> {
    await this.auth.logout();
    window.location.href = '/login';
  }
}
