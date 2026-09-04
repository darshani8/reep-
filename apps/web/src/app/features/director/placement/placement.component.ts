/**
 * Placement — the offers waiting to be recorded as real.
 *
 * A student self-reports an offer; until someone approves it, it is a claim.
 * Approving is what puts it in the placement figures, which is why this screen
 * shows the CTC and the role type on the row rather than behind a click: those
 * are the numbers the approval is actually about.
 *
 * The queue and the decision both live on /mentor/offers/*, gated by
 * `require_director` — the path says mentor, the guard says director, and the
 * guard is what governs. Kept there rather than duplicated under /director so
 * there is one implementation of "approve an offer".
 */

import { KeyValuePipe } from '@angular/common';
import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface PendingOffer {
  id: string;
  student_id: string;
  student_name: string;
  job_title: string;
  organisation: string;
  role_type: string;
  ctc_inr: number;
  status: string;
}

const ROLE_LABEL: Record<string, string> = {
  FULL_TIME: 'Full-time',
  FULL_TIME_PLUS_INTERNSHIP: 'Job + internship',
  INTERNSHIP: 'Internship',
};

@Component({
  selector: 'app-director-placement',
  standalone: true,
  imports: [KeyValuePipe],
  templateUrl: './placement.component.html',
  styleUrl: './placement.component.scss',
})
export class DirectorPlacementComponent {
  readonly rows = signal<PendingOffer[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly notes = signal<Record<string, string>>({});
  readonly noteError = signal<string | null>(null);
  readonly deciding = signal<string | null>(null);
  readonly done = signal<Record<string, string>>({});

  readonly pendingCount = computed(() => (this.rows() ?? []).length);

  constructor() {
    void this.load();
  }

  roleLabel(t: string): string {
    return ROLE_LABEL[t] ?? t;
  }

  /** Indian grouping, because that is how a CTC is read here. */
  ctc(n: number): string {
    return n ? `₹${n.toLocaleString('en-IN')}` : '—';
  }

  note(id: string): string {
    return this.notes()[id] ?? '';
  }

  setNote(id: string, v: string): void {
    this.notes.update((m) => ({ ...m, [id]: v }));
    this.noteError.set(null);
  }

  async decide(row: PendingOffer, decision: 'APPROVE' | 'REJECT'): Promise<void> {
    const note = this.note(row.id).trim();
    if (decision === 'REJECT' && !note) {
      this.noteError.set('Give a reason — the student is shown it against their offer.');
      return;
    }
    this.deciding.set(row.id);
    this.error.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/mentor/offers/${row.id}/decision`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: note || null }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        this.error.set(d?.detail ?? 'Could not record that decision.');
        return;
      }
      this.done.update((m) => ({
        ...m,
        [row.id]:
          decision === 'APPROVE'
            ? `${row.student_name}'s offer from ${row.organisation} is approved and counts towards placement.`
            : `${row.student_name}'s offer was not approved; they have been given the reason.`,
      }));
      this.rows.update((list) => (list ?? []).filter((r) => r.id !== row.id));
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.deciding.set(null);
    }
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/mentor/offers/pending`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.error.set('Could not load the offer queue.');
        this.rows.set([]);
        return;
      }
      this.rows.set((await res.json()) as PendingOffer[]);
    } catch {
      this.error.set('Could not reach the server.');
      this.rows.set([]);
    }
  }
}
