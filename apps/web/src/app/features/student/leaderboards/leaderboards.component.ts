/**
 * Student leaderboards — the Angular port of src/app/student/leaderboards.
 *
 * Five boards, the viewer's own standing across all of them as stat tiles and
 * one chart, and the active board's table. Every figure a peer could not see is
 * already absent from the payload (scope.ts fences it server-side); this screen
 * only ever renders a name, a rank and a band for anyone but the viewer.
 */

import { Component, computed, inject, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';
import { PageIntroComponent, SectionComponent, StatComponent, EmptyComponent, BannerComponent } from '../../../shared/kit/kit.components';
import { BarChartComponent } from '../../../shared/charts/bar-chart.component';

interface BoardRow {
  rank: number;
  ordinal: string;
  displayName: string;
  band: string;
  isViewer: boolean;
  yourValueLabel: string | null;
}
interface BoardView {
  key: string;
  label: string;
  blurb: string;
  rankingKey: string;
  tieBreak: string;
  emptyHint: string;
  actionHref: string;
  actionLabel: string;
  rows: BoardRow[];
  you: { rank: number; ordinal: string; outOf: number; valueLabel: string; band: string; onBoard: boolean; empty: boolean; standingPct: number } | null;
  ranked: number;
  hasFigures: boolean;
  optedOutPeers: number;
  viewerAppended: boolean;
}
interface LeaderboardsView {
  available: boolean;
  cohortLabel?: string;
  cohortSize?: number;
  viewerOptedOut?: boolean;
  boards?: BoardView[];
  standings?: { label: string; value: number }[];
}

@Component({
  selector: 'app-student-leaderboards',
  standalone: true,
  imports: [PageIntroComponent, SectionComponent, StatComponent, EmptyComponent, BannerComponent, BarChartComponent],
  templateUrl: './leaderboards.component.html',
  styleUrl: './leaderboards.component.scss',
})
export class LeaderboardsComponent {
  readonly view = signal<LeaderboardsView | null>(null);
  readonly error = signal<string | null>(null);
  readonly activeKey = signal<string>('streak');

  readonly boards = computed(() => this.view()?.boards ?? []);
  readonly active = computed(() => this.boards().find((b) => b.key === this.activeKey()) ?? this.boards()[0] ?? null);
  readonly standings = computed(() => this.view()?.standings ?? []);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/leaderboards`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set('Could not load the leaderboards.');
        return;
      }
      this.view.set((await res.json()) as LeaderboardsView);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  setBoard(key: string): void {
    this.activeKey.set(key);
  }

  nothingRanked(b: BoardView): boolean {
    return b.ranked === 0 || (!b.hasFigures && (b.you?.empty ?? true));
  }
}
