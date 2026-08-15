/**
 * Student leaderboards — the "Leaderboards" panel (mockup data-p="leaderboards").
 *
 * Five cohort boards (Certificates / Skills / VTU results / Streak / Mocks taken)
 * as a .tabs-row, each rendering the .lb-row ranking visual — rank pill, initials
 * avatar, name, and the metric total, with the viewer's own row highlighted (.me).
 *
 * There is deliberately NO backend for this yet: student.py exposes /skills,
 * /streak, /mocks, /results and /certifications individually, but no aggregated,
 * cohort-scoped /leaderboards endpoint. Inventing a fetch here would 404. So the
 * boards stay empty and every tab shows a "coming soon" state until that endpoint
 * exists; the .lb-row @for below is the shape it will paint when it does.
 */

import { Component, computed, signal } from '@angular/core';

/** One ranked cohort peer — the shape a future /student/leaderboards row will take. */
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

  /// No endpoint yet — every board is empty, so the "coming soon" state shows.
  readonly rows = signal<LbEntry[]>([]);

  readonly activeLabel = computed(
    () => this.tabs.find((t) => t.key === this.active())?.label ?? 'Leaderboards',
  );

  setTab(key: string): void {
    this.active.set(key);
  }
}
