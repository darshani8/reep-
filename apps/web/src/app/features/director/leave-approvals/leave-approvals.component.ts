/**
 * Leave Approvals — the other half of the faculty leave workflow.
 *
 * The applicant signs the BGSCET form and sends it; this is where it is read and
 * decided. Every request is rendered AS THE DOCUMENT, in full, the same way it is
 * on the applicant's side — a form reviewed in a different layout from the one it
 * was filled in is a different form. The PROGRAM DIRECTOR block on the sheet is
 * where the decision is taken: "Mark Sanctioned & sign" sits exactly where the
 * signature will print.
 *
 * THREE TABS, NOT FOUR. The design shows Pending / Returned / Approved /
 * Rejected. "Returned for changes" is not a state the leave model has (there is
 * no RETURNED status and adding one is a migration), so it is not offered — a
 * button that quietly mapped it to Reject would tell the applicant "not
 * sanctioned" when the director meant "fix the dates". Pending comes from
 * /leaves/pending, the other two from /leaves/history.
 *
 * TWO DISTINCT APPROVERS, ENFORCED SERVER-SIDE. /leaves/pending already omits a
 * request this user first-approved, and the decision endpoint refuses a second
 * signature from the same person. The confirm step says which signature this
 * one is rather than promising a sanction the server may not yet grant.
 *
 * A REJECTION NEEDS A REASON. The applicant sees the remarks and the status and
 * nothing else, so refusing without words leaves them with a form marked "not
 * sanctioned" and no idea what to do next.
 */

import { DatePipe } from '@angular/common';
import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';

interface AltRow {
  date: string;
  staff_name: string;
  cls: string;
  time: string;
  remarks: string;
}

interface LeaveRow {
  id: string;
  from_date: string;
  to_date: string;
  reason: string;
  status: string;
  leave_kind: string | null;
  credit: string | null;
  alt_name: string | null;
  alt_rows: AltRow[];
  requester_name: string;
  requester_designation: string | null;
  requester_department: string | null;
  signed_at: string | null;
  director_name: string | null;
  director_decided_at: string | null;
  director_note: string | null;
}

/** The five printed options, in the order the sheet lists them. */
const KINDS = [
  { id: 'CASUAL', label: 'Casual Leave' },
  { id: 'PERMISSION', label: 'Permission' },
  { id: 'OOD', label: 'OOD' },
  { id: 'RH', label: 'RH' },
  { id: 'LOP', label: 'LOP' },
] as const;

type Filter = 'pending' | 'approved' | 'rejected';

interface RowUi {
  mode: 'idle' | 'approve' | 'reject';
  remarks: string;
  err: boolean;
}

const IDLE: RowUi = { mode: 'idle', remarks: '', err: false };

const EMPTY_NOTE: Record<Filter, string> = {
  pending: 'No requests waiting on your signature.',
  approved: 'Nothing sanctioned yet.',
  rejected: 'No rejected requests.',
};

@Component({
  selector: 'app-director-leave-approvals',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './leave-approvals.component.html',
  styleUrl: './leave-approvals.component.scss',
})
export class DirectorLeaveApprovalsComponent {
  readonly kinds = KINDS;
  readonly tabs: { key: Filter; label: string }[] = [
    { key: 'pending', label: 'Pending' },
    { key: 'approved', label: 'Approved' },
    { key: 'rejected', label: 'Rejected' },
  ];

