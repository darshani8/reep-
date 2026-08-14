/**
 * Student jobs board — the Angular port of src/app/student/jobs/page.tsx.
 *
 * UG / PG tabs over the weekly sheet, four stat tiles, and a table with the four
 * things the spec asks for on every row: click to apply, the applied tick, the
 * match percentage, and (linking out to) the per-job CV builder. All the shaping
 * — match %, closing label, application state — is done by the NestJS
 * /api/student/jobs endpoint, so this renders ready rows.
 */

import { Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';

import { environment } from '../../../../environments/environment';
import { PageIntroComponent, SectionComponent, StatComponent, EmptyComponent, BannerComponent } from '../../../shared/kit/kit.components';
import { TONE_INK, type Tone } from '../../../shared/kit/tone';

type Level = 'UG' | 'PG';

interface JobRow {
  id: string;
  title: string;
  company: string;
  location: string;
  degreeLevel: Level;
  postedLabel: string;
  closesLabel: string;
  closesTone: Tone;
  closesSort: number;
  isClosed: boolean;
  matchPct: number | null;
  matchSort: number;
  matchLabel: string;
  matchHint: string;
  matchTone: Tone;
  applyUrl: string | null;
  applied: boolean;
  openedLabel: string | null;
  eligible: boolean;
  eligibilityReasons: string[];
}

interface JobsBoardView {
  ownLevel: Level;
  counts: Record<Level, number>;
  heldCount: number;
  verifiedSkills: number;
  eligibility: { placementEligible: boolean; latestCgpa: number | null; liveBacklogs: number; totalGapMonths: number };
  rows: JobRow[];
}

type EligibilityFilter = 'all' | 'eligible' | 'ineligible';

const LEVEL_LABEL: Record<Level, string> = { UG: 'Undergraduate', PG: 'Post Graduate' };

@Component({
  selector: 'app-student-jobs',
  standalone: true,
  imports: [DecimalPipe, PageIntroComponent, SectionComponent, StatComponent, EmptyComponent, BannerComponent],
  templateUrl: './jobs.component.html',
  styleUrl: './jobs.component.scss',
})
export class JobsComponent {
  readonly levels: Level[] = ['UG', 'PG'];
  readonly levelLabel = LEVEL_LABEL;
  readonly toneInk = TONE_INK;

  readonly view = signal<JobsBoardView | null>(null);
  readonly error = signal<string | null>(null);
  readonly level = signal<Level>('PG');
  readonly eligFilter = signal<EligibilityFilter>('all');

  readonly levelRows = computed(() => {
    const v = this.view();
    if (!v) return [];
    return v.rows.filter((r) => r.degreeLevel === this.level());
  });
  readonly visibleRows = computed(() => {
    const f = this.eligFilter();
    if (f === 'all') return this.levelRows();
    return this.levelRows().filter((r) => (f === 'eligible' ? r.eligible : !r.eligible));
  });
  readonly eligibleCount = computed(() => this.levelRows().filter((r) => r.eligible).length);
  readonly ineligibleCount = computed(() => this.levelRows().filter((r) => !r.eligible).length);
  readonly eligibility = computed(() => this.view()?.eligibility ?? null);
  readonly openRows = computed(() => this.levelRows().filter((r) => !r.isClosed));
  readonly appliedCount = computed(() => this.levelRows().filter((r) => r.applied).length);
  readonly strongCount = computed(() => this.openRows().filter((r) => (r.matchPct ?? 0) >= 70).length);
  readonly closingSoon = computed(() => this.openRows().filter((r) => r.closesSort <= 7).length);
  readonly closedCount = computed(() => this.levelRows().length - this.openRows().length);

  setEligFilter(f: EligibilityFilter): void {
    this.eligFilter.set(f);
  }

  readonly ownLevel = computed(() => this.view()?.ownLevel ?? 'PG');
  readonly heldCount = computed(() => this.view()?.heldCount ?? 0);
  readonly verifiedSkills = computed(() => this.view()?.verifiedSkills ?? 0);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/jobs`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set('Could not load the jobs board.');
        return;
      }
      const view = (await res.json()) as JobsBoardView;
      this.view.set(view);
      this.level.set(view.ownLevel);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  setLevel(level: Level): void {
    this.level.set(level);
  }

  count(level: Level): number {
    return this.view()?.counts[level] ?? 0;
  }

  otherLevel(): Level {
    return this.level() === 'UG' ? 'PG' : 'UG';
  }

  /// Open the employer link and record the intent (never a claim).
  openApply(row: JobRow): void {
    if (row.applyUrl) window.open(row.applyUrl, '_blank', 'noopener');
    void fetch(`${environment.apiBase}/student/jobs/${row.id}/open`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!row.openedLabel && !row.applied) {
      // Reflect the intent locally without a reload.
      this.patch(row.id, { openedLabel: 'Opened just now' });
    }
  }

  /// The student's own tick. Writes selfReported=true, or deletes the row.
  async toggleApplied(row: JobRow): Promise<void> {
    const applied = !row.applied;
    this.patch(row.id, { applied });
    try {
      await fetch(`${environment.apiBase}/student/jobs/${row.id}/apply`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applied }),
      });
    } catch {
      this.patch(row.id, { applied: !applied }); // revert on failure
    }
  }

  private patch(id: string, change: Partial<JobRow>): void {
    const v = this.view();
    if (!v) return;
    this.view.set({ ...v, rows: v.rows.map((r) => (r.id === id ? { ...r, ...change } : r)) });
  }
}
