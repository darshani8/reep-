/**
 * The Time Allocation Ledger — six slots covering a 24-hour day, five activity
 * heads, hours to the nearest half.
 *
 * THE SERVER OWNS THE ARITHMETIC. The metrics strip, the day band's proportions,
 * the per-slot mix bars, the legend totals and the submit gate all arrive
 * computed from `GET /api/student/ledger`; this component types figures into
 * cells, PUTs them, and renders what comes back. Deriving any of it a second
 * time in TypeScript is how a band ends up disagreeing with the number printed
 * above it — see the note at the top of app/routers/student_programme.py.
 *
 * EDITS ARE LOCAL UNTIL SAVED. `draft` holds what the student has typed; the
 * server's view is only replaced on a successful write. Re-rendering the whole
 * table from a response on every keystroke would move focus out of the cell
 * being typed in, and a PUT per keystroke would make the slot-capacity rule —
 * which is a property of the whole day — fire on half-typed numbers.
 */

import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

import { environment } from '../../../../environments/environment';

type Tone = 'good' | 'warn' | 'risk' | 'neutral';

interface Segment {
  activity: string | null;
  label: string;
  colour: string | null;
  hours: number;
  percent: number;
}

interface Slot {
  key: string;
  label: string;
  icon: string | null;
  tick: string;
  capacity_hours: number;
  logged_hours: number;
  weight: number;
  state_label: string;
  state_tone: Tone;
  cells: Record<string, number>;
  mix: Segment[];
}

interface Metric {
  key: string;
  label: string;
  value: string;
  unit: string;
  sub: string;
  tone: Tone;
}

interface Activity {
  key: string;
  label: string;
  colour: string;
  productive: boolean;
}

interface Legend {
  activity: string | null;
  label: string;
  colour: string | null;
  hours: number;
}

interface Ledger {
  day: string;
  status: 'DRAFT' | 'SUBMITTED';
  submitted_at: string | null;
  can_submit: boolean;
  submit_blocked_reason: string | null;
  total_hours: number;
  day_capacity_hours: number;
  unaccounted_hours: number;
  activities: Activity[];
  slots: Slot[];
  metrics: Metric[];
  legend: Legend[];
}

/** `GET /api/student/timesheet` — the OTHER time table.
 *
 *  `time_sheet_entries` answers "how many SKILLING hours this week, against the
 *  target", which is a different question from the ledger's "what did the 24
 *  hours of Thursday look like" and is stored in a different table. It used to
 *  have its own screen; carrying a whole route for one number was worse than
 *  showing the number here, beside the day it is accumulated from. */
interface WeeklySkilling {
  skilling_hours: number;
  weekly_hour_target: number;
}

type State = 'loading' | 'data' | 'error';

@Component({
  selector: 'app-ledger',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './ledger.component.html',
})
export class LedgerComponent {
  readonly state = signal<State>('loading');
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  readonly ledger = signal<Ledger | null>(null);
  readonly day = signal<string>(todayIso());

  /** What the student has typed, keyed `SLOT|ACTIVITY`. Cleared on every load
   *  so a stale edit cannot survive a date change. */
  private readonly draft = signal<Record<string, number>>({});
  readonly dirty = computed(() => Object.keys(this.draft()).length > 0);

  readonly submitted = computed(() => this.ledger()?.status === 'SUBMITTED');

  readonly weekly = signal<WeeklySkilling | null>(null);
  readonly weeklyPercent = computed(() => {
    const w = this.weekly();
    if (!w || w.weekly_hour_target <= 0) return 0;
    return Math.min(100, Math.round((w.skilling_hours / w.weekly_hour_target) * 100));
  });

  constructor() {
    void this.load();
    void this.loadWeekly();
  }

  // --- reads ---------------------------------------------------------------