  readonly filter = signal<Filter>('pending');
  readonly pending = signal<LeaveRow[] | null>(null);
  readonly history = signal<LeaveRow[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly ui = signal<Record<string, RowUi>>({});
  readonly deciding = signal<string | null>(null);
  readonly flash = signal<string | null>(null);

  readonly loading = computed(() => this.pending() === null || this.history() === null);

  readonly counts = computed(() => {
    const hist = this.history() ?? [];
    return {
      pending: (this.pending() ?? []).length,
      approved: hist.filter((r) => r.status === 'APPROVED').length,
      rejected: hist.filter((r) => r.status === 'REJECTED').length,
    };
  });

  readonly rows = computed<LeaveRow[]>(() => {
    const f = this.filter();
    if (f === 'pending') return this.pending() ?? [];
    const want = f === 'approved' ? 'APPROVED' : 'REJECTED';
    return (this.history() ?? []).filter((r) => r.status === want);
  });

  readonly emptyNote = computed(() => EMPTY_NOTE[this.filter()]);

  constructor() {
    void this.load();
  }

  setFilter(f: Filter): void {
    this.filter.set(f);
  }

  isPending(r: LeaveRow): boolean {
    return r.status === 'SUBMITTED' || r.status === 'FIRST_APPROVED';
  }

  dateSpan(r: LeaveRow): string {
    return r.from_date === r.to_date ? r.from_date : `${r.from_date} — ${r.to_date}`;
  }

  /** The form's "Sanctioned" cell, in the words the sheet uses. */
  sanctioned(r: LeaveRow): string {
    switch (r.status) {
      case 'APPROVED':
        return 'Sanctioned';
      case 'REJECTED':
        return 'Not sanctioned';
      case 'FIRST_APPROVED':
        return 'Pending · one of two signatures recorded';
      default:
        return 'Pending';
    }
  }

  remarksLabel(r: LeaveRow): string {
    return r.status === 'REJECTED' ? 'Rejected — your remarks' : 'Sanctioned — remarks';
  }

  /** What the confirm step promises, honestly: which signature this one is. */
  signNote(r: LeaveRow): string {
    return r.status === 'FIRST_APPROVED'
      ? 'A first signature is already on this form; yours completes the sanction and prints in the PROGRAM DIRECTOR block with the time.'
      : 'Records your signature — your name and the time. A second, different approver must also sign before the leave is sanctioned.';
  }

  uiFor(id: string): RowUi {
    return this.ui()[id] ?? IDLE;
  }

  openApprove(id: string): void {
    this.setUi(id, { mode: 'approve', remarks: '', err: false });
  }

  openReject(id: string): void {
    this.setUi(id, { mode: 'reject', remarks: '', err: false });
  }

  cancelUi(id: string): void {
    this.setUi(id, IDLE);
  }

  setRemarks(id: string, v: string): void {
    this.setUi(id, { ...this.uiFor(id), remarks: v, err: false });
  }

  async confirmApprove(r: LeaveRow): Promise<void> {
    await this.decide(r, 'APPROVE', null);
  }

  async confirmReject(r: LeaveRow): Promise<void> {
    const remarks = this.uiFor(r.id).remarks.trim();
    if (!remarks) {
      this.setUi(r.id, { ...this.uiFor(r.id), err: true });
      return;
    }
    await this.decide(r, 'REJECT', remarks);
  }

  private setUi(id: string, next: RowUi): void {
    this.ui.update((u) => ({ ...u, [id]: next }));
  }

  private async decide(row: LeaveRow, decision: 'APPROVE' | 'REJECT', note: string | null): Promise<void> {
    this.deciding.set(row.id);
    this.error.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/leaves/${row.id}/decision`, {
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
      const updated = (await res.json()) as LeaveRow;
      // The server decides whether one signature finished it: a first-of-two
      // approval leaves the request part-approved rather than sanctioned, and
      // saying "sanctioned" here would be this screen guessing.
      this.flash.set(
        decision === 'REJECT'
          ? `Not sanctioned — ${row.requester_name} has your remarks.`
          : updated.status === 'APPROVED'
            ? `Sanctioned and signed for ${row.requester_name}.`
            : `Your signature is recorded for ${row.requester_name}. A second approver is still needed.`,
      );
      this.setUi(row.id, IDLE);
      await this.load();
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.deciding.set(null);
    }
  }

  private async load(): Promise<void> {
    try {
      const [pRes, hRes] = await Promise.all([
        fetch(`${environment.apiBase}/leaves/pending`, { credentials: 'include' }),
        fetch(`${environment.apiBase}/leaves/history`, { credentials: 'include' }),
      ]);
      if (!pRes.ok || !hRes.ok) {
        this.error.set('Could not load the approvals queue.');
        this.pending.set([]);
        this.history.set([]);
        return;
      }
      this.pending.set((await pRes.json()) as LeaveRow[]);
      this.history.set((await hRes.json()) as LeaveRow[]);
    } catch {
      this.error.set('Could not reach the server.');
      this.pending.set([]);
      this.history.set([]);
    }
  }
}
