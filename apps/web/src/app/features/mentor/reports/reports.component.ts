/**
 * Faculty → Reports. What a mentor's group looks like in aggregate, built from
 * the scoped endpoints the rest of the faculty area already uses.
 *
 * There is no "mentor reports" endpoint and this screen does not invent one: it
 * composes GET /mentor/mentees, /mentor/alerts and /mentor/uploads/pending —
 * each already rule-2 scoped — into the counts a mentor is actually asked for.
 * A number here is therefore always exactly the rows the mentor may see, and a
 * MENTOR with no group reports zeros against an explicit "you have no group"
 * line rather than the programme's totals.
 *
 * The stage and semester breakdowns are derived on the client from the same
 * roster the Students screen lists, so the two can never disagree.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface Mentee {
  student_id: string;
  name: string;
  usn: string | null;
  current_stage: string;
  current_semester: number;
}

interface Alert {
  id: string;
  student_id: string;
  severity: string;
  rule_triggered: string;
  resolved: boolean;
}

interface PendingUpload {
  id: string;
  student_id: string;
}

@Component({
  selector: 'app-mentor-reports',
  standalone: true,
  templateUrl: './reports.component.html',
})
export class MentorReportsComponent {
  private readonly apiBase = environment.apiBase;

  readonly mentees = signal<Mentee[] | null>(null);
  readonly alerts = signal<Alert[] | null>(null);
  readonly uploads = signal<PendingUpload[] | null>(null);
  readonly error = signal<string | null>(null);

  readonly hasGroup = computed(() => (this.mentees()?.length ?? 0) > 0);

  readonly byStage = computed(() => this.tally((m) => m.current_stage));
  readonly bySemester = computed(() =>
    this.tally((m) => `Semester ${m.current_semester}`).sort((a, b) =>
      a.key.localeCompare(b.key, undefined, { numeric: true }),
    ),
  );

  readonly byRule = computed(() => {
    const counts = new Map<string, number>();
    for (const a of this.alerts() ?? []) {
      if (a.resolved) continue;
      counts.set(a.rule_triggered, (counts.get(a.rule_triggered) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([key, count]) => ({ key, label: this.ruleLabel(key), count }))
      .sort((a, b) => b.count - a.count);
  });

  /** Students carrying at least one open alert — the number a mentor's week is
   *  actually sized by. Distinct students, not alerts: one student with four
   *  alerts is one conversation. */
  readonly studentsWithAlerts = computed(
    () => new Set((this.alerts() ?? []).filter((a) => !a.resolved).map((a) => a.student_id)).size,
  );

  readonly openAlerts = computed(() => (this.alerts() ?? []).filter((a) => !a.resolved).length);

  constructor() {
    void this.load();
  }

  private tally(key: (m: Mentee) => string): { key: string; count: number; share: number }[] {
    const list = this.mentees() ?? [];
    const counts = new Map<string, number>();
    for (const m of list) counts.set(key(m), (counts.get(key(m)) ?? 0) + 1);
    return [...counts.entries()].map(([k, count]) => ({
      key: k,
      count,
      share: list.length ? Math.round((100 * count) / list.length) : 0,
    }));
  }

  private async load(): Promise<void> {
    try {
      const [m, a, u] = await Promise.all([
        fetch(`${this.apiBase}/mentor/mentees`, { credentials: 'include' }),
        fetch(`${this.apiBase}/mentor/alerts?open_only=true`, { credentials: 'include' }),
        fetch(`${this.apiBase}/mentor/uploads/pending`, { credentials: 'include' }),
      ]);
      if (!m.ok) {
        this.error.set(
          m.status === 403
            ? 'Reports are for mentors, directors and admins.'
            : 'Could not load your group.',
        );
        return;
      }
      this.mentees.set((await m.json()) as Mentee[]);
      this.alerts.set(a.ok ? ((await a.json()) as Alert[]) : []);
      this.uploads.set(u.ok ? ((await u.json()) as PendingUpload[]) : []);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  ruleLabel(key: string): string {
    return key.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
  }
}
