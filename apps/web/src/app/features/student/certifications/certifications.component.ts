/**
 * Student certifications — the "Certification Tracker" rebuilt as a PROGRESS PLAN.
 *
 * Each certification the student is mapped to becomes a warm v2 card that answers
 * "where am I and what's next": a % progress bar, the single NEXT TASK, the due
 * date (with a "Due in N days" read-out), the estimated hours remaining, a
 * "Continue" CTA and an "Unlocks: …" line. All data is shaped by
 * GET /student/certifications (enriched CertProgressOut); this only paints the
 * flat rows against the global reep-v2 classes plus a scoped progress bar.
 */

import { Component, computed, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';

/** One row exactly as GET /student/certifications returns it (snake_case). */
interface CertRow {
  code: string;
  name: string;
  provider: string;
  status: string;
  progress_pct: number;
  hours_logged: number;
  required_hours: number;
  due_date: string;
  self_reported: boolean;
  est_hours_remaining: number;
  days_until_due: number | null;
  next_task: string;
  unlocks: string;
}

/** The status chip: class matches a global .chip modifier (good/warn/risk). */
interface Chip {
  cls: 'good' | 'warn' | 'risk';
  icon: string;
  label: string;
}

interface DisplayRow extends CertRow {
  chip: Chip;
  /** Bar tone tracks status so colour is never the only signal. */
  barCls: 'good' | 'warn' | 'risk';
  dueText: string;
  dueCls: 'good' | 'warn' | 'risk';
}

/** status -> status chip. COMPLETED=good, IN_PROGRESS/NOT_STARTED=warn, OVERDUE=risk. */
const CHIP: Record<string, Chip> = {
  COMPLETED: { cls: 'good', icon: 'check_circle', label: 'Complete' },
  IN_PROGRESS: { cls: 'warn', icon: 'schedule', label: 'In progress' },
  OVERDUE: { cls: 'risk', icon: 'error', label: 'Overdue' },
  NOT_STARTED: { cls: 'warn', icon: 'radio_button_unchecked', label: 'Not started' },
};

@Component({
  selector: 'app-student-certifications',
  standalone: true,
  imports: [DecimalPipe, DatePipe, RouterLink],
  templateUrl: './certifications.component.html',
  styleUrl: './certifications.component.scss',
})
export class CertificationsComponent {
  private readonly rows = signal<CertRow[] | null>(null);
  readonly error = signal<string | null>(null);

  /// Rows enriched with the chip + human-friendly due read-out, or null while loading.
  readonly view = computed<DisplayRow[] | null>(() => {
    const list = this.rows();
    if (!list) return null;
    return list.map((r) => {
      const chip = CHIP[r.status] ?? { cls: 'warn' as const, icon: 'help', label: r.status };
      return {
        ...r,
        chip,
        barCls: chip.cls,
        ...this.dueReadout(r),
      };
    });
  });

  readonly completedCount = computed(
    () => this.rows()?.filter((r) => r.status === 'COMPLETED').length ?? 0,
  );

  constructor() {
    void this.load();
  }

  /** Turn days_until_due into a coloured "Due in N days" line (never colour-only). */
  private dueReadout(r: CertRow): { dueText: string; dueCls: 'good' | 'warn' | 'risk' } {
    if (r.status === 'COMPLETED') return { dueText: 'Completed', dueCls: 'good' };
    const d = r.days_until_due;
    if (d === null || d === undefined) return { dueText: 'No due date', dueCls: 'warn' };
    if (d < 0)
      return {
        dueText: `Overdue by ${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'}`,
        dueCls: 'risk',
      };
    if (d === 0) return { dueText: 'Due today', dueCls: 'risk' };
    if (d <= 7) return { dueText: `Due in ${d} days`, dueCls: 'warn' };
    return { dueText: `Due in ${d} days`, dueCls: 'good' };
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/student/certifications`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.error.set('Could not load your certifications.');
        return;
      }
      this.rows.set((await res.json()) as CertRow[]);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }
}
