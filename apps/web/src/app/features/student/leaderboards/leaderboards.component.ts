/**
 * Student leaderboards — the "Leaderboards" panel (mockup data-p="leaderboards").
 *
 * Four cohort boards (Skills / VTU results / Streak / Mocks taken)
 * as a .tabs-row, each rendering the .lb-row ranking visual — rank pill, initials
 * avatar, name, and the metric total, with the viewer's own row highlighted (.me).
 *
 * Reworked for motivation + privacy (UX audit):
 *   - a prominent "You're Rank N of {cohort_size}" card for the viewer's own
 *     position, with encouraging framing for lower ranks (top X% / a nudge);
 *   - cohort context ("of N") wherever a rank appears;
 *   - a per-board scoring + refresh explainer;
 *   - a "Hide me from leaderboards" control that drives
 *     PUT /student/leaderboard-visibility and reflects the opt-out state.
 *
 * Wired to GET /student/leaderboards?board=<key>, which ranks the caller's cohort
 * and honours the leaderboard opt-out in both directions (an opted-out student
 * sees no ranks, and appears on none).
 *
 * ONLY A CLASSMATE WITH A RECORD ON A BOARD IS ON IT, AND EQUAL TOTALS SHARE A
 * RANK (2026-09-17). The server used to rank the whole roster at zero, so the
 * "not ranked here yet" card below was unreachable and "Rank 2 of 30" sat under
 * a student holding nothing. Rows are tracked by `student_id` because two rows
 * can now carry the same rank, and `cohort_size` is the number of students
 * ranked on this board — which the column header and the explainer now say.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

/** One ranked cohort peer — matches the FastAPI LeaderRow. */
interface LbEntry {
  rank: number;
  student_id: string;
  initials: string;
  name: string;
  is_me: boolean;
  value_label: string;
}

/** GET /student/leaderboards?board= — the LeaderboardOut shape. */
interface LeaderboardResponse {
  board: string;
  opted_out: boolean;
  cohort_size: number;
  rows: LbEntry[];
}

interface Tab {
  key: string;
  /** Tab label. */
  label: string;
  /** How this board is scored — shown in the explainer note. */
  scored: string;
  /** What puts a student on this board — the "not ranked yet" card's sentence. */
  first: string;
}

@Component({
  selector: 'app-student-leaderboards',
  standalone: true,
  templateUrl: './leaderboards.component.html',
  styleUrl: './leaderboards.component.scss',
})
export class LeaderboardsComponent {
  // Certificates came out of the board set: a certificate is evidence for a
  // skill rather than an achievement of its own, and the Skills board already
  // ranks on what those certificates were verified into.
  readonly tabs: Tab[] = [
    {
      key: 'skills',
      label: 'Skills',
      scored: 'skills verified on Skilling',
      first: 'Get a skill verified on Skilling and you’ll appear on this board.',
    },
    {
      key: 'vtu',
      label: 'VTU results',
      scored: 'your latest recorded CGPA',
      first: 'You’ll appear here once a semester result is recorded for you.',
    },
    {
      key: 'streak',
      label: 'Streak',
      scored: 'active-day count',
      first: 'Your sign-ins are counted from today — you’ll appear here shortly.',
    },
    {
      key: 'mocks',
      label: 'Mocks taken',
      scored: 'mocks completed',
      first: 'Finish a mock interview through to its verdict and you’ll appear on this board.',
    },
  ];

  readonly active = signal<string>('skills');
  readonly rows = signal<LbEntry[]>([]);
  readonly cohortSize = signal(0);
  readonly loading = signal(true);
  readonly optedOut = signal(false);
  readonly error = signal<string | null>(null);

  // Hide-me control state.
  readonly savingVisibility = signal(false);
  readonly visibilityMsg = signal<string | null>(null);

  readonly activeTab = computed(
    () => this.tabs.find((t) => t.key === this.active()) ?? this.tabs[0],
  );
  readonly activeLabel = computed(() => this.activeTab().label);

  /** The viewer's own ranked row on the current board, if present. */
  readonly myRow = computed(() => this.rows().find((r) => r.is_me) ?? null);

  /** Encouraging, cohort-aware framing of the viewer's own position. */
  readonly ownStanding = computed<{
    ranked: boolean;
    headline: string;
    encouragement: string;
  }>(() => {
    const me = this.myRow();
    const n = this.cohortSize();
    if (!me) {
      return {
        ranked: false,
        headline: 'You’re not ranked here yet',
        encouragement: this.activeTab().first,
      };
    }
    const headline = `You’re Rank ${me.rank} of ${n}`;
    return { ranked: true, headline, encouragement: this.encourage(me.rank, n) };
  });

  /** The scoring + refresh explainer for the active board. */
  readonly explainer = computed(
    () =>
      `Ranked by ${this.activeTab().scored}. Only classmates with a record here are ranked; equal totals share a rank. Updates as records change.`,
  );

  constructor() {
    void this.load();
  }

  setTab(key: string): void {
    if (key === this.active()) return;
    this.active.set(key);
    void this.load();
  }

  /** Constructive framing so a lower rank reads as progress, not a verdict. */
  private encourage(rank: number, cohort: number): string {
    if (cohort <= 1) {
      return 'You’re the only ranked student here right now — a strong start.';
    }
    if (rank === 1) {
      return 'Top of the board — leading your cohort. Keep it up.';
    }
    const pct = Math.max(1, Math.round((rank / cohort) * 100));
    if (pct <= 25) {
      return `You’re in the top ${pct}% of your cohort — strong standing.`;
    }
    if (rank <= Math.ceil(cohort / 2)) {
      return 'You’re in the top half of your cohort. Keep going.';
    }
    const ahead = rank - 1;
    return `Keep going — ${ahead} ${ahead === 1 ? 'peer is' : 'peers are'} ahead. Every record you add climbs the board.`;
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
        this.cohortSize.set(0);
        return;
      }
      const body = (await res.json()) as LeaderboardResponse;
      this.optedOut.set(body.opted_out);
      this.cohortSize.set(body.cohort_size ?? 0);
      this.rows.set(body.rows ?? []);
    } catch {
      this.error.set('Could not reach the server.');
      this.rows.set([]);
      this.cohortSize.set(0);
    } finally {
      this.loading.set(false);
    }
  }

  /** Flip the leaderboard opt-out via PUT /student/leaderboard-visibility, then
   * reload so the board reflects the new state. */
  async setHidden(hidden: boolean): Promise<void> {
    if (this.savingVisibility()) return;
    this.savingVisibility.set(true);
    this.visibilityMsg.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/student/leaderboard-visibility`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden }),
      });
      if (!res.ok) {
        this.visibilityMsg.set('Could not update your visibility. Please try again.');
        return;
      }
      const body = (await res.json()) as { hidden: boolean };
      this.optedOut.set(body.hidden);
      this.visibilityMsg.set(
        body.hidden
          ? 'You’re now hidden from the leaderboards.'
          : 'You’re now visible on the leaderboards.',
      );
      await this.load();
    } catch {
      this.visibilityMsg.set('Could not reach the server.');
    } finally {
      this.savingVisibility.set(false);
    }
  }
}
