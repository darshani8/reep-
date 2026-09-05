/**
 * Placement — the funnel, the offers, and the recruiters.
 *
 * FOUR FUNNEL STAGES, NOT FIVE. The design shows Eligible / Applied /
 * Interviewed / Offers / Accepted. Nothing in the schema records who was
 * interviewed, so that tile is not drawn — a permanent dash is a tile that lies
 * about being a metric. And the last stage is "Approved", not "Accepted": an
 * offer here is APPROVED by the placement office (which is what makes it count
 * towards the placement figures), and whether the student accepted it is not
 * something REEP records.
 *
 * THE DECISION STILL LIVES HERE. A student self-reports an offer; until someone
 * approves it, it is a claim. The Recent offers table shows every submitted
 * offer with its status, and the pending rows carry Approve / Reject inline —
 * the CTC and the role are on the row because those are the numbers the
 * approval is actually about. Rejecting needs a reason: the student is shown
 * it against their offer and nothing else.
 *
 * The decision endpoint is /mentor/offers/{id}/decision, gated by
 * `require_director` — the path says mentor, the guard says director, and the
 * guard is what governs. Kept there so there is one implementation of "approve
 * an offer".
 */

import { DatePipe } from '@angular/common';
import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface OfferRow {
  id: string;
  student_id: string;
  student_name: string;
  usn: string | null;
  organisation: string;
  job_title: string;
  role_type: string;
  ctc_inr: number;
  status: string;
  created_at: string;
  decided_at: string | null;
}

interface Placement {
  semester: number | null;
  eligible: number;
  applied: number;
  offers: number;
  approved: number;
  approved_students: number;
  recent: OfferRow[];
  top_recruiters: { organisation: string; count: number }[];
}

interface RejectUi {
  remarks: string;
  err: boolean;
}

const ROLE_LABEL: Record<string, string> = {
  FULL_TIME: 'Full-time',
  FULL_TIME_PLUS_INTERNSHIP: 'Job + internship',
  INTERNSHIP: 'Internship',
};

@Component({
  selector: 'app-director-placement',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './placement.component.html',
  styleUrl: './placement.component.scss',
})
export class DirectorPlacementComponent {
  readonly data = signal<Placement | null>(null);
  readonly error = signal<string | null>(null);
  readonly rejecting = signal<Record<string, RejectUi>>({});
  readonly deciding = signal<string | null>(null);
  readonly flash = signal<string | null>(null);

  readonly pendingCount = computed(
    () => (this.data()?.recent ?? []).filter((r) => r.status === 'PENDING_APPROVAL').length,
  );

  constructor() {
    void this.load();
  }

  roleLabel(t: string): string {
    return ROLE_LABEL[t] ?? t;
  }

  /** Lakhs per annum, because that is how a CTC is read here. */
  ctc(n: number): string {
    if (!n) return '—';
    const lpa = n / 100_000;
    return `₹ ${lpa >= 10 ? lpa.toFixed(1) : lpa.toFixed(2).replace(/0$/, '')} LPA`;
  }

  chip(status: string): { tone: string; label: string } {
    switch (status) {
      case 'APPROVED':
        return { tone: 'good', label: 'Approved' };
      case 'REJECTED':
        return { tone: 'risk', label: 'Not approved' };
      default:
        return { tone: 'warn', label: 'Awaiting approval' };
    }
  }

  rejectUi(id: string): RejectUi | null {
    return this.rejecting()[id] ?? null;
  }

  openReject(id: string): void {
    this.rejecting.update((m) => ({ ...m, [id]: { remarks: '', err: false } }));
  }

  cancelReject(id: string): void {
    this.rejecting.update((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
  }

  setRemarks(id: string, v: string): void {
    this.rejecting.update((m) => ({ ...m, [id]: { remarks: v, err: false } }));
  }

  async approve(r: OfferRow): Promise<void> {
    await this.decide(r, 'APPROVE', null);
  }

  async confirmReject(r: OfferRow): Promise<void> {
    const remarks = (this.rejectUi(r.id)?.remarks ?? '').trim();
    if (!remarks) {
      this.rejecting.update((m) => ({ ...m, [r.id]: { remarks, err: true } }));
      return;
    }
    await this.decide(r, 'REJECT', remarks);
  }

  private async decide(row: OfferRow, decision: 'APPROVE' | 'REJECT', note: string | null): Promise<void> {
    this.deciding.set(row.id);
    this.error.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/mentor/offers/${row.id}/decision`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        this.error.set(d?.detail ?? 'Could not record that decision.');
        return;
      }
      this.flash.set(
        decision === 'APPROVE'
          ? `${row.student_name}'s offer from ${row.organisation} is approved and counts towards placement.`
          : `${row.student_name}'s offer from ${row.organisation} was not approved; they have your remarks.`,
      );
      this.cancelReject(row.id);
      // The funnel and the recruiters moved too; re-read rather than patch.
      await this.load();
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.deciding.set(null);
    }
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/director/placement`, {
        credentials: 'include',
      });
      if (!res.ok) {
        this.error.set('Could not load the placement figures.');
        return;
      }
      this.data.set((await res.json()) as Placement);
    } catch {
      this.error.set('Could not reach the server.');
    }
  }
}
