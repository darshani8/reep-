/**
 * Time Sheet — the five-bucket daily fill (design-v2 port of data-p="timesheet").
 *
 * Five activities (Sleeping / Leisure / Lectures / Coursework / Skilling — the
 * DayActivity enum on the backend), each an hours input, a live day total, and a
 * "Save today" button that upserts every bucket to POST /student/timesheet (one
 * row per bucket). Today's values are read back from GET /student/timesheet?days=1
 * — a one-day window, so `by_activity_minutes` is exactly today's totals.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

type DayActivity = 'SLEEPING' | 'LEISURE' | 'LECTURES' | 'COURSEWORK' | 'SKILLING';

interface Bucket {
  activity: DayActivity;
  icon: string;
  label: string;
}

interface TimesheetSummary {
  window_days: number;
  by_activity_minutes: Record<string, number>;
  skilling_hours: number;
  weekly_hour_target: number;
  entries: { day: string; activity: string; minutes: number }[];
}

/// The exact five, in the mockup's order — icon + label per data-p="timesheet".
const BUCKETS: readonly Bucket[] = [
  { activity: 'SLEEPING', icon: 'bedtime', label: 'Sleeping (hrs)' },
  { activity: 'LEISURE', icon: 'sports_esports', label: 'Leisure' },
  { activity: 'LECTURES', icon: 'record_voice_over', label: 'Lectures' },
  { activity: 'COURSEWORK', icon: 'edit_note', label: 'Coursework' },
  { activity: 'SKILLING', icon: 'school', label: 'Skilling' },
];

type Hours = Record<DayActivity, number>;

function emptyHours(): Hours {
  return { SLEEPING: 0, LEISURE: 0, LECTURES: 0, COURSEWORK: 0, SKILLING: 0 };
}

/// Local calendar day as YYYY-MM-DD — the backend `day` is a date, not an instant.
function todayKey(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

@Component({
  selector: 'app-student-time-log',
  standalone: true,
  templateUrl: './time-log.component.html',
  styleUrl: './time-log.component.scss',
})
export class TimeLogComponent {
  readonly buckets = BUCKETS;
  readonly today = todayKey();

  readonly hours = signal<Hours>(emptyHours());
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly saved = signal(false);
  readonly error = signal<string | null>(null);

  readonly totalHours = computed(() =>
    round1(BUCKETS.reduce((acc, b) => acc + (this.hours()[b.activity] || 0), 0)),
  );

  constructor() {
    void this.load();
  }

  hoursFor(a: DayActivity): number {
    return this.hours()[a];
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      // days=1 => a one-day window (since = today), so by_activity_minutes is today.
      const res = await fetch(`${environment.apiBase}/student/timesheet?days=1`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.error.set('Could not load today’s sheet — you can still fill it in below.');
        return;
      }
      const view = (await res.json()) as TimesheetSummary;
      const next = emptyHours();
      for (const b of BUCKETS) {
        const mins = view.by_activity_minutes?.[b.activity] ?? 0;
        next[b.activity] = round1(mins / 60);
      }
      this.hours.set(next);
    } catch {
      this.error.set('Could not reach the server — you can still fill it in and save.');
    } finally {
      this.loading.set(false);
    }
  }

  /// Controlled number input: on a valid non-negative number we update the signal;
  /// an empty / partial value is left untouched so the field is not fought while typing.
  setHours(a: DayActivity, event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n >= 0) {
      this.hours.update((h) => ({ ...h, [a]: n }));
      this.saved.set(false);
      this.error.set(null);
    }
  }

  /// Upsert all five buckets for today — one POST per (day, activity) row.
  async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.saved.set(false);
    this.error.set(null);
    const h = this.hours();
    try {
      const results = await Promise.all(
        BUCKETS.map((b) =>
          fetch(`${environment.apiBase}/student/timesheet`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              day: this.today,
              activity: b.activity,
              minutes: Math.min(1440, Math.max(0, Math.round((h[b.activity] || 0) * 60))),
            }),
          }),
        ),
      );
      if (results.every((r) => r.ok)) {
        this.saved.set(true);
      } else {
        this.error.set('Some buckets did not save — please try again.');
      }
    } catch {
      this.error.set('Could not save — check your connection and try again.');
    } finally {
      this.saving.set(false);
    }
  }
}
