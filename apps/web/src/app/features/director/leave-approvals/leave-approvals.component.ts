/**
 * Leave Approvals — the other half of the faculty leave workflow.
 *
 * The applicant signs the BGSCET form and sends it; this is where it is read and
 * decided. The document is rendered the same way it is on the applicant's side,
 * because a form reviewed in a different layout from the one it was filled in is
 * a different form — the reviewer should be looking at what was signed.
 *
 * TWO DISTINCT APPROVERS, ENFORCED SERVER-SIDE. /leaves/pending already omits a
 * request this user first-approved, and the decision endpoint refuses a second
 * signature from the same person. This screen states the rule where it applies
 * rather than re-implementing it.
 *
 * A REJECTION NEEDS A REASON. The applicant sees the note and the status and
 * nothing else, so refusing without words leaves them with a form marked "not
 * sanctioned" and no idea what to do next.
 */

import { DatePipe, KeyValuePipe } from '@angular/common';
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

const KINDS: Record<string, string> = {
  CASUAL: 'Casual Leave',
  PERMISSION: 'Permission',
  OOD: 'OOD',
  RH: 'RH',
  LOP: 'LOP',
};

@Component({
  selector: 'app-director-leave-approvals',
  standalone: true,
  imports: [DatePipe, KeyValuePipe],
  templateUrl: './leave-approvals.component.html',
  styleUrl: './leave-approvals.component.scss',
})
export class DirectorLeaveApprovalsComponent {
  readonly rows = signal<LeaveRow[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly openId = signal<string | null>(null);
  readonly notes = signal<Record<string, string>>({});
  readonly noteError = signal<string | null>(null);
  readonly deciding = signal<string | null>(null);
  readonly done = signal<Record<string, string>>({});

  readonly pendingCount = computed(() => (this.rows() ?? []).length);

  constructor() {
    void this.load();
  }

  kindLabel(id: string | null): string {
    return id ? (KINDS[id] ?? id) : '—';
  }

  dateSpan(r: LeaveRow): string {
    return r.from_date === r.to_date ? r.from_date : `${r.from_date} — ${r.to_date}`;
  }

  note(id: string): string {
    return this.notes()[id] ?? '';
  }

  setNote(id: string, v: string): void {
    this.notes.update((n) => ({ ...n, [id]: v }));
    this.noteError.set(null);
  }

  toggle(id: string): void {
    this.openId.update((c) => (c === id ? null : id));
    this.noteError.set(null);
  }

  async decide(row: LeaveRow, decision: 'APPROVE' | 'REJECT'): Promise<void> {
    const note = this.note(row.id).trim();
    if (decision === 'REJECT' && !note) {
      this.noteError.set('Give a reason — the applicant is shown this and nothing else.');
      return;
    }
    this.deciding.set(row.id);
    this.error.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/leaves/${row.id}/decision`, {
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
      const updated = (await res.json()) as LeaveRow;
      // The server decides whether one signature finished it: a first-of-two
      // approval leaves the request SUBMITTED-and-part-approved rather than
      // sanctioned, and saying "sanctioned" here would be this screen guessing.
      const label =
        decision === 'REJECT'
          ? `Not sanctioned — ${row.requester_name} has the reason.`
          : updated.status === 'APPROVED'
            ? `Sanctioned and signed for ${row.requester_name}.`
            : `Your approval is recorded. A second approver is still needed.`;
      this.done.update((d) => ({ ...d, [row.id]: label }));
      this.openId.set(null);
      this.rows.update((list) => (list ?? []).filter((r) => r.id !== row.id));
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.deciding.set(null);
    }
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/leaves/pending`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set('Could not load the approvals queue.');
        this.rows.set([]);
        return;
      }
      this.rows.set((await res.json()) as LeaveRow[]);
    } catch {
      this.error.set('Could not reach the server.');
      this.rows.set([]);
    }
  }
}
