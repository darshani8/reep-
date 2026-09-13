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
 *
 * THE SCOPE PILLS, WIRED — AND THEY ARE TWO DIFFERENT FACTS (B1.4). `GET
 * /leaves/pending` and `GET /leaves/history` take NO college or department
 * parameter. The server narrows the queue itself (`_narrow_to_scope` in
 * app/routers/leave.py) and states how far this session's grant reaches in
 * response headers — `X-Reep-Scope`, plus `X-Reep-Scope-Colleges` and
 * `X-Reep-Scope-Departments` when the reach names any. So:
 *
 *   - COLLEGE is a READ-OUT of that reach, not a picker. There is nothing to
 *     send, and a menu here would be this screen claiming it can change what
 *     you may see when all it could ever do is hide rows you are entitled to.
 *   - DEPARTMENT is a client-side filter over the rows already returned, and it
 *     narrows WHAT IS DRAWN, never what may be read. It is honest because the
 *     rows carry it: `LeaveOut.requester_department` is the requester's own
 *     department. It is NOT the spine department the grant's scope names —
 *     that one is free text on the `users` row and this one is an id — so the
 *     two are labelled separately and never added together.
 *
 * `scope: none` IS NOT AN EMPTY QUEUE. A grant that reaches nobody answers `[]`
 * exactly as a quiet Monday does; scope_views.py's own comment is that "may see
 * everything" and "may see nothing" are opposite facts that must never render
 * the same, so the empty state says which one this is. A response carrying NO
 * scope header at all — the MENTOR path, which `_narrow_to_scope` fences by the
 * mentor's own group and never by a reach — makes no claim on this screen
 * rather than a guessed one; an absent header is not the word "none".
 */

