/**
 * Leave approvals — the placement office's queue, in the 2026-09 console dress.
 *
 * The applicant signs the BGSCET form and sends it; this is where it is read and
 * decided. The board (`design/admin/Leave.html`) replaces the full-page sheet
 * this screen used to draw with a QUEUE beside a 380px decision panel, and the
 * document itself stays one click away as the paper PDF — `GET
 * /api/leaves/{id}/paper.pdf` renders the college's own form with the uploaded
 * signatures drawn in, which is the version that matters once it is filed.
 *
 * THREE LIVE TABS. The board shows Pending / Approved / Rejected / Cancelled.
 * The first three are real: pending comes from /leaves/pending, the other two
 * from /leaves/history. CANCELLED is a status the enum already carries and
 * nothing writes — the cancel endpoint is B10.4 — so that tab is disabled and
 * says which phase brings it, rather than opening an empty list that reads as
 * "nobody has ever withdrawn a request".
 *
 * TWO DISTINCT APPROVERS, ENFORCED SERVER-SIDE. /leaves/pending already omits a
 * request this user first-approved, and the decision endpoint refuses a second
 * signature from the same person. The confirm step says which signature this
 * one is rather than promising a sanction the server may not yet grant.
 *
 * A REJECTION NEEDS A REASON. The applicant sees the remarks and the status and
 * nothing else, so refusing without words leaves them with a form marked "not
 * sanctioned" and no idea what to do next. On an approval the remarks are
 * optional and are still sent — `note` is stored for both decisions.
 *
 * WHAT IS NOT HERE IS PENDING, NEVER INVENTED. The board's leave balances,
 * department cover, attachment, alternate acceptance, calendar, cancel and the
 * per-department policy card are all B10.x (Phase 4). Each is drawn as its
 * empty state with one sentence saying what fills it; the approval chain is
 * built ONLY from what `LeaveOut` already carries — the applicant's own
 * signature, the two-signature status, and the approver printed on a decided
 * request.
 */

import { DatePipe } from '@angular/common';
import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';

/** The approval chain, attachments, balances, calendar, cancel and the policy
 *  card are B10.1–B10.8, on branch `feat/redesign-p4-leave`. */
const LEAVE_BACKEND_PHASE = 4;

/** College and department scope for every admin queue is B1.2 / B1.4. */
const SCOPE_BACKEND_PHASE = 3;

const MILLISECONDS_IN_A_DAY = 24 * 60 * 60 * 1000;

/** Short month names for `dateSpan`. Not `toLocaleString`: that needs a
 *  Date, and a date-only string through a Date is the UTC-midnight trap
 *  documented on `dateSpan`. */
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

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

/** The five printed options, in the order the college's form lists them. */
const KINDS = [
  { id: 'CASUAL', label: 'Casual' },
  { id: 'PERMISSION', label: 'Permission' },
  { id: 'OOD', label: 'OOD' },
  { id: 'RH', label: 'RH' },
  { id: 'LOP', label: 'LOP' },
] as const;

const EVERY_KIND = 'ALL';

/** `GET /leaves/history` is `.limit(200)` with no paging parameter. The
 *  status bar says "1 to N of N", which is a claim about completeness this
 *  screen cannot make once the cap is reached, so a decided queue sitting
 *  exactly on it says so instead of quietly dropping the 201st request. */
const HISTORY_SERVER_CAP = 200;

type QueueTab = 'pending' | 'approved' | 'rejected';

type DecisionMode = 'idle' | 'approve' | 'reject';

/** One row of the panel's approval chain. `refused` is the rejected end of it —
 *  a step that happened and stopped the form, which is neither done nor next. */
type ChainState = 'done' | 'active' | 'pending' | 'refused';

interface ChainStep {
  label: string;
  detail: string;
  state: ChainState;
}

interface StatusChip {
  label: string;
  tone: 'good' | 'warn' | 'risk' | 'neutral';
}

const EMPTY_NOTE: Record<QueueTab, string> = {
  pending: 'No requests waiting on your signature.',
  approved: 'Nothing sanctioned yet.',
  rejected: 'No rejected requests.',
};

