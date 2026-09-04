/**
 * Faculty Leave — the official BGSCET form, and the requests made on it.
 *
 * A dashboard of the faculty member's own requests, and behind each one the
 * one-page document itself: the institution heading, the strike-off line naming
 * which of Casual Leave / Permission / OOD / RH / LOP is being applied for, the
 * main table (Name, Designation, Department, Date, Purpose, Credit,
 * Sanctioned), the two signature blocks, and the Alternate Arrangements section
 * with its five-column table and its own staff signature.
 *
 * THE FORM IS THE SOURCE OF TRUTH FOR WHAT IT ASKS. Fields the printed sheet
 * does not have are not added to it — no employee id, no phone number, no leave
 * balance, no supporting-document upload. A leave form that collects more than
 * the college's own form is a different document with the college's letterhead
 * on it.
 *
 * APPROVALS ARE NOT HERE. This screen is a faculty member applying for
 * themselves; the queue that decides these lives in the admin area, because the
 * PROGRAM DIRECTOR block on the form is signed by the programme director and
 * not by a peer. The server enforces that independently — staff leave has no
 * student group, so `/leaves/pending` narrows it to DIRECTOR/ADMIN.
 *
 * Name, Designation and Department are printed from the user record and are not
 * editable: they are what the institution holds, and a form whose identity
 * fields can be typed over is not evidence of anything.
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
export const LEAVE_KINDS = [
  { id: 'CASUAL', label: 'Casual Leave' },
  { id: 'PERMISSION', label: 'Permission' },
  { id: 'OOD', label: 'OOD' },
  { id: 'RH', label: 'RH' },
  { id: 'LOP', label: 'LOP' },
] as const;

interface Chip {
  tone: 'good' | 'warn' | 'risk' | 'neutral';
  icon: string;
  label: string;
}

function statusChip(status: string): Chip {
  switch (status) {
    case 'APPROVED':
      return { tone: 'good', icon: 'verified', label: 'Sanctioned' };
    case 'REJECTED':
      return { tone: 'risk', icon: 'cancel', label: 'Not sanctioned' };
    case 'FIRST_APPROVED':
      return { tone: 'warn', icon: 'hourglass_top', label: 'Part-approved' };
    default:
      return { tone: 'warn', icon: 'schedule', label: 'With the Program Director' };
  }
}

function emptyAltRow(): AltRow {
  return { date: '', staff_name: '', cls: '', time: '', remarks: '' };
}

@Component({
  selector: 'app-mentor-leave',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './leave.component.html',
  styleUrl: './leave.component.scss',
})
export class LeaveComponent {
  readonly kinds = LEAVE_KINDS;

  readonly rows = signal<LeaveRow[] | null>(null);
  readonly error = signal<string | null>(null);

  /// null = the dashboard; a row = reading that form; 'new' = filling one in.
  readonly viewing = signal<LeaveRow | null>(null);
  readonly composing = signal(false);
  readonly submitting = signal(false);
  readonly formError = signal<string | null>(null);

  /// Draft state for a new form.
  readonly fKind = signal<string>('CASUAL');
  readonly fFrom = signal('');
  readonly fTo = signal('');
  readonly fPurpose = signal('');
  readonly fCredit = signal('');
  readonly fAltName = signal('');
  readonly fAltRows = signal<AltRow[]>([emptyAltRow(), emptyAltRow(), emptyAltRow()]);

  /// Identity for the form being composed, taken from any existing request.
  readonly identity = computed(() => {
    const any = (this.rows() ?? [])[0];
    return {
      name: any?.requester_name ?? '',
      designation: any?.requester_designation ?? null,
      department: any?.requester_department ?? null,
    };
  });

  readonly canSubmit = computed(
    () => !!this.fFrom() && !!this.fTo() && !!this.fPurpose().trim() && !this.submitting(),
  );

  constructor() {
    void this.load();
  }

  chip(status: string): Chip {
    return statusChip(status);
  }

  kindLabel(id: string | null): string {
    return LEAVE_KINDS.find((k) => k.id === id)?.label ?? '—';
  }

  /** The form's "Date" cell: one day prints as one date, a span as a range. */
  dateSpan(row: { from_date: string; to_date: string }): string {
    return row.from_date === row.to_date ? row.from_date : `${row.from_date} — ${row.to_date}`;
  }

  startNew(): void {
    this.composing.set(true);
    this.viewing.set(null);
    this.formError.set(null);
  }

  backToDash(): void {
    this.composing.set(false);
    this.viewing.set(null);
  }

  open(row: LeaveRow): void {
    this.viewing.set(row);
    this.composing.set(false);
  }

  setAltCell(i: number, key: keyof AltRow, value: string): void {
    this.fAltRows.update((rows) => rows.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  }

  addAltRow(): void {
    this.fAltRows.update((rows) => [...rows, emptyAltRow()]);
  }

  /**
   * Sign and send. Submitting IS signing on this form — the staff signature
   * block is what sends it to the programme director — so there is no separate
   * "sign" step that could be skipped, and the server stamps `signed_at` in the
   * same write that sets the status.
   */
  async signAndSubmit(): Promise<void> {
    if (!this.canSubmit()) return;
    this.submitting.set(true);
    this.formError.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/leaves`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_date: this.fFrom(),
          to_date: this.fTo(),
          reason: this.fPurpose().trim(),
          leave_kind: this.fKind(),
          credit: this.fCredit().trim() || null,
          alt_name: this.fAltName().trim() || null,
          // Blank rows are printed padding, not data.
          alt_rows: this.fAltRows().filter((r) =>
            [r.date, r.staff_name, r.cls, r.time, r.remarks].some((v) => v.trim()),
          ),
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        this.formError.set(d?.detail ?? 'Could not submit the form.');
        return;
      }
      const created = (await res.json()) as LeaveRow;
      this.rows.update((list) => [created, ...(list ?? [])]);
      this.composing.set(false);
      this.viewing.set(created);
      this.resetDraft();
    } catch {
      this.formError.set('Could not reach the server.');
    } finally {
      this.submitting.set(false);
    }
  }

  private resetDraft(): void {
    this.fKind.set('CASUAL');
    this.fFrom.set('');
    this.fTo.set('');
    this.fPurpose.set('');
    this.fCredit.set('');
    this.fAltName.set('');
    this.fAltRows.set([emptyAltRow(), emptyAltRow(), emptyAltRow()]);
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/leaves/mine`, { credentials: 'include' });
      if (!res.ok) {
        this.error.set('Could not load your leave requests.');
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
