/**
 * The five-bucket day sheet — the Angular port of /student/time-log.
 *
 * Exactly five activities, each a 30-minute stepper, a live "X remaining of 24"
 * readout, day navigation and copy-yesterday, saving to /api/student/timesheet.
 * Over 24h blocks the save; under 24h warns but saves — the sheet must never be
 * a wall (see rules.ts).
 */

import { Component, computed, inject, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';
import { PageIntroComponent, SectionComponent } from '../../../shared/kit/kit.components';
import {
  DAY_ACTIVITIES, emptySheet, hm, isOver, remainingLabel, remainingMinutes, sheetTotal,
  shiftKey, stepMinutes, todayKey, type DayActivity, type DaySheet,
} from './rules';

@Component({
  selector: 'app-student-time-log',
  standalone: true,
  imports: [PageIntroComponent, SectionComponent],
  templateUrl: './time-log.component.html',
  styleUrl: './time-log.component.scss',
})
export class TimeLogComponent {
  readonly activities = DAY_ACTIVITIES;

  readonly day = signal<string>(todayKey());
  readonly sheet = signal<DaySheet>(emptySheet());
  readonly saving = signal(false);
  readonly saved = signal(false);
  readonly error = signal<string | null>(null);
  readonly loaded = signal(false);

  private yesterdaySheet: DaySheet | null = null;

  readonly total = computed(() => sheetTotal(this.sheet()));
  readonly remaining = computed(() => remainingMinutes(this.sheet()));
  readonly remainingText = computed(() => remainingLabel(this.sheet()));
  readonly over = computed(() => isOver(this.sheet()));
  readonly isToday = computed(() => this.day() === todayKey());

  constructor() {
    void this.load(this.day());
  }

  hm = hm;

  minutesFor(a: DayActivity): number {
    return this.sheet()[a];
  }
  hoursLabel(a: DayActivity): string {
    return hm(this.sheet()[a]);
  }

  private async load(day: string): Promise<void> {
    this.saved.set(false);
    this.error.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/student/timesheet?day=${day}`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set('Could not load this day.');
        return;
      }
      const view = (await res.json()) as { day: string; minutes: DaySheet };
      this.sheet.set({ ...emptySheet(), ...view.minutes });
      this.loaded.set(true);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }

  step(a: DayActivity, dir: 1 | -1): void {
    const next = stepMinutes(this.sheet()[a], dir);
    this.sheet.set({ ...this.sheet(), [a]: next });
    this.saved.set(false);
  }

  async goDay(days: number): Promise<void> {
    // Cache the day being left so "copy yesterday" has a source after a move.
    if (days === 1) this.yesterdaySheet = this.sheet();
    this.day.set(shiftKey(this.day(), days));
    await this.load(this.day());
  }

  async copyYesterday(): Promise<void> {
    const res = await fetch(`${environment.apiBase}/student/timesheet?day=${shiftKey(this.day(), -1)}`, { credentials: 'include' });
    if (!res.ok) return;
    const view = (await res.json()) as { minutes: DaySheet };
    this.sheet.set({ ...emptySheet(), ...view.minutes });
    this.saved.set(false);
  }

  async save(): Promise<void> {
    if (this.over() || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/student/timesheet`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ day: this.day(), minutes: this.sheet() }),
      });
      if (res.ok) {
        this.saved.set(true);
      } else {
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        this.error.set(j.message ?? 'Could not save this day.');
      }
    } finally {
      this.saving.set(false);
    }
  }
}
