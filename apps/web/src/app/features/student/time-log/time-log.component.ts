/**
 * Time Sheet — the five-bucket daily fill (design-v2 port of data-p="timesheet").
 *
 * Five activities (Sleeping / Leisure / Lectures / Coursework / Skilling — the
 * DayActivity enum on the backend), each an hours input, a live 24-hour total
 * (stacked bar + "X / 24 h"), and a contextual Save button that upserts every
 * bucket to POST /student/timesheet (one row per bucket). Today's values are read
 * back from GET /student/timesheet?days=1 — a one-day window, so
 * `by_activity_minutes` is exactly today's totals.
 *
 * The five buckets describe one calendar day, so their hours should not overlap:
 * a valid day totals at or under 24 h. Each input is bounded to 0–24 h, an
 * out-of-range cell is flagged inline, and a total above 24 h raises a risk chip.
 */

import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

type DayActivity = 'SLEEPING' | 'LEISURE' | 'LECTURES' | 'COURSEWORK' | 'SKILLING';

interface Bucket {
  activity: DayActivity;
  icon: string;
  label: string;
  short: string;
  color: string;
}

interface TimesheetSummary {
  window_days: number;
  by_activity_minutes: Record<string, number>;
  skilling_hours: number;
  weekly_hour_target: number;
  entries: { day: string; activity: string; minutes: number }[];
}

/// One activity may not sensibly exceed a single day, and the five together
/// describe that same day — so both a cell and the total are bounded by 24 h.
const DAY_HOURS = 24;

/// The exact five, in the mockup's order — icon + label per data-p="timesheet".
/// Each carries a warm swatch used by the stacked bar and its legend.
const BUCKETS: readonly Bucket[] = [
  { activity: 'SLEEPING', icon: 'bedtime', label: 'Sleeping (hrs)', short: 'Sleeping', color: 'var(--ink-400)' },
  { activity: 'LEISURE', icon: 'sports_esports', label: 'Leisure', short: 'Leisure', color: 'var(--amber-300)' },
  { activity: 'LECTURES', icon: 'record_voice_over', label: 'Lectures', short: 'Lectures', color: 'var(--amber-400)' },
  { activity: 'COURSEWORK', icon: 'edit_note', label: 'Coursework', short: 'Coursework', color: 'var(--amber-600)' },
  { activity: 'SKILLING', icon: 'school', label: 'Skilling', short: 'Skilling', color: 'var(--good)' },
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

/// A bar segment carries the display width and its bucket colour.
interface Segment extends Bucket {
  hours: number;
  pct: number;
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
  readonly dayHours = DAY_HOURS;

  readonly hours = signal<Hours>(emptyHours());
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  /// Editing since the last load/save (drives the contextual Save label).
  readonly dirty = signal(false);
  /// The moment the last successful save landed — powers "Saved today at H:MM PM".
  readonly savedAt = signal<Date | null>(null);

  readonly totalHours = computed(() =>
    round1(BUCKETS.reduce((acc, b) => acc + (this.hours()[b.activity] || 0), 0)),
  );

  /// Cells whose value runs past a single day — flagged and capped on save.
  readonly overCells = computed(() => BUCKETS.filter((b) => this.hours()[b.activity] > DAY_HOURS));

  /// The whole day overflows 24 h — the buckets shouldn't overlap, so this is wrong.
  readonly overDay = computed(() => this.totalHours() > DAY_HOURS);

  /// Bar denominator: a full 24 h until the day itself runs longer, so the
  /// segments always sum to the track and the 24 h marker shows the boundary.
  private readonly denom = computed(() => Math.max(DAY_HOURS, this.totalHours()) || DAY_HOURS);

  readonly segments = computed<Segment[]>(() =>
    BUCKETS.map((b) => {
      const hrs = this.hours()[b.activity] || 0;
      return { ...b, hours: round1(hrs), pct: (hrs / this.denom()) * 100 };
    }),
  );

  /// Where the 24 h mark sits on the track (right edge until the day runs over).
  readonly markerPct = computed(() => Math.min(100, (DAY_HOURS / this.denom()) * 100));

  readonly overCellNote = computed(() => {
    const names = this.overCells().map((b) => b.short);
    if (!names.length) return '';
    const list = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names.at(-1);
    return `${list} ${names.length === 1 ? 'is' : 'are'} over 24 h — each activity is capped at a 24-hour day when saved.`;
  });

  readonly saveLabel = computed(() => {
    if (this.saving()) return 'Saving…';
    if (this.dirty()) {
      const n = this.totalHours();
      return `Save ${n} hour${n === 1 ? '' : 's'}`;
    }
    const at = this.savedAt();
    if (at) return `Saved today at ${this.formatTime(at)}`;
    return 'Save today';
  });

  constructor() {
    void this.load();
  }

  hoursFor(a: DayActivity): number {
    return this.hours()[a];
  }

  private formatTime(d: Date): string {
    // "H:MM PM" — hour without a leading zero, minutes padded.
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
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
      this.dirty.set(false);
      this.savedAt.set(null);
    } catch {
      this.error.set('Could not reach the server — you can still fill it in and save.');
    } finally {
      this.loading.set(false);
    }
  }

  /// Controlled number input: on a valid non-negative number we update the signal;
  /// an empty / partial value is left untouched so the field is not fought while
  /// typing. Out-of-range values (> 24) are kept so the cell can be flagged — they
  /// are clamped to a 24-hour day only when saved.
  setHours(a: DayActivity, event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n >= 0) {
      this.hours.update((h) => ({ ...h, [a]: n }));
      this.dirty.set(true);
      this.error.set(null);
    }
  }

  /// Upsert all five buckets for today — one POST per (day, activity) row. Each
  /// bucket is clamped to a 24-hour day (0–1440 min) so an over-range cell can
  /// never persist more than a full day.
  async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
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
        this.savedAt.set(new Date());
        this.dirty.set(false);
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
