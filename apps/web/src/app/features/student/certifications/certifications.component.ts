/**
 * Student certifications — the "Certification Tracker" panel (mockup data-p="certs").
 *
 * A dt-table of every certification mapped to the student's courses, one row each:
 * name, provider, progress %, and a good/warn/risk pace chip derived from the
 * progress status. All the data is shaped by GET /api/student/certifications, so
 * this only reads the flat rows and paints them against the global reep-v2 classes.
 */

import { Component, computed, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';

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
}

/** The pace chip: class matches a global .chip modifier (good/warn/risk). */
interface Chip {
  cls: 'good' | 'warn' | 'risk';
  icon: string;
  label: string;
}

interface DisplayRow extends CertRow {
  chip: Chip;
}

/** status -> pace chip. COMPLETED=good, IN_PROGRESS=warn, OVERDUE=risk. */
const CHIP: Record<string, Chip> = {
  COMPLETED: { cls: 'good', icon: 'check_circle', label: 'Complete' },
  IN_PROGRESS: { cls: 'warn', icon: 'schedule', label: 'In progress' },
  OVERDUE: { cls: 'risk', icon: 'error', label: 'Overdue' },
  NOT_STARTED: { cls: 'warn', icon: 'radio_button_unchecked', label: 'Not started' },
};

@Component({
  selector: 'app-student-certifications',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './certifications.component.html',
  styleUrl: './certifications.component.scss',
})
export class CertificationsComponent {
  private readonly rows = signal<CertRow[] | null>(null);
  readonly error = signal<string | null>(null);

  /// Rows with the pace chip attached, or null while still loading.
  readonly view = computed<DisplayRow[] | null>(() => {
    const list = this.rows();
    if (!list) return null;
    return list.map((r) => ({
      ...r,
      chip: CHIP[r.status] ?? { cls: 'warn', icon: 'help', label: r.status },
    }));
  });

  readonly completedCount = computed(
    () => this.rows()?.filter((r) => r.status === 'COMPLETED').length ?? 0,
  );

  constructor() {
    void this.load();
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