@Component({
  selector: 'app-admin-leave-approvals',
  standalone: true,
  imports: [DatePipe, PendingControlDirective],
  templateUrl: './leave-approvals.component.html',
  styleUrl: './leave-approvals.component.scss',
})
export class AdminLeaveApprovalsComponent {
  readonly leaveBackendPhase = LEAVE_BACKEND_PHASE;
  readonly scopeBackendPhase = SCOPE_BACKEND_PHASE;
  readonly kinds = KINDS;
  readonly everyKind = EVERY_KIND;

  readonly tabs: { key: QueueTab; label: string }[] = [
    { key: 'pending', label: 'Pending' },
    { key: 'approved', label: 'Approved' },
    { key: 'rejected', label: 'Rejected' },
  ];

  readonly tab = signal<QueueTab>('pending');
  readonly kindFilter = signal<string>(EVERY_KIND);
  readonly pending = signal<LeaveRow[] | null>(null);
  readonly history = signal<LeaveRow[] | null>(null);
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);
  readonly selectedId = signal<string | null>(null);
  readonly decisionMode = signal<DecisionMode>('idle');
  readonly remarks = signal<string>('');
  readonly remarksError = signal<string | null>(null);
  readonly deciding = signal<boolean>(false);

  readonly isLoading = computed(() => this.pending() === null || this.history() === null);

  readonly counts = computed(() => {
    const decided = this.history() ?? [];
    return {
      pending: (this.pending() ?? []).length,
      approved: decided.filter((row) => row.status === 'APPROVED').length,
      rejected: decided.filter((row) => row.status === 'REJECTED').length,
    };
  });

  /** The rows of the open tab, narrowed by the leave-type filter. */
  readonly rows = computed<LeaveRow[]>(() => {
    const inTab = this.rowsInTab();
    const wantedKind = this.kindFilter();
    if (wantedKind === EVERY_KIND) return inTab;
    return inTab.filter((row) => row.leave_kind === wantedKind);
  });

  readonly selectedRequest = computed<LeaveRow | null>(() => {
    const id = this.selectedId();
    if (id === null) return null;
    return this.rows().find((row) => row.id === id) ?? null;
  });

  readonly emptyNote = computed(() => EMPTY_NOTE[this.tab()]);

  readonly rowRangeLabel = computed(() => {
    const shown = this.rows().length;
    if (shown === 0) return 'No rows';
    return `1 to ${shown} of ${shown}`;
  });

  readonly kindFilterLabel = computed(() => {
    const wanted = this.kindFilter();
    if (wanted === EVERY_KIND) return 'All';
    return this.kindLabel(wanted);
  });

  /** The decision panel's chain, built only from what the row carries. */
  readonly chainSteps = computed<ChainStep[]>(() => {
    const request = this.selectedRequest();
    if (request === null) return [];
    return [
      this.applicantStep(request),
      this.firstSignatureStep(request),
      this.sanctionStep(request),
    ];
  });

  readonly canDecide = computed(() => {
    const request = this.selectedRequest();
    if (request === null) return false;
    return this.isAwaitingSignature(request);
  });

  /** The button's own words: a first signature is not a sanction. */
  readonly approveButtonLabel = computed(() => {
    const request = this.selectedRequest();
    if (request === null) return 'Sanction';
    if (request.status === 'FIRST_APPROVED') return 'Sanction';
    return 'Sign first step';
  });

  readonly confirmApproveLabel = computed(() => `Confirm ${this.approveButtonLabel().toLowerCase()}`);

  readonly selectedCount = computed(() => (this.selectedRequest() === null ? 0 : 1));

  /** True when the decided queue is standing on the server's row cap. */
  readonly historyCapped = computed(
    () => this.tab() !== 'pending' && (this.history() ?? []).length >= HISTORY_SERVER_CAP,
  );

  readonly historyCap = HISTORY_SERVER_CAP;

  constructor() {
    void this.loadQueues();
  }

  // ----------------------------------------------------------- the queue --

  setTab(tab: QueueTab): void {
    this.tab.set(tab);
    this.clearSelection();
  }

  setKindFilter(kind: string): void {
    this.kindFilter.set(kind);
    this.clearSelection();
  }

  selectRequest(id: string): void {
    this.selectedId.set(id);
    this.decisionMode.set('idle');
    this.remarks.set('');
    this.remarksError.set(null);
  }

  clearSelection(): void {
    this.selectedId.set(null);
    this.decisionMode.set('idle');
    this.remarks.set('');
    this.remarksError.set(null);
  }

  isSelected(row: LeaveRow): boolean {
    return this.selectedId() === row.id;
  }

  /** SUBMITTED and FIRST_APPROVED are the two states a signature can land on. */
  isAwaitingSignature(row: LeaveRow): boolean {
    return row.status === 'SUBMITTED' || row.status === 'FIRST_APPROVED';
  }

  // --------------------------------------------------- reading one request --

  initialsOf(row: LeaveRow): string {
    const words = row.requester_name.trim().split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) return '—';
    const first = words[0].charAt(0);
    if (words.length === 1) return first.toUpperCase();
    const last = words[words.length - 1].charAt(0);
    return `${first}${last}`.toUpperCase();
  }

  /** The line under the name: the institutional identity the form prints. */
  requesterLine(row: LeaveRow): string {
    const parts: string[] = [];
    if (row.requester_designation) parts.push(row.requester_designation);
    if (row.requester_department) parts.push(row.requester_department);
    if (parts.length === 0) return 'Not on record';
    return parts.join(' · ');
  }

  kindLabel(kind: string | null): string {
    if (kind === null) return 'Not stated';
    const printed = KINDS.find((option) => option.id === kind);
    if (printed === undefined) return kind;
    return printed.label;
  }

  /** "16–17 Sep 2026", the way the board and the paper form write a span.
   *
   *  Parsed from the ISO parts by hand and NOT through `new Date('2026-09-16')`
   *  or DatePipe: a date-only string is parsed as UTC midnight, which renders
   *  as the 15th in every timezone west of Greenwich — a leave form that shows
   *  the applicant a day they did not ask for. Unparseable input falls back to
   *  the raw strings rather than inventing a date. */
  dateSpan(row: LeaveRow): string {
    const first = this.dateParts(row.from_date);
    const last = this.dateParts(row.to_date);
    if (first === null || last === null) {
      if (row.from_date === row.to_date) return row.from_date;
      return `${row.from_date} — ${row.to_date}`;
    }
    if (row.from_date === row.to_date) return this.printDate(first, true);
    if (first.year === last.year && first.month === last.month) {
      return `${first.day}–${this.printDate(last, true)}`;
    }
    if (first.year === last.year) {
      return `${this.printDate(first, false)} – ${this.printDate(last, true)}`;
    }
    return `${this.printDate(first, true)} – ${this.printDate(last, true)}`;
  }

  private dateParts(value: string): { year: number; month: number; day: number } | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
    if (match === null) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year, month, day };
  }

  private printDate(
    parts: { year: number; month: number; day: number },
    withYear: boolean,
  ): string {
    const month = MONTHS[parts.month - 1];
    if (withYear) return `${parts.day} ${month} ${parts.year}`;
    return `${parts.day} ${month}`;
  }

  /** Calendar days, inclusive of both ends. WORKING days need the academic
   *  calendar (B10.2), so this counts what the two dates on the form say and
   *  is labelled as calendar days. */
  dayCountLabel(row: LeaveRow): string {
    const firstDay = Date.parse(`${row.from_date}T00:00:00Z`);
    const lastDay = Date.parse(`${row.to_date}T00:00:00Z`);
    if (Number.isNaN(firstDay) || Number.isNaN(lastDay)) return 'Dates not readable';
    const days = Math.round((lastDay - firstDay) / MILLISECONDS_IN_A_DAY) + 1;
    if (days === 1) return '1 day';
    return `${days} days`;
  }

  statusChip(row: LeaveRow): StatusChip {
    switch (row.status) {
      case 'APPROVED':
        return { label: 'Sanctioned', tone: 'good' };
      case 'REJECTED':
        return { label: 'Not sanctioned', tone: 'risk' };
      case 'FIRST_APPROVED':
        return { label: 'Sanction pending', tone: 'warn' };
      default:
        return { label: 'First signature pending', tone: 'warn' };
    }
  }

  /** The grid's Approval chain cell, in one line. */
  chainSummary(row: LeaveRow): string {
    switch (row.status) {
      case 'APPROVED':
        return `Sanctioned by ${row.director_name || 'an approver'}`;
      case 'REJECTED':
        return `Refused by ${row.director_name || 'an approver'}`;
      case 'FIRST_APPROVED':
        return 'One signature recorded → sanction';
      default:
        return 'First signature, then sanction';
    }
  }

  /** `director_note` is `second_note or first_note`, so on a FIRST_APPROVED
   *  request it carries the FIRST approver's remarks — and the second approver,
   *  the one person who has to act on them, is who this screen was hiding them
   *  from. Each of the three states is named, because "Sanctioned — remarks"
   *  over a request that is not yet sanctioned is worse than no heading. */
  remarksLabel(row: LeaveRow): string {
    if (row.status === 'REJECTED') return 'Rejected — remarks';
    if (row.status === 'FIRST_APPROVED') return 'First signature — remarks';
    return 'Sanctioned — remarks';
  }

  /** SUBMITTED has nothing decided, so any note on it would be nobody's. */
  hasApproverRemarks(row: LeaveRow): boolean {
    return !!row.director_note && row.status !== 'SUBMITTED';
  }

  /** What the confirm step promises, honestly: which signature this one is. */
  signNote(row: LeaveRow): string {
    if (row.status === 'FIRST_APPROVED') {
      return 'A first signature is already on this form; yours completes the sanction and prints in the PROGRAM DIRECTOR block with the time.';
    }
    return 'Records your signature — your name and the time. A second, different approver must also sign before the leave is sanctioned.';
  }

  /** GET /api/leaves/{id}/paper.pdf — the sheet as a file, signatures drawn in. */
  paperUrl(row: LeaveRow): string {
    return `${environment.apiBase}/leaves/${row.id}/paper.pdf`;
  }

  selectValue(event: Event): string {
    const target = event.target as HTMLSelectElement;
    return target.value;
  }

  onRemarksInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.remarks.set(target.value);
    this.remarksError.set(null);
  }

  // ------------------------------------------------------- the decision --

  openApprove(): void {
    this.decisionMode.set('approve');
    this.remarksError.set(null);
  }

  openReject(): void {
    this.decisionMode.set('reject');
    this.remarksError.set(null);
  }

  cancelDecision(): void {
    this.decisionMode.set('idle');
    this.remarksError.set(null);
  }

  async confirmApprove(): Promise<void> {
    const request = this.selectedRequest();
    if (request === null) return;
    const typedRemarks = this.remarks().trim();
    await this.decide(request, 'APPROVE', typedRemarks.length > 0 ? typedRemarks : null);
  }

  async confirmReject(): Promise<void> {
    const request = this.selectedRequest();
    if (request === null) return;
    const typedRemarks = this.remarks().trim();
    if (typedRemarks.length === 0) {
      this.remarksError.set('Remarks are required.');
      return;
    }
    await this.decide(request, 'REJECT', typedRemarks);
  }

  private async decide(
    row: LeaveRow,
    decision: 'APPROVE' | 'REJECT',
    note: string | null,
  ): Promise<void> {
    this.deciding.set(true);
    this.error.set(null);
    try {
      const response = await fetch(`${environment.apiBase}/leaves/${row.id}/decision`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note }),
      });
      if (!response.ok) {
        this.error.set(await this.detailOf(response));
        return;
      }
      const updated = (await response.json()) as LeaveRow;
      this.flash.set(this.decisionFlash(row, decision, updated));
      this.clearSelection();
      await this.loadQueues();
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.deciding.set(false);
    }
  }

  /** The server decides whether one signature finished it: a first-of-two
   *  approval leaves the request part-approved rather than sanctioned, and
   *  saying "sanctioned" here would be this screen guessing. */
  private decisionFlash(
    row: LeaveRow,
    decision: 'APPROVE' | 'REJECT',
    updated: LeaveRow,
  ): string {
    if (decision === 'REJECT') {
      return `Not sanctioned — ${row.requester_name} has your remarks.`;
    }
    if (updated.status === 'APPROVED') {
      return `Sanctioned and signed for ${row.requester_name}.`;
    }
    return `Your signature is recorded for ${row.requester_name}. A second approver is still needed.`;
  }

  /** FastAPI answers a schema refusal with `detail` as a LIST, and rendering
   *  that raw is how a form ends up saying "[object Object]". Its own sentence
   *  where there is one — it names what was wrong. */
  private async detailOf(response: Response): Promise<string> {
    try {
      const body = await response.json();
      const detail = body?.detail;
      if (typeof detail === 'string') return detail;
      if (Array.isArray(detail) && detail.length && typeof detail[0]?.msg === 'string') {
        return detail[0].msg;
      }
    } catch {
      /* fall through to the generic sentence */
    }
    return 'Could not record that decision.';
  }

  // ------------------------------------------------------------- loading --

  private rowsInTab(): LeaveRow[] {
    const tab = this.tab();
    if (tab === 'pending') return this.pending() ?? [];
    const wantedStatus = tab === 'approved' ? 'APPROVED' : 'REJECTED';
    return (this.history() ?? []).filter((row) => row.status === wantedStatus);
  }

  private applicantStep(row: LeaveRow): ChainStep {
    if (row.signed_at === null) {
      return { label: 'Applied', state: 'done', detail: 'Sent without a signature stamp.' };
    }
    return {
      label: 'Applied and signed',
      state: 'done',
      detail: `${row.requester_name} · ${this.stampOf(row.signed_at)}`,
    };
  }

  private firstSignatureStep(row: LeaveRow): ChainStep {
    if (row.status === 'SUBMITTED') {
      return {
        label: 'First signature',
        state: 'active',
        detail: 'You can sign this step.',
      };
    }
    if (row.status === 'REJECTED') {
      return {
        label: 'First signature',
        state: 'done',
        detail: 'Recorded, or the form was refused at this step.',
      };
    }
    return {
      label: 'First signature',
      state: 'done',
      detail: row.director_note
        ? 'Recorded with remarks — a second, different approver is required.'
        : 'Recorded — a second, different approver is required.',
    };
  }

  private sanctionStep(row: LeaveRow): ChainStep {
    if (row.status === 'APPROVED') {
      return {
        label: 'Sanction',
        state: 'done',
        detail: `${row.director_name || 'Approver'} · ${this.stampOf(row.director_decided_at)}`,
      };
    }
    if (row.status === 'REJECTED') {
      return {
        label: 'Not sanctioned',
        state: 'refused',
        detail: `${row.director_name || 'Approver'} · ${this.stampOf(row.director_decided_at)}`,
      };
    }
    if (row.status === 'FIRST_APPROVED') {
      return { label: 'Sanction', state: 'active', detail: 'You can sign this step.' };
    }
    return { label: 'Sanction', state: 'pending', detail: 'After the first signature.' };
  }

  private stampOf(value: string | null): string {
    if (value === null) return 'time not recorded';
    const stamp = new Date(value);
    if (Number.isNaN(stamp.getTime())) return 'time not recorded';
    return stamp.toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private async loadQueues(): Promise<void> {
    try {
      const [pendingResponse, historyResponse] = await Promise.all([
        fetch(`${environment.apiBase}/leaves/pending`, { credentials: 'include' }),
        fetch(`${environment.apiBase}/leaves/history`, { credentials: 'include' }),
      ]);
      if (!pendingResponse.ok || !historyResponse.ok) {
        this.error.set('Could not load the approvals queue.');
        this.pending.set([]);
        this.history.set([]);
        return;
      }
      this.pending.set((await pendingResponse.json()) as LeaveRow[]);
      this.history.set((await historyResponse.json()) as LeaveRow[]);
    } catch {
      this.error.set('Could not reach the server.');
      this.pending.set([]);
      this.history.set([]);
    }
  }
}
