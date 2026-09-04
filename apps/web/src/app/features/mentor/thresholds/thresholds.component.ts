/**
 * Thresholds — the per-cohort alert rules, editable without a deploy.
 *
 * GET /director/alert-rules?cohort_id= and PUT /director/alert-rules (an upsert
 * on the (cohort, rule) pair). DIRECTOR/ADMIN only, which is why the screen
 * lives in the director navigation even though the alerts it tunes are a
 * mentor's daily work — the API gate is `require_director` and a screen offered
 * to mentors would be a form that always 403s.
 *
 * `params` IS FREE-FORM JSON ON THE SERVER, and the editor deliberately does
 * not pretend otherwise. Each rule declares the one number it actually reads
 * (`days`, `minAttendancePct`, `graceDays`, …) and the form edits THAT under a
 * plain-language label, because a director typing raw JSON into a production
 * threshold is how a cohort ends up with `{"day": 5}` and an alert that never
 * fires again. A rule this file does not recognise still renders — as its raw
 * JSON, editable — rather than disappearing, so a new server-side rule is
 * tunable on the day it ships.
 */

import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';

interface AlertRule {
  id: string;
  cohort_id: string;
  rule_key: string;
  enabled: boolean;
  params: Record<string, unknown>;
  severity: string;
}

interface Cohort {
  id: string;
  code: string;
  name: string;
  batch_label: string;
}

interface RuleSpec {
  label: string;
  description: string;
  param: string;
  paramLabel: string;
  unit: string;
}

/** The one number each rule reads, and what it means. Keys mirror the seeds in
 *  app/seed.py and the rule engine's own reads. */
const RULE_SPECS: Record<string, RuleSpec> = {
  NO_CHECKIN_N_DAYS: {
    label: 'No check-in',
    description: 'Fires when a student has not checked in for this many days.',
    param: 'days',
    paramLabel: 'Days without a check-in',
    unit: 'days',
  },
  PACE_BELOW_THRESHOLD: {
    label: 'Pace below target',
    description: 'Fires when weekly hours fall this far below the student’s target.',
    param: 'deviationPct',
    paramLabel: 'Deviation below target',
    unit: '%',
  },
  ATTENDANCE_BELOW_THRESHOLD: {
    label: 'Attendance below threshold',
    description: 'Fires when attendance drops under this percentage.',
    param: 'minAttendancePct',
    paramLabel: 'Minimum attendance',
    unit: '%',
  },
  CERT_OVERDUE: {
    label: 'Certification overdue',
    description: 'Fires this many days after a certification’s due date passes.',
    param: 'graceDays',
    paramLabel: 'Grace period',
    unit: 'days',
  },
  LOW_FOCUS_QUALITY: {
    label: 'Low focus quality',
    description: 'Fires when focus-session quality falls under this score.',
    param: 'minQuality',
    paramLabel: 'Minimum quality',
    unit: 'score',
  },
};

const SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'];

@Component({
  selector: 'app-thresholds',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './thresholds.component.html',
})
export class ThresholdsComponent {
  private readonly apiBase = environment.apiBase;

  readonly cohorts = signal<Cohort[] | null>(null);
  readonly rules = signal<AlertRule[] | null>(null);
  readonly error = signal<string | null>(null);

  readonly cohortId = signal<string>('');
  readonly severities = SEVERITIES;
  readonly ruleKeys = Object.keys(RULE_SPECS);