import { DatePipe } from '@angular/common';
import { Component, computed, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';
import { plural } from '../../../shared/text/plural.pipe';

/** The approval chain, attachments, balances, calendar, cancel and the policy
 *  card are B10.1–B10.8, on branch `feat/redesign-p4-leave`. */
const LEAVE_BACKEND_PHASE = 4;

/** The three words `app/scope_views.py` writes into `X-Reep-Scope`. Three and
 *  not a boolean: `programme` and `none` are opposite facts, not two ends of
 *  one scale, and the screen must never render them the same. */
type ScopeWord = 'programme' | 'narrowed' | 'none';

interface ScopeReach {
  word: ScopeWord;
  /** Ids, not names — there is no catalogue on this screen to resolve them
   *  against, so they are counted and never printed. */
  colleges: string[];
  departments: string[];
}

const SCOPE_HEADER = 'X-Reep-Scope';
const SCOPE_COLLEGES_HEADER = 'X-Reep-Scope-Colleges';
const SCOPE_DEPARTMENTS_HEADER = 'X-Reep-Scope-Departments';

/** `MAX_SCOPE_IDS` in app/scope_views.py. The header stops at twenty ids, so a
 *  count standing exactly on it is a floor and is printed as "20+" rather than
 *  as a total this screen cannot know. */
const MAX_SCOPE_IDS = 20;

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

/** The department filter's "no department chosen" value. A sentinel and not the
 *  word "ALL": `requester_department` is free text on the `users` row, so any
 *  readable word is a department somebody could have typed. */
const EVERY_DEPARTMENT = '*';

/** The bucket for a requester with no department on their row. `null` and `''`
 *  are the same fact here — nothing is recorded — so they share one option. */
const NO_DEPARTMENT = '';

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
  readonly kinds = KINDS;
  readonly everyKind = EVERY_KIND;
  readonly everyDepartment = EVERY_DEPARTMENT;
  readonly noDepartment = NO_DEPARTMENT;

  readonly tabs: { key: QueueTab; label: string }[] = [
    { key: 'pending', label: 'Pending' },
    { key: 'approved', label: 'Approved' },
    { key: 'rejected', label: 'Rejected' },
  ];

  readonly tab = signal<QueueTab>('pending');
  readonly kindFilter = signal<string>(EVERY_KIND);
  readonly departmentFilter = signal<string>(EVERY_DEPARTMENT);
  /** What the server said this session's grant reaches, off the queue response.
   *  `null` means the response stated nothing, which is not "nothing". */
  readonly scope = signal<ScopeReach | null>(null);
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

  /** The rows of the open tab, narrowed by the type and department filters.
   *
   *  BOTH NARROW WHAT IS DRAWN, not what may be read: the server has already
   *  decided the second, and neither of these two pills can widen it. */
  readonly rows = computed<LeaveRow[]>(() => {
    let inTab = this.rowsInTab();
    const wantedKind = this.kindFilter();
    if (wantedKind !== EVERY_KIND) {
      inTab = inTab.filter((row) => row.leave_kind === wantedKind);
    }
    const wantedDepartment = this.departmentFilter();
    if (wantedDepartment !== EVERY_DEPARTMENT) {
      inTab = inTab.filter((row) => this.departmentOf(row) === wantedDepartment);
    }
    return inTab;
  });

  /** Every department named on a loaded request, from BOTH queues so the menu
   *  does not change shape when the tab does. */
  readonly departments = computed<string[]>(() => {
    const names = new Set<string>();
    for (const row of [...(this.pending() ?? []), ...(this.history() ?? [])]) {
      const name = this.departmentOf(row);
      if (name !== NO_DEPARTMENT) names.add(name);
    }
    return Array.from(names).sort((left, right) => left.localeCompare(right));
  });

  /** True when some loaded request has no department, so the menu offers that
   *  bucket rather than leaving those rows reachable only under "All". */
  readonly hasUnstatedDepartment = computed(() =>
    [...(this.pending() ?? []), ...(this.history() ?? [])].some(
      (row) => this.departmentOf(row) === NO_DEPARTMENT,
    ),
  );

  readonly departmentFilterLabel = computed(() => {
    const wanted = this.departmentFilter();
    if (wanted === EVERY_DEPARTMENT) return 'All';
    if (wanted === NO_DEPARTMENT) return 'Not on record';
    return wanted;
  });

  readonly selectedRequest = computed<LeaveRow | null>(() => {
    const id = this.selectedId();
    if (id === null) return null;
    return this.rows().find((row) => row.id === id) ?? null;
  });

  /** "Nobody is in your reach" and "nothing is waiting" are the two reasons a
   *  queue is empty, and they are opposite facts about this account. */
  readonly emptyTitle = computed(() =>
    this.scope()?.word === 'none' ? 'Nobody is in your reach.' : 'Nothing here.',
  );

  readonly emptyNote = computed(() => {
    if (this.scope()?.word === 'none') {
      return 'Your grant for leave approvals names no college, department, batch or student, so this queue can never fill — it is not that nothing is waiting.';
    }
    return EMPTY_NOTE[this.tab()];
  });

  /** The College pill: the caller's own reach, as text. */
  readonly scopeChip = computed<{ label: string; tone: 'neutral' | 'accent' | 'warn' } | null>(
    () => {
      const reach = this.scope();
      if (reach === null) return null;
      if (reach.word === 'programme') {
        return { label: 'Reach · every college', tone: 'neutral' };
      }
      if (reach.word === 'none') {
        return { label: 'Reach · nobody', tone: 'warn' };
      }
      const parts = [
        this.idCount(reach.colleges, 'college', 'colleges'),
        this.idCount(reach.departments, 'department', 'departments'),
      ].filter((part) => part !== null);
      if (parts.length === 0) return { label: 'Reach · narrowed', tone: 'accent' };
      return { label: `Reach · ${parts.join(' · ')}`, tone: 'accent' };
    },
  );

  /** The sentence under the filters. It says which of the two pills is a fact
   *  about permission and which is a fact about what is drawn. */
  readonly scopeNote = computed<{ text: string; tone: 'accent' | 'warn' } | null>(() => {
    const reach = this.scope();
    if (reach === null) return null;
    if (reach.word === 'programme') {
      return {
        tone: 'accent',
        text: 'Your grant reaches the whole programme — every college and department, staff leave included. The College pill states that; it is a read-out, not a filter, because the queue arrives already cut to what you may see. Department narrows what is drawn here and nothing else.',
      };
    }
    if (reach.word === 'none') {
      return {
        tone: 'warn',
        text: 'Your grant for leave approvals reaches nobody: it names no college, department, batch or student that still exists. The queue below is empty for that reason, not because no request is waiting. A Main Admin can give the grant a scope in Governance.',
      };
    }
    return {
      tone: 'accent',
      text: 'Your grant is narrowed, and the server has already cut this queue to it — the College pill counts what it reaches. Department below narrows what is drawn here; it is the department printed on the request, which is the requester\u2019s own, not the one your grant names.',
    };
  });

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

  setDepartmentFilter(department: string): void {
    this.departmentFilter.set(department);
    this.clearSelection();
  }

  /** One bucket per requester: an absent, null or blank department is the same
   *  fact and must not become two options that each hold some of the rows. */
  private departmentOf(row: LeaveRow): string {
    return (row.requester_department ?? '').trim();
  }

  /** "3 departments", or "20+ colleges" when the header stood on its cap. */
  private idCount(ids: string[], one: string, many: string): string | null {
    if (ids.length === 0) return null;
    const capped = ids.length >= MAX_SCOPE_IDS ? `${MAX_SCOPE_IDS}+` : `${ids.length}`;
    return `${capped} ${ids.length === 1 ? one : many}`;
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
    return plural(days, 'day');
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
      this.scope.set(this.readScope(pendingResponse) ?? this.readScope(historyResponse));
      this.pending.set((await pendingResponse.json()) as LeaveRow[]);
      this.history.set((await historyResponse.json()) as LeaveRow[]);
    } catch {
      this.error.set('Could not reach the server.');
      this.scope.set(null);
      this.pending.set([]);
      this.history.set([]);
    }
  }

  /** The reach the server stated on this response, or `null` when it stated
   *  none. Readable because the SPA is same-origin through proxy.conf.json —
   *  a cross-origin fetch would need these three names on the CORS allowlist.
   *
   *  AN UNRECOGNISED WORD IS `null`, NOT A GUESS. The one thing this screen
   *  must never do is read a header it does not understand as "none" and tell
   *  an approver their grant reaches nobody. */
  private readScope(response: Response): ScopeReach | null {
    const word = response.headers.get(SCOPE_HEADER);
    if (word !== 'programme' && word !== 'narrowed' && word !== 'none') return null;
    return {
      word,
      colleges: this.scopeIds(response.headers.get(SCOPE_COLLEGES_HEADER)),
      departments: this.scopeIds(response.headers.get(SCOPE_DEPARTMENTS_HEADER)),
    };
  }

  private scopeIds(raw: string | null): string[] {
    if (raw === null) return [];
    return raw
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
  }
}