  /** Independent of the ledger's own state: a failure here hides one strip,
   *  it does not put the ledger into an error state over a summary. */
  private async loadWeekly(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/timesheet?days=7`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      this.weekly.set((await res.json()) as WeeklySkilling);
    } catch {
      /* no strip */
    }
  }

  async load(): Promise<void> {
    this.state.set('loading');
    this.error.set(null);
    this.draft.set({});
    try {
      const res = await fetch(
        `${environment.apiBase}/student/ledger?day=${encodeURIComponent(this.day())}`,
        { credentials: 'include' },
      );
      if (!res.ok) throw new Error(String(res.status));
      this.ledger.set((await res.json()) as Ledger);
      this.state.set('data');
    } catch {
      this.state.set('error');
    }
  }

  step(days: number): void {
    const next = new Date(`${this.day()}T00:00:00`);
    next.setDate(next.getDate() + days);
    const iso = next.toISOString().slice(0, 10);
    // A day that has not happened yet cannot be logged, and the server refuses
    // it — so the control refuses first rather than showing a 422.
    if (iso > todayIso()) return;
    this.day.set(iso);
    void this.load();
  }

  get atToday(): boolean {
    return this.day() >= todayIso();
  }

  // --- editing -------------------------------------------------------------

  /** The value a cell should show: the local edit if there is one, else the
   *  server's figure. */
  cellValue(slot: Slot, activity: string): number {
    const key = `${slot.key}|${activity}`;
    const local = this.draft()[key];
    return local ?? slot.cells[activity] ?? 0;
  }

  onCellInput(slot: Slot, activity: string, raw: string): void {
    const parsed = Number.parseFloat(raw);
    const hours = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    this.draft.update((d) => ({ ...d, [`${slot.key}|${activity}`]: hours }));
  }

  /** The running total for a slot as edited, so the "/4" figure and the chip
   *  respond while typing rather than only after a save. This is presentation
   *  of the student's own unsaved input — not a second copy of the server's
   *  arithmetic, which still decides everything on write. */
  slotTotal(slot: Slot): number {
    const acts = this.ledger()?.activities ?? [];
    return acts.reduce((sum, a) => sum + this.cellValue(slot, a.key), 0);
  }

  /** A column's running total across the six slots, for the footer row. Same
   *  reasoning as slotTotal: presentation of unsaved input, not a second copy
   *  of the server's arithmetic. */
  columnTotal(activity: string): number {
    const l = this.ledger();
    if (!l) return 0;
    return l.slots.reduce((sum, s) => sum + this.cellValue(s, activity), 0);
  }

  dayTotal(): number {
    const l = this.ledger();
    if (!l) return 0;
    return l.slots.reduce((sum, s) => sum + this.slotTotal(s), 0);
  }

  // --- writes --------------------------------------------------------------

  private cellsPayload(): { slot: string; activity: string; hours: number }[] {
    const l = this.ledger();
    if (!l) return [];
    const out: { slot: string; activity: string; hours: number }[] = [];
    for (const slot of l.slots) {
      for (const a of l.activities) {
        const hours = this.cellValue(slot, a.key);
        if (hours > 0) out.push({ slot: slot.key, activity: a.key, hours });
      }
    }
    return out;
  }

  private async write(path: string, body: unknown, method = 'POST'): Promise<boolean> {
    this.saving.set(true);
    this.error.set(null);
    try {
      const res = await fetch(`${environment.apiBase}${path}`, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // The server's `detail` names the slot and the number — it is written to
        // be read by a student, so it is shown verbatim rather than replaced
        // with a generic failure line.
        const detail = await res
          .json()
          .then((b: { detail?: string }) => b.detail)
          .catch(() => null);
        this.error.set(detail || 'That could not be saved. Please try again.');
        return false;
      }
      this.ledger.set((await res.json()) as Ledger);
      this.draft.set({});
      return true;
    } catch {
      this.error.set('Could not reach the server. Please try again.');
      return false;
    } finally {
      this.saving.set(false);
    }
  }

  save(): Promise<boolean> {
    return this.write('/student/ledger', { day: this.day(), cells: this.cellsPayload() }, 'PUT');
  }

  /** Save first, then submit. Submitting what is on screen rather than what was
   *  last written is the only behaviour that matches the button's label. */
  async submitDay(): Promise<void> {
    if (this.dirty() && !(await this.save())) return;
    await this.write('/student/ledger/submit', { day: this.day() });
  }

  // --- helpers used by the template ---------------------------------------

  trackKey = (_: number, item: { key: string }) => item.key;
}

function todayIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}
