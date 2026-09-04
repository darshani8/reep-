/**
 * Director Analytics — the programme at a glance.
 *
 * GET /director/overview (headline counts + the stage split) and
 * GET /director/cohorts (one row per cohort with its student count), both
 * compute-only aggregates behind `require_director`.
 *
 * NOTHING HERE NAMES A STUDENT. The screen is deliberately built on the two
 * aggregate endpoints rather than on the roster: a director may read every
 * student's record (rule 2), but a dashboard that opens on forty names has
 * spread that data across a projector in a staff meeting for no analytical
 * gain. Names live one click away, on the screens whose job is one student.
 *
 * Every visual token comes from the global reep-v2 classes.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface Overview {
  total_students: number;
  by_stage: Record<string, number>;
  pending_offers: number;
  approved_offers: number;
  placed_students: number;
  placement_percent: number;
  open_alerts: number;
}

interface Cohort {
  id: string;
  code: string;
  name: string;
  batch_label: string;
  degree_level: string;
  student_count: number;
}

/** The programme's three stages, in programme order rather than whatever order
 *  the group-by happened to return them in. */
const STAGE_ORDER = ['REBOOT', 'EXCEL', 'ELEVATE'] as const;
const STAGE_LABEL: Record<string, string> = {
  REBOOT: 'Reboot',
  EXCEL: 'Excel',
  ELEVATE: 'Elevate',
};

@Component({
  selector: 'app-director-analytics',
  standalone: true,
  templateUrl: './analytics.component.html',
})
export class DirectorAnalyticsComponent {
  private readonly apiBase = environment.apiBase;

  readonly overview = signal<Overview | null>(null);
  readonly cohorts = signal<Cohort[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly loading = signal(true);

  /** The stage split as an ordered list with a share of the total.
   *
   *  `share` is null, never 0, when there are no students at all: a 0% bar and
   *  an "unknown, there is nobody yet" bar are different facts, and drawing the
   *  second as the first tells a director the programme is failing when it is
   *  merely empty. */
  readonly stages = computed(() => {
    const o = this.overview();
    if (!o) return [];
    const total = o.total_students;
    const keys = [
      ...STAGE_ORDER.filter((s) => s in o.by_stage),
      ...Object.keys(o.by_stage).filter((k) => !STAGE_ORDER.includes(k as never)),
    ];
    return keys.map((key) => ({
      key,
      label: STAGE_LABEL[key] ?? key,
      count: o.by_stage[key] ?? 0,
      share: total > 0 ? Math.round((100 * (o.by_stage[key] ?? 0)) / total) : null,
    }));
  });

  readonly totalCohortStudents = computed(() =>
    (this.cohorts() ?? []).reduce((sum, c) => sum + c.student_count, 0),
  );

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const [ov, co] = await Promise.all([
        fetch(`${this.apiBase}/director/overview`, { credentials: 'include' }),
        fetch(`${this.apiBase}/director/cohorts`, { credentials: 'include' }),
      ]);
      if (!ov.ok) {
        this.error.set(
          ov.status === 403
            ? 'This dashboard is for directors and admins.'
            : 'Could not load the programme overview.',
        );
        return;
      }
      this.overview.set((await ov.json()) as Overview);
      // A cohort list that fails is not worth failing the whole screen for —
      // the headline numbers above it are still true and still useful.
      if (co.ok) this.cohorts.set((await co.json()) as Cohort[]);
      else this.cohorts.set([]);
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.loading.set(false);
    }
  }
}
