/**
 * Director → Exports. The reports a placement office actually forwards, and the
 * cohort summary they are drawn from.
 *
 * The CSV is a plain same-origin `<a href>` rather than a fetch-and-blob: the
 * API is mounted under /api on this origin (proxy.conf.json in dev, one origin
 * in production), so the browser sends the httpOnly session cookie with the
 * navigation and the server's own Content-Disposition names the file. Fetching
 * it into a blob would need the filename re-invented on the client and would
 * hold the whole export in memory for no gain.
 *
 * GET /director/badges/cohort backs the summary above it — badges earned by
 * category, and the capability averages at each checkpoint. Every average is
 * NULLABLE and renders as a dash: an unassessed checkpoint and a cohort that
 * scored zero are opposite facts, and the second is never shown for the first.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface CapabilityRow {
  capability: string;
  label: string;
  averages: Record<string, number | null>;
  assessed_counts: Record<string, number>;
}

interface CohortBadges {
  students: number;
  badges_earned_by_category: Record<string, number>;
  capabilities: CapabilityRow[];
}

const CATEGORY_LABEL: Record<string, string> = {
  MANAGERIAL: 'Managerial',
  SECTORAL: 'Sectoral',
  PLATFORM: 'Platform / technical',
  THINKING: 'Thinking',
  READINESS: 'Readiness',
};

@Component({
  selector: 'app-director-exports',
  standalone: true,
  templateUrl: './exports.component.html',
})
export class DirectorExportsComponent {
  readonly apiBase = environment.apiBase;

  readonly cohort = signal<CohortBadges | null>(null);
  readonly error = signal<string | null>(null);

  /** The checkpoint columns, taken from the payload rather than hardcoded, so
   *  adding a checkpoint on the server does not silently drop a column here. */
  readonly checkpoints = computed(() => {
    const rows = this.cohort()?.capabilities ?? [];
    return rows.length ? Object.keys(rows[0].averages) : [];
  });

  readonly categories = computed(() => {
    const by = this.cohort()?.badges_earned_by_category ?? {};
    return Object.entries(by).map(([key, count]) => ({
      key,
      label: CATEGORY_LABEL[key] ?? key,
      count,
    }));
  });

  readonly totalEarned = computed(() =>
    this.categories().reduce((n, c) => n + c.count, 0),
  );

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/director/badges/cohort`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.error.set(
          res.status === 403
            ? 'Exports are for directors and admins.'
            : 'Could not load the cohort summary.',
        );
        return;
      }
      this.cohort.set((await res.json()) as CohortBadges);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }
}
