/**
 * The student landing screen — the greeting, the streak chip and the three
 * programme stage cards (Reboot · Excel · Elevate).
 *
 * The stage cards come from `GET /api/student/programme`, where the programme's
 * STRUCTURE is a code catalogue and only a student's STATUS is a row (see
 * app/models/milestone.py). One item is a link rather than a checkbox — English
 * Baseline · AI navigates to its own screen and its status is derived from the
 * attempt, so it cannot say "not started" under a finished report.
 *
 * The old, much larger overview screen is still routed at /student/records and
 * the other detail routes; this replaces only the landing itself, which the
 * handoff specifies precisely.
 */

import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/auth.service';

interface ProgrammeItem {
  key: string;
  label: string;
  route: string | null;
  status: string;
  glyph: string;
  tone: 'good' | 'warn' | 'neutral';
  title: string;
}

interface Stage {
  key: string;
  label: string;
  completed: number;
  total: number;
  items: ProgrammeItem[];
}

interface Programme {
  stages: Stage[];
  completed: number;
  total: number;
  percent: number;
}

interface Streak {
  current: number;
  longest: number;
  days_active: number;
}

@Component({
  selector: 'app-student-home',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './home.component.html',
})
export class StudentHomeComponent {
  private readonly auth = inject(AuthService);

  readonly state = signal<'loading' | 'data' | 'error'>('loading');
  readonly programme = signal<Programme | null>(null);
  readonly streak = signal<Streak | null>(null);
  readonly identity = signal<{ usn: string | null; stage: string; semester: number } | null>(null);

  /** First name only — the greeting reads "Welcome back, Asha", not a full
   *  legal name. Falls back to a neutral greeting rather than to a placeholder
   *  person while the session resolves. */
  readonly firstName = computed(() => {
    const name = this.auth.session()?.name?.trim();
    return name ? name.split(/\s+/)[0] : null;
  });

  readonly subline = computed(() => {
    const id = this.identity();
    if (!id) return null;
    const stage = id.stage.replace(/_/g, ' ').toLowerCase();
    const parts = [
      `${stage.charAt(0).toUpperCase()}${stage.slice(1)} stage`,
      `Semester ${id.semester}`,
    ];
    if (id.usn) parts.push(id.usn);
    return parts.join(' · ');
  });

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.state.set('loading');
    // The three reads are independent; only the programme decides the screen's
    // state, so a missing streak or profile degrades to a hidden chip rather
    // than to an error page over a decoration.
    const [programme, streak, profile] = await Promise.allSettled([
      this.get<Programme>('/student/programme'),
      this.get<Streak>('/student/streak'),
      this.get<{ usn: string | null; current_stage: string; current_semester: number }>(
        '/student/profile',
      ),
    ]);

    if (streak.status === 'fulfilled') this.streak.set(streak.value);
    if (profile.status === 'fulfilled') {
      this.identity.set({
        usn: profile.value.usn,
        stage: profile.value.current_stage,
        semester: profile.value.current_semester,
      });
    }

    if (programme.status === 'fulfilled') {
      this.programme.set(programme.value);
      this.state.set('data');
    } else {
      this.state.set('error');
    }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${environment.apiBase}${path}`, { credentials: 'include' });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as T;
  }
}
