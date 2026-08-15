/**
 * Student leaderboards — the "Leaderboards" panel (mockup data-p="leaderboards").
 *
 * Five cohort boards (Certificates / Skills / VTU results / Streak / Mocks taken)
 * as a .tabs-row, each rendering the .lb-row ranking visual — rank pill, initials
 * avatar, name, and the metric total, with the viewer's own row highlighted (.me).
 *
 * Wired to GET /student/leaderboards?board=<key>, which ranks the caller's cohort
 * and honours the leaderboard opt-out in both directions (an opted-out student
 * sees no ranks, and appears on none).
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

/** One ranked cohort peer — matches the FastAPI LeaderRow. */
interface LbEntry {
  rank: number;
  initials: string;
  name: string;
  is_me: boolean;
  value_label: string;
}

interface Tab {
  key: string;
  label: string;
}

@Component({
  selector: 'app-student-leaderboards',
  standalone: true,
  templateUrl: './leaderboards.component.html',
  styleUrl: './leaderboards.component.scss',
})
export class LeaderboardsComponent {
  readonly tabs: Tab[] = [
    { key: 'certificates', label: 'Certificates' },
    { key: 'skills', label: 'Skills' },
    { key: 'vtu', label: 'VTU results' },
    { key: 'streak', label: 'Streak' },
    { key: 'mocks', label: 'Mocks taken' },
  ];

  readonly active = signal<string>('certificates');
  readonly rows = signal<LbEntry[]>([]);
  readonly loading = signal(true);
  readonly optedOut = signal(false);
  readonly error = signal<string | null>(null);

  readonly activeLabel = computed(
    () => this.tabs.find((t) => t.key === this.active())?.label ?? 'Leaderboards',
  );

  constructor() {
    void this.load();
  }

  setTab(key: string): void {
    if (key === this.active()) return;
    this.active.set(key);
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await fetch(
        `${environment.apiBase}/student/leaderboards?board=${encodeURIComponent(this.active())}`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        this.error.set('Could not load the leaderboard.');
        this.rows.set([]);
        return;
      }
      const body = (await res.json()) as { opted_out: boolean; rows: LbEntry[] };
      this.optedOut.set(body.opted_out);
      this.rows.set(body.rows ?? []);
    } catch {
      this.error.set('Could not reach the server.');
      this.rows.set([]);
    } finally {
      this.loading.set(false);
    }
  }
}
