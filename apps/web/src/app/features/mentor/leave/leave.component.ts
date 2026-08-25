/**
 * Faculty Leave — both halves of the leave workflow on one screen.
 *
 *   - Approvals — GET /leaves/pending (already scoped server-side: a MENTOR sees
 *     only their own group's requests, a group-less MENTOR sees nobody, and a
 *     request you first-approved disappears until a DIFFERENT approver signs).
 *     Approve / Reject POSTs /leaves/{id}/decision with an optional note.
 *   - My requests — GET /leaves/mine plus the submit form (POST /leaves). Staff
 *     leave is decidable by DIRECTOR/ADMIN only, which the empty pending queue
 *     copy explains rather than leaving mysterious.
 *
 * Two-approver flow is server truth; this screen only renders the states
 * (SUBMITTED → FIRST_APPROVED → APPROVED / REJECTED) as text + colour.
 */

import { Component, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { environment } from '../../../../environments/environment';

interface LeaveRow {
  id: string;
  from_date: string;
  to_date: string;
  reason: string;
  status: string;
}

type Tone = 'good' | 'warn' | 'risk' | 'neutral';

const STATUS: Record<string, { label: string; tone: Tone; icon: string }> = {
  SUBMITTED: { label: 'Awaiting first approval', tone: 'warn', icon: 'hourglass_top' },
  FIRST_APPROVED: { label: 'Awaiting second approval', tone: 'warn', icon: 'pending_actions' },
  APPROVED: { label: 'Approved', tone: 'good', icon: 'check_circle' },
  REJECTED: { label: 'Rejected', tone: 'risk', icon: 'error' },
};

@Component({
  selector: 'app-mentor-leave',
  standalone: true,
  imports: [DatePipe, FormsModule],
  templateUrl: './leave.component.html',
})
export class LeaveComponent {
  private readonly apiBase = environment.apiBase;

  readonly subtab = signal<'approvals' | 'mine'>('approvals');

  readonly pending = signal<LeaveRow[] | null>(null);
  readonly pendingError = signal<string | null>(null);
  readonly mine = signal<LeaveRow[] | null>(null);
  readonly mineError = signal<string | null>(null);

  /** Row id with its decision request in flight, so its buttons disable. */
  readonly decidingId = signal<string | null>(null);
  readonly decideError = signal<string | null>(null);
  /** Per-row optional decision note, keyed by leave id. */
  readonly notes: Record<string, string> = {};

  // --- submit form ---
  fromDate = '';
  toDate = '';
  reason = '';
  readonly submitting = signal(false);
  readonly submitError = signal<string | null>(null);
  readonly submittedFlash = signal(false);

  constructor() {
    void this.loadPending();
    void this.loadMine();
  }

  setSubtab(tab: 'approvals' | 'mine'): void {
    this.subtab.set(tab);
  }

  private async loadPending(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/leaves/pending`, { credentials: 'include' });
      if (!res.ok) {
        this.pendingError.set('Could not load the approval queue.');
        return;
      }
      this.pending.set((await res.json()) as LeaveRow[]);
      this.pendingError.set(null);
    } catch {
      this.pendingError.set('Could not reach the server.');
    }
  }

  private async loadMine(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/leaves/mine`, { credentials: 'include' });
      if (!res.ok) {
        this.mineError.set('Could not load your requests.');
        return;
      }
      this.mine.set((await res.json()) as LeaveRow[]);
      this.mineError.set(null);
    } catch {
      this.mineError.set('Could not reach the server.');
    }
  }

  async submit(): Promise<void> {
    this.submitError.set(null);
    if (!this.fromDate || !this.toDate || !this.reason.trim()) {
      this.submitError.set('Fill the dates and the reason.');
      return;
    }
    if (this.toDate < this.fromDate) {
      this.submitError.set('The end date is before the start date.');
      return;
    }
    this.submitting.set(true);
    try {
      const res = await fetch(`${this.apiBase}/leaves`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_date: this.fromDate,
          to_date: this.toDate,
          reason: this.reason.trim(),
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        this.submitError.set(detail?.detail ?? 'Could not submit the request.');
        return;
      }
      this.fromDate = '';
      this.toDate = '';
      this.reason = '';
      this.submittedFlash.set(true);
      setTimeout(() => this.submittedFlash.set(false), 2500);
      await this.loadMine();
    } catch {
      this.submitError.set('Could not reach the server.');
    } finally {
      this.submitting.set(false);
    }
  }

  async decide(row: LeaveRow, decision: 'APPROVE' | 'REJECT'): Promise<void> {
    this.decideError.set(null);
    this.decidingId.set(row.id);
    try {
      const res = await fetch(`${this.apiBase}/leaves/${row.id}/decision`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: this.notes[row.id]?.trim() || null }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        this.decideError.set(detail?.detail ?? 'Could not record that decision.');
        return;
      }
      delete this.notes[row.id];
      await this.loadPending();
    } catch {
      this.decideError.set('Could not reach the server.');
    } finally {
      this.decidingId.set(null);
    }
  }

  statusLabel(status: string): string {
    return STATUS[status]?.label ?? status;
  }
  statusTone(status: string): Tone {
    return STATUS[status]?.tone ?? 'neutral';
  }
  statusIcon(status: string): string {
    return STATUS[status]?.icon ?? 'help';
  }
}
