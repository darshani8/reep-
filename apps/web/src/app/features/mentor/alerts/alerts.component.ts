/**
 * Faculty → Alerts. The rules that fired on the students this staff member may
 * see, and the one control that closes them.
 *
 * GET /mentor/alerts?open_only= and POST /mentor/alerts/{id}/resolve. Both are
 * rule-2 scoped on the server — a MENTOR sees only their own group's alerts and
 * `_assert_can_access_student` re-checks on the resolve, so the button cannot
 * reach an alert the list would not have shown.
 *
 * Resolved alerts are readable (the toggle), because "who closed this, and
 * when" is the question asked after the fact. They are never re-openable from
 * here: the API has no un-resolve, and offering the control would be a button
 * that always fails.
 */

import { Component, computed, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

import { environment } from '../../../../environments/environment';

interface Alert {
  id: string;
  student_id: string;
  student_name: string;
  rule_triggered: string;
  severity: string;
  message: string;
  triggered_at: string;
  resolved: boolean;
}

@Component({
  selector: 'app-mentor-alerts',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './alerts.component.html',
})
export class MentorAlertsComponent {
  private readonly apiBase = environment.apiBase;

  readonly alerts = signal<Alert[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly showResolved = signal(false);

  readonly resolvingId = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);

  readonly openCount = computed(() => (this.alerts() ?? []).filter((a) => !a.resolved).length);
  readonly criticalCount = computed(
    () => (this.alerts() ?? []).filter((a) => !a.resolved && a.severity === 'CRITICAL').length,
  );

  readonly visible = computed(() =>
    (this.alerts() ?? []).filter((a) => this.showResolved() || !a.resolved),
  );

  constructor() {
    void this.load();
  }

  async toggleResolved(): Promise<void> {
    this.showResolved.update((v) => !v);
    await this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(
        `${this.apiBase}/mentor/alerts?open_only=${this.showResolved() ? 'false' : 'true'}`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        this.error.set(
          res.status === 403
            ? 'Alerts are for mentors, directors and admins.'
            : 'Could not load alerts.',
        );
        return;
      }
      this.error.set(null);
      this.alerts.set((await res.json()) as Alert[]);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  async resolve(a: Alert): Promise<void> {
    this.resolvingId.set(a.id);
    this.actionError.set(null);
    try {
      const res = await fetch(`${this.apiBase}/mentor/alerts/${a.id}/resolve`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { detail?: string } | null;
        this.actionError.set(detail?.detail ?? 'Could not resolve that alert.');
        return;
      }
      await this.load();
    } catch {
      this.actionError.set('Could not reach the server.');
    } finally {
      this.resolvingId.set(null);
    }
  }

  /** Severity as a chip tone. Text always accompanies it — the severity word is
   *  rendered beside the colour, never replaced by it. */
  tone(severity: string): 'risk' | 'warn' | 'neutral' {
    if (severity === 'CRITICAL') return 'risk';
    if (severity === 'WARNING') return 'warn';
    return 'neutral';
  }

  /** The rule key as a sentence. An unmapped key falls through to the raw
   *  value rather than to a blank — a new server-side rule must be legible on
   *  the day it ships, not on the day this map is updated. */
  ruleLabel(key: string): string {
    return key
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/^./, (c) => c.toUpperCase());
  }
}