  readonly savingKey = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);
  readonly flash = signal<string | null>(null);

  /** Draft values keyed by rule key, so editing one row never touches another
   *  and a reload cannot discard an unsaved number mid-keystroke. */
  readonly drafts = signal<
    Record<string, { value: string; severity: string; enabled: boolean; raw: string }>
  >({});

  /** Every rule the server knows, with the cohort's row if it has one — a rule
   *  with NO row is not configured for this cohort and says so, rather than
   *  vanishing from a list a director is using to check coverage. */
  readonly rows = computed(() => {
    const configured = this.rules() ?? [];
    const known = this.ruleKeys.map((key) => ({
      key,
      spec: RULE_SPECS[key],
      rule: configured.find((r) => r.rule_key === key) ?? null,
    }));
    const unknown = configured
      .filter((r) => !(r.rule_key in RULE_SPECS))
      .map((r) => ({ key: r.rule_key, spec: null, rule: r }));
    return [...known, ...unknown];
  });

  constructor() {
    void this.loadCohorts();
  }

  private async loadCohorts(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/director/cohorts`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set(
          res.status === 403
            ? 'Alert thresholds are for directors and admins.'
            : 'Could not load cohorts.',
        );
        return;
      }
      const list = (await res.json()) as Cohort[];
      this.cohorts.set(list);
      if (list.length) {
        this.cohortId.set(list[0].id);
        await this.loadRules();
      } else {
        this.rules.set([]);
      }
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  async selectCohort(id: string): Promise<void> {
    this.cohortId.set(id);
    this.drafts.set({});
    this.rules.set(null);
    await this.loadRules();
  }

  private async loadRules(): Promise<void> {
    const id = this.cohortId();
    if (!id) return;
    try {
      const res = await fetch(
        `${this.apiBase}/director/alert-rules?cohort_id=${encodeURIComponent(id)}`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        this.error.set('Could not load the alert rules for that cohort.');
        return;
      }
      this.error.set(null);
      this.rules.set((await res.json()) as AlertRule[]);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  /** The current draft for a rule, seeded from the saved row (or the rule's
   *  defaults when the cohort has no row for it yet). */
  draft(key: string): { value: string; severity: string; enabled: boolean; raw: string } {
    const existing = this.drafts()[key];
    if (existing) return existing;
    const row = this.rows().find((r) => r.key === key);
    const rule = row?.rule ?? null;
    const spec = row?.spec ?? null;
    const value = spec && rule ? String(rule.params?.[spec.param] ?? '') : '';
    return {
      value,
      severity: rule?.severity ?? 'WARNING',
      enabled: rule?.enabled ?? true,
      raw: rule ? JSON.stringify(rule.params ?? {}) : '{}',
    };
  }

  patchDraft(key: string, patch: Partial<ReturnType<ThresholdsComponent['draft']>>): void {
    const current = this.draft(key);
    this.drafts.update((m) => ({ ...m, [key]: { ...current, ...patch } }));
  }

  async save(key: string): Promise<void> {
    const cohortId = this.cohortId();
    if (!cohortId) return;
    const row = this.rows().find((r) => r.key === key);
    const draft = this.draft(key);
    let params: Record<string, unknown>;
    if (row?.spec) {
      const n = Number(draft.value);
      if (draft.value.trim() === '' || Number.isNaN(n)) {
        this.saveError.set(`${row.spec.paramLabel} must be a number.`);
        return;
      }
      params = { [row.spec.param]: n };
    } else {
      try {
        params = JSON.parse(draft.raw) as Record<string, unknown>;
      } catch {
        this.saveError.set('That is not valid JSON.');
        return;
      }
    }

    this.savingKey.set(key);
    this.saveError.set(null);
    try {
      const res = await fetch(`${this.apiBase}/director/alert-rules`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cohort_id: cohortId,
          rule_key: key,
          params,
          enabled: draft.enabled,
          severity: draft.severity,
        }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { detail?: string } | null;
        this.saveError.set(detail?.detail ?? 'Could not save that threshold.');
        return;
      }
      this.flash.set(`${row?.spec?.label ?? key} saved.`);
      setTimeout(() => this.flash.set(null), 3000);
      this.drafts.update((m) => {
        const next = { ...m };
        delete next[key];
        return next;
      });
      await this.loadRules();
    } catch {
      this.saveError.set('Could not reach the server.');
    } finally {
      this.savingKey.set(null);
    }
  }
}
