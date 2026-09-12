/**
 * Registrations — the Main Admin's review queue (spec §10, board
 * `design/admin/Registrations.html`).
 *
 * WHAT APPROVAL ACTUALLY DOES, because this screen used to say the opposite.
 * `POST /api/register/{id}/decision` with APPROVE now mints the User row, the
 * Student row seated in the rule's batch and a profile row, moves the CV and
 * photo onto that student's uploads, and emails the onboarding link — all in
 * one transaction (`_provision_student` in `app/routers/registration.py`, and
 * AGENTS.md, "Approval provisions, and two guards make that safe"). The copy
 * here said "Approval PROVISIONS NOTHING on its own" and "creating the Student
 * row is a separate step server-side", which was true of the endpoint that
 * shipped first and has been wrong since. That is B11.4, and it is the one
 * task on this screen that is a client change: it is fixed here.
 *
 * WHAT IS LIVE, AND ON WHICH ENDPOINT.
 *   GET  /api/register/pending            the queue (PENDING_REVIEW only)
 *   POST /api/register/{id}/decision      approve, and reject WITH A REASON —
 *                                         the API answers 422 without one and
 *                                         this screen refuses before posting
 *   POST /api/register/{id}/reopen        the board's Undo, rejected rows only
 *   GET  /api/register/rules              the Seating rules drawer, read-only
 *   GET  /api/register/hierarchy          batch names for the queue and the
 *                                         College / Batch filters (public, and
 *                                         reachable by a grantee who holds
 *                                         `admin.registrations` and nothing
 *                                         else — `/api/admin/cohorts` is not,
 *                                         it asks for `admin.analytics`)
 *
 * WHAT IS NOT, AND WHY IT IS DRAWN DISABLED RATHER THAN LIVE. The board's other
 * three tabs (Auto-approved, Held, Rejected) need a queue that can be listed by
 * status; its Domain check filter needs the college's registered domains; its
 * Checks panel needs the domain, duplicate-account and seat verdicts; and Hold
 * needs a status that does not exist. Those are B11.1 and B11.2, both Phase 4.
 * Every one of them renders as a disabled control saying so, beside the checks
 * this screen CAN compute from the payload it already has — the rule engine's
 * own verdict, the batch it routed to, and what the applicant attached.
 *
 * BULK IS THE LOOP, deliberately. There is no bulk decision endpoint; "Approve
 * 3 selected" is three POSTs and the notice says how many landed. A failure
 * stops the run rather than pressing on, because the reviewer needs to know
 * which application refused and why.
 */

import { DatePipe } from '@angular/common';
import { Component, computed, signal } from '@angular/core';
import { AgGridAngular } from 'ag-grid-angular';
import type {
  CellClickedEvent,
  ColDef,
  GetQuickFilterTextParams,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  ICellRendererParams,
  IRowNode,
  ProcessCellForExportParams,
  RowSelectionOptions,
  SelectionColumnDef,
  ValueFormatterParams,
} from 'ag-grid-community';

import { environment } from '../../../../environments/environment';
import { registerReepGrid } from '../../../shared/grid/grid-bootstrap';
import { reepGridTheme, reepGridThemeCompact } from '../../../shared/grid/reep-grid-theme';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';
import { plural } from '../../../shared/text/plural.pipe';

// ----------------------------------------------------------------- rules --

/** The phase that lands B11.1 (college scope, domain and duplicate checks),
 *  B11.2 (HOLD) and B11.3 (rules CRUD) — 06-phase-prompts.md, Phase 4. */
const REGISTRATIONS_BACKEND_PHASE = 4;

/** The board's "Submitted" filter. Client-side, over the rows already loaded —
 *  `GET /pending` takes no date parameter. */
const SUBMITTED_WINDOWS: { key: string; label: string; days: number | null }[] = [
  { key: 'all', label: 'Any time', days: null },
  { key: 'week', label: 'Last 7 days', days: 7 },
  { key: 'month', label: 'Last 30 days', days: 30 },
  { key: 'quarter', label: 'Last 90 days', days: 90 },
];

const HOURS_IN_A_DAY = 24;
const MINUTES_IN_AN_HOUR = 60;
const SECONDS_IN_A_MINUTE = 60;
const MILLISECONDS_IN_A_SECOND = 1000;
const MILLISECONDS_IN_A_DAY =
  HOURS_IN_A_DAY * MINUTES_IN_AN_HOUR * SECONDS_IN_A_MINUTE * MILLISECONDS_IN_A_SECOND;

const PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_PAGE_SIZE = 10;

/** Rows per page in the comfortable and the compact density (01 §4). */
const COMFORTABLE_ROW_HEIGHT_PX = 40;
const COMPACT_ROW_HEIGHT_PX = 36;

/** Every college in the queue, every batch in the queue. */
const EVERY_COLLEGE = '';
const EVERY_BATCH = '';

/** What a field the application never carried reads as. Never a zero and never
 *  a guess: a missing USN and a wrong one are different facts. */
const NOT_ON_RECORD = 'Not on record';

// ------------------------------------------------------- the API payloads --

/** `RegistrationOut` in `app/routers/registration.py`. */
interface RegistrationApiRow {
  id: string;
  name: string;
  email: string;
  usn: string | null;
  degree_level: string;
  status: string;
  cohort_id: string | null;
  matched_rule_id: string | null;
  /** The rule engine's own verdict sentence, written at submit time. */
  decision_reason: string | null;
  created_at: string;
  /** Kinds attached with the application: "CV", "PHOTO". */
  documents: string[];
  college_name: string | null;
  department_name: string | null;
  course_name: string | null;
  specialization_name: string | null;
  /** The batch the APPLICANT asked for; `cohort_id` is the rule's, and wins. */
  requested_batch: string | null;
}

/** `RuleOut` in `app/routers/registration.py`. */
interface SeatingRuleApiRow {
  id: string;
  name: string;
  enabled: boolean;
  email_domain: string | null;
  usn_pattern: string | null;
  degree_level: string | null;
  cohort_id: string | null;
  auto_approve: boolean;
  priority: number;
}

/** `PublicHierarchyOut` in `app/routers/registration.py`, narrowed to the two
 *  levels this screen names: the college and the batch. */
interface HierarchyBatch {
  id: string;
  name: string;
  batch_label: string;
}
interface HierarchyDepartment {
  batches: HierarchyBatch[];
}
interface HierarchyCollege {
  id: string;
  name: string;
  departments: HierarchyDepartment[];
}

// ------------------------------------------------- what the screen holds --

/** One row of the grid: the application plus everything a cell draws, resolved
 *  once here rather than in a renderer that runs on every repaint. */
interface QueueRow {
  registrationId: string;
  name: string;
  email: string;
  initials: string;
  usn: string | null;
  emailDomain: string;
  submittedAt: string;
  submittedLabel: string;
  collegeName: string | null;
  batchLabel: string;
  documentsLabel: string;
  documentsTone: string;
  ruleLabel: string;
  ruleTone: string;
  application: RegistrationApiRow;
}

/** One line of the panel's Checks list. Only checks this screen can actually
 *  compute appear here; the rest are named in the notice under them. */
interface ApplicationCheck {
  headline: string;
  detail: string;
  tone: 'good' | 'warn' | 'neutral';
  icon: string;
}

/** A seating rule as the drawer reads it out. */
interface SeatingRuleLine {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  autoApprove: boolean;
  conditions: string;
  seatsIn: string;
}

// --------------------------------------------------------- cell renderers --
//
// AG Grid builds cell contents itself, outside Angular's template compiler, so
// a component-scoped class never reaches them. These renderers use GLOBAL
// classes (`.chip`, `.avatar` in styles/reep-v2.scss) and inline styles,
// exactly as the roster grid on Students & batches does.

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderApplicantCell(params: ICellRendererParams<QueueRow>): string {
  const row = params.data;
  if (row === undefined) return '';
  return (
    `<span class="avatar">${escapeHtml(row.initials)}</span>` +
    `<span style="display: inline-flex; flex-direction: column; line-height: 1.25; min-width: 0;">` +
    `<span style="font-weight: 600; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(row.name)}</span>` +
    `<span style="font-size: 11px; color: var(--faint); overflow: hidden; text-overflow: ellipsis;">${escapeHtml(row.email)}</span>` +
    `</span>`
  );
}

function renderUsnCell(params: ICellRendererParams<QueueRow>): string {
  const row = params.data;
  if (row === undefined) return '';
  if (row.usn === null) {
    return `<span style="color: var(--faint);">${NOT_ON_RECORD}</span>`;
  }
  return `<span style="font-variant-numeric: tabular-nums; letter-spacing: 0.01em;">${escapeHtml(row.usn)}</span>`;
}

/**
 * The domain the onboarding link will be sent to — a VALUE, not a verdict.
 *
 * The board colours this cell green or red by whether the domain is one of the
 * college's registered ones. Nothing on main holds that list (B11.1), so a
 * green chip here would be a judgement no code made. It is neutral until the
 * check exists, and the column header says why.
 */
function renderEmailDomainCell(params: ICellRendererParams<QueueRow>): string {
  const row = params.data;
  if (row === undefined) return '';
  return `<span class="chip neutral">${escapeHtml(row.emailDomain)}</span>`;
}

function renderDocumentsCell(params: ICellRendererParams<QueueRow>): string {
  const row = params.data;
  if (row === undefined) return '';
  return `<span class="chip dot ${row.documentsTone}">${escapeHtml(row.documentsLabel)}</span>`;
}

function renderRuleCell(params: ICellRendererParams<QueueRow>): string {
  const row = params.data;
  if (row === undefined) return '';
  return `<span class="chip dot ${row.ruleTone}">${escapeHtml(row.ruleLabel)}</span>`;
}

// ----------------------------------------------------------- the CSV file --

/**
 * A cell a spreadsheet must read as TEXT, never as a formula.
 *
 * Excel, Sheets and LibreOffice evaluate any cell whose value BEGINS with
 * `=`, `+`, `-` or `@` — and with a tab or carriage return, which get eaten on
 * the way in and leave the next character leading. So an applicant who types
 * `=HYPERLINK("http://evil","click")` into the name field of the PUBLIC
 * registration form has written live code into the office's spreadsheet. The
 * values in this export are the least trustworthy input in the product:
 * members of the public type every one of them, and nobody reviews the string
 * before the reviewer double-clicks the file.
 *
 * AG Grid wraps every value in double quotes and doubles the quotes inside it,
 * which makes the file parse correctly — quoting is not what stops a formula,
 * because a spreadsheet strips the quotes and then evaluates what is left.
 *
 * THE APOSTROPHE BELOW IS DELIBERATE AND IT IS NOT A BUG. A leading `'` is the
 * spreadsheets' own "the rest of this cell is text" marker: it lands INSIDE
 * the quotes AG Grid adds, so the file reads `"'=HYPERLINK(…)"`, and Excel and
 * Sheets show the cell as the literal text without displaying the apostrophe.
 * Anyone opening the CSV in a text editor will see it; that is the cost, and
 * it is the standard one. Cells that do not start with one of those characters
 * are passed through untouched.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function csvCellAsText(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}

/** What the quick filter matches on the Applicant column: the name AND the
 *  address the cell draws. */
function quickFilterApplicant(params: GetQuickFilterTextParams<QueueRow>): string {
  const row = params.data;
  if (row === undefined) return '';
  return `${row.name} ${row.email}`;
}

function formatSubmitted(params: ValueFormatterParams<QueueRow, string>): string {
  return params.data?.submittedLabel ?? '';
}

/** Sort Submitted by the timestamp, never by the "10 Sep" the cell shows. */
function compareSubmitted(
  _valueA: string,
  _valueB: string,
  nodeA: IRowNode<QueueRow>,
  nodeB: IRowNode<QueueRow>,
): number {
  const first = nodeA.data?.submittedAt ?? '';
  const second = nodeB.data?.submittedAt ?? '';
  if (first === second) return 0;
  if (first < second) return -1;
  return 1;
}

// ----------------------------------------------------------------- helpers --

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function emailDomainOf(email: string): string {
  const at = email.lastIndexOf('@');
  if (at === -1 || at === email.length - 1) return 'No domain';
  return email.slice(at + 1).toLowerCase();
}

function documentsLabelOf(kinds: string[]): string {
  const attached = new Set(kinds);
  if (attached.has('CV') && attached.has('PHOTO')) return 'CV + photo';
  if (attached.has('CV')) return 'CV only';
  if (attached.has('PHOTO')) return 'Photo only';
  return 'None';
}

function documentsToneOf(kinds: string[]): string {
  const attached = new Set(kinds);
  if (attached.has('CV') && attached.has('PHOTO')) return 'good';
  if (attached.size > 0) return 'warn';
  return 'neutral';
}

function shortDateOf(isoTimestamp: string): string {
  const submitted = new Date(isoTimestamp);
  if (Number.isNaN(submitted.getTime())) return isoTimestamp;
  return submitted.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

// ------------------------------------------------------------- the screen --

@Component({
  selector: 'app-admin-registrations',
  standalone: true,
  imports: [DatePipe, AgGridAngular, PendingControlDirective],
  templateUrl: './registrations.component.html',
  styleUrl: './registrations.component.scss',
})
export class AdminRegistrationsComponent {
  readonly backendPhase = REGISTRATIONS_BACKEND_PHASE;
  readonly submittedWindows = SUBMITTED_WINDOWS;
  readonly pageSizes = PAGE_SIZES;
  readonly everyCollege = EVERY_COLLEGE;
  readonly everyBatch = EVERY_BATCH;

  // --- what the server said ---------------------------------------------

  readonly applications = signal<RegistrationApiRow[] | null>(null);
  readonly batchNames = signal<Map<string, string>>(new Map());
  readonly seatingRules = signal<SeatingRuleLine[] | null>(null);
  readonly seatingRulesError = signal<string | null>(null);

  // --- what the reviewer is doing ---------------------------------------

  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);
  readonly deciding = signal(false);
  readonly undoing = signal(false);
  readonly quickFilter = signal('');
  readonly collegeFilter = signal(EVERY_COLLEGE);
  readonly batchFilter = signal(EVERY_BATCH);
  readonly submittedFilter = signal(SUBMITTED_WINDOWS[0].key);
  readonly decisionNote = signal('');
  readonly noteError = signal<string | null>(null);
  readonly seatingRulesOpen = signal(false);
  readonly columnsPanelOpen = signal(false);
  readonly isCompact = signal(false);
  readonly pageSize = signal(DEFAULT_PAGE_SIZE);

  /** The application whose detail the panel shows when nothing is ticked. */
  readonly focusedRegistrationId = signal<string | null>(null);
  readonly selectedRows = signal<QueueRow[]>([]);

  /** The rejections the last action made, for the board's Undo. A rejection
   *  only stamps a row, so reopening it is exact; an APPROVE provisions a real
   *  account and emails its owner, and `POST /reopen` refuses it with 409. */
  readonly lastRejected = signal<RegistrationApiRow[]>([]);

  // --- the grid's own state ----------------------------------------------

  private gridApi: GridApi<QueueRow> | null = null;
  readonly filteredRowCount = signal(0);
  readonly currentPage = signal(0);
  readonly totalPages = signal(1);
  readonly hiddenColumnIds = signal<Set<string>>(new Set());

  constructor() {
    registerReepGrid();
    void this.loadQueue();
    void this.loadBatchNames();
    void this.loadSeatingRules();
  }

  // ============================================================ the rows ====

  readonly rows = computed<QueueRow[]>(() => {
    const loaded = this.applications();
    if (loaded === null) return [];
    return loaded.map((application) => this.toQueueRow(application));
  });

  private toQueueRow(application: RegistrationApiRow): QueueRow {
    return {
      registrationId: application.id,
      name: application.name,
      email: application.email,
      initials: initialsOf(application.name),
      usn: application.usn,
      emailDomain: emailDomainOf(application.email),
      submittedAt: application.created_at,
      submittedLabel: shortDateOf(application.created_at),
      collegeName: application.college_name,
      batchLabel: this.batchLabelOf(application),
      documentsLabel: documentsLabelOf(application.documents),
      documentsTone: documentsToneOf(application.documents),
      ruleLabel: application.matched_rule_id === null ? 'Needs a decision' : 'Rule matched',
      ruleTone: application.matched_rule_id === null ? 'warn' : 'good',
      application,
    };
  }

  /** THE BATCH IS THE PROGRAMME, when a rule chose one. With no batch, the
   *  degree level is all the application knows, and that is what is shown. */
  batchLabelOf(application: RegistrationApiRow): string {
    if (application.cohort_id === null) {
      return `${application.degree_level} · no batch yet`;
    }
    const named = this.batchNames().get(application.cohort_id);
    if (named === undefined) {
      return `${application.degree_level} · batch ${application.cohort_id.slice(0, 8)}`;
    }
    return named;
  }

  readonly waitingCount = computed(() => this.rows().length);

  readonly collegeOptions = computed(() => {
    const named = new Set<string>();
    for (const row of this.rows()) {
      if (row.collegeName !== null) named.add(row.collegeName);
    }
    return [...named].sort();
  });

  readonly batchOptions = computed(() => {
    const named = new Set<string>();
    for (const row of this.rows()) {
      named.add(row.batchLabel);
    }
    return [...named].sort();
  });

  /** The three client-side filters the board draws above the grid. The quick
   *  filter is the grid's own and is not repeated here. */
  readonly visibleRows = computed(() => {
    const college = this.collegeFilter();
    const batch = this.batchFilter();
    const window = this.submittedWindow();
    return this.rows().filter((row) => {
      if (college !== EVERY_COLLEGE && row.collegeName !== college) return false;
      if (batch !== EVERY_BATCH && row.batchLabel !== batch) return false;
      if (!this.wasSubmittedWithin(row, window)) return false;
      return true;
    });
  });

  private submittedWindow(): number | null {
    const chosen = SUBMITTED_WINDOWS.find((window) => window.key === this.submittedFilter());
    if (chosen === undefined) return null;
    return chosen.days;
  }

  private wasSubmittedWithin(row: QueueRow, days: number | null): boolean {
    if (days === null) return true;
    const submitted = new Date(row.submittedAt).getTime();
    if (Number.isNaN(submitted)) return true;
    return Date.now() - submitted <= days * MILLISECONDS_IN_A_DAY;
  }

  readonly collegeFilterLabel = computed(() => {
    const chosen = this.collegeFilter();
    if (chosen === EVERY_COLLEGE) return 'All colleges';
    return chosen;
  });

  readonly batchFilterLabel = computed(() => {
    const chosen = this.batchFilter();
    if (chosen === EVERY_BATCH) return 'All batches';
    return chosen;
  });

  readonly submittedFilterLabel = computed(() => {
    const chosen = SUBMITTED_WINDOWS.find((window) => window.key === this.submittedFilter());
    if (chosen === undefined) return SUBMITTED_WINDOWS[0].label;
    return chosen.label;
  });

  readonly isLoading = computed(() => this.applications() === null);

  /** What the queue says when the rule engine routed everything itself. Derived
   *  from the rules that are actually on record — never a sentence about a
   *  domain or a USN pattern this deployment may not have. */
  readonly autoApproveLine = computed(() => {
    // A FAILED READ IS NOT A FACT. `loadSeatingRules` sets an empty list on a
    // failure so the drawer can render its error, and the sentence below would
    // then read "No seating rule auto-approves" — a claim about a rule set this
    // screen never saw, printed where the board puts a fact. Silence instead;
    // the drawer carries the error in words.
    if (this.seatingRulesError() !== null) return null;
    const rules = this.seatingRules();
    if (rules === null) return null;
    const automatic = rules.filter((rule) => rule.enabled && rule.autoApprove);
    if (automatic.length === 0) {
      return 'No seating rule auto-approves, so every application waits here for a decision.';
    }
    const counted = plural(automatic.length, 'seating rule auto-approves', 'seating rules auto-approve');
    return `${counted}; everything else waits here for a decision.`;
  });

  // ==================================================== what a decision hits ==

  /** Ticked rows win; with nothing ticked, the row the reviewer clicked. */
  readonly decisionTargets = computed<QueueRow[]>(() => {
    const ticked = this.selectedRows();
    if (ticked.length > 0) return ticked;
    const focusedId = this.focusedRegistrationId();
    if (focusedId === null) return [];
    const focused = this.visibleRows().find((row) => row.registrationId === focusedId);
    if (focused === undefined) return [];
    return [focused];
  });

  readonly hasDecisionTarget = computed(() => this.decisionTargets().length > 0);
  readonly isReviewingOne = computed(() => this.decisionTargets().length === 1);
  readonly reviewedApplication = computed<QueueRow | null>(() => {
    const targets = this.decisionTargets();
    if (targets.length !== 1) return null;
    return targets[0];
  });

  readonly decisionSummary = computed(() => plural(this.decisionTargets().length, 'application'));

  readonly selectedCount = computed(() => this.selectedRows().length);

  readonly approveButtonLabel = computed(() => {
    const count = this.decisionTargets().length;
    if (count <= 1) return 'Approve & invite';
    return `Approve & invite ${count}`;
  });

  /** The checks this screen can actually make, from the payload it already
   *  holds. The rest — domain against the college's registered domains, a
   *  duplicate account, the seat count — are B11.1 and are named in the notice
   *  beneath, not invented here. */
  readonly checks = computed<ApplicationCheck[]>(() => {
    const reviewed = this.reviewedApplication();
    if (reviewed === null) return [];
    const application = reviewed.application;
    const checks: ApplicationCheck[] = [];
    checks.push(this.ruleCheckFor(application));
    checks.push(this.batchCheckFor(application, reviewed.batchLabel));
    checks.push(this.documentCheckFor(application, 'CV', 'CV'));
    checks.push(this.documentCheckFor(application, 'PHOTO', 'Photo'));
    checks.push({
      headline: `The onboarding link goes to ${reviewed.emailDomain}`,
      detail: `${application.email} becomes the login on this account.`,
      tone: 'neutral',
      icon: 'mail',
    });
    return checks;
  });

  private ruleCheckFor(application: RegistrationApiRow): ApplicationCheck {
    const verdict = application.decision_reason ?? 'The rule engine recorded no verdict.';
    if (application.matched_rule_id === null) {
      return {
        headline: 'No seating rule matched',
        detail: verdict,
        tone: 'warn',
        icon: 'warning',
      };
    }
    return {
      headline: 'A seating rule routed this application',
      detail: verdict,
      tone: 'good',
      icon: 'check_circle',
    };
  }

  private batchCheckFor(application: RegistrationApiRow, batchLabel: string): ApplicationCheck {
    const asked = application.requested_batch;
    if (application.cohort_id === null) {
      return {
        headline: 'No batch on this application',
        detail:
          asked === null
            ? 'The applicant named no batch. Approving seats them unseated; Students & batches can move them.'
            : `The applicant asked for ${asked}, and no rule confirmed it.`,
        tone: 'warn',
        icon: 'warning',
      };
    }
    if (asked !== null && asked !== batchLabel) {
      return {
        headline: `Approving seats them in ${batchLabel}`,
        detail: `The applicant asked for ${asked}; the rule's batch wins.`,
        tone: 'warn',
        icon: 'warning',
      };
    }
    return {
      headline: `Approving seats them in ${batchLabel}`,
      detail: 'The batch the rule engine chose when the form was submitted.',
      tone: 'good',
      icon: 'check_circle',
    };
  }

  private documentCheckFor(
    application: RegistrationApiRow,
    kind: string,
    label: string,
  ): ApplicationCheck {
    const attached = application.documents.includes(kind);
    if (attached) {
      return {
        headline: `${label} attached`,
        detail: `It moves onto the student's own uploads when this application is approved.`,
        tone: 'good',
        icon: 'check_circle',
      };
    }
    return {
      headline: `No ${label.toLowerCase()} attached`,
      detail: 'The student can upload one themselves after onboarding.',
      tone: 'warn',
      icon: 'warning',
    };
  }

  // ======================================================= grid options ====

  readonly gridTheme = computed(() => {
    if (this.isCompact()) return reepGridThemeCompact;
    return reepGridTheme;
  });

  readonly rowHeight = computed(() => {
    if (this.isCompact()) return COMPACT_ROW_HEIGHT_PX;
    return COMFORTABLE_ROW_HEIGHT_PX;
  });

  readonly rowSelection: RowSelectionOptions<QueueRow> = {
    mode: 'multiRow',
    checkboxes: true,
    headerCheckbox: true,
    // Ticking is a deliberate act: the toolbar decides on the ticked rows, so a
    // click meant to READ an application must not add it to a bulk approval.
    enableClickSelection: false,
  };

  /** The tick column travels with the pinned Applicant column rather than
   *  scrolling away from the row it selects. */
  readonly selectionColumn: SelectionColumnDef = { pinned: 'left', width: 44 };

  readonly defaultColumn: ColDef<QueueRow> = {
    sortable: true,
    resizable: true,
    filter: true,
    floatingFilter: true,
  };

  readonly columns: ColDef<QueueRow>[] = [
    {
      colId: 'applicant',
      field: 'name',
      headerName: 'Applicant',
      pinned: 'left',
      minWidth: 240,
      flex: 1.4,
      cellStyle: { display: 'flex', alignItems: 'center', gap: '8px' },
      cellRenderer: renderApplicantCell,
      // THE EMAIL IS DRAWN BY A RENDERER, AND THE QUICK FILTER CANNOT SEE ONE.
      // AG Grid matches against column VALUES, and this column's value is the
      // name; the address only exists inside the renderer's HTML. So typing an
      // applicant's address into a box whose label promises "name, email or
      // USN" found nothing at all. This is what the filter reads instead.
      getQuickFilterText: quickFilterApplicant,
    },
    {
      colId: 'usn',
      field: 'usn',
      headerName: 'USN',
      minWidth: 160,
      cellRenderer: renderUsnCell,
      headerTooltip: 'The USN the applicant typed on the public form',
    },
    {
      colId: 'emailDomain',
      field: 'emailDomain',
      headerName: 'Email domain',
      minWidth: 170,
      cellRenderer: renderEmailDomainCell,
      headerTooltip:
        'The domain the onboarding link goes to. Whether it is one of the college’s registered domains is B11.1 (Phase 4), so no verdict is shown.',
    },
    {
      colId: 'submitted',
      field: 'submittedLabel',
      headerName: 'Submitted',
      minWidth: 130,
      valueFormatter: formatSubmitted,
      comparator: compareSubmitted,
    },
    {
      colId: 'documents',
      field: 'documentsLabel',
      headerName: 'Documents',
      minWidth: 150,
      cellRenderer: renderDocumentsCell,
      headerTooltip: 'What the applicant attached: a CV, a photo, both or neither',
    },
    {
      colId: 'rule',
      field: 'ruleLabel',
      headerName: 'Rule',
      minWidth: 160,
      cellRenderer: renderRuleCell,
      headerTooltip:
        'Whether a seating rule routed this application. The domain, duplicate-account and seat checks the board draws are B11.1 (Phase 4).',
    },
  ];

  /** What the Columns popover lists. The selection column is the grid's own. */
  readonly toggleableColumns = this.columns.map((column) => ({
    id: column.colId ?? '',
    label: column.headerName ?? '',
  }));

  readonly rowId = (params: GetRowIdParams<QueueRow>): string => params.data.registrationId;

  readonly emptyOverlay = computed(() => {
    if (this.waitingCount() === 0) {
      return '<span class="ag-overlay-no-rows-center">No applications waiting.</span>';
    }
    return '<span class="ag-overlay-no-rows-center">No registration matches this filter.</span>';
  });

  // ---- the grid's events -------------------------------------------------

  onGridReady(event: GridReadyEvent<QueueRow>): void {
    this.gridApi = event.api;
    this.readPaginationState();
  }

  onSelectionChanged(): void {
    if (this.gridApi === null) return;
    this.selectedRows.set(this.gridApi.getSelectedRows());
    this.noteError.set(null);
  }

  onCellClicked(event: CellClickedEvent<QueueRow>): void {
    if (event.data === undefined) return;
    this.focusedRegistrationId.set(event.data.registrationId);
    this.noteError.set(null);
  }

  onPaginationChanged(): void {
    this.readPaginationState();
  }

  private readPaginationState(): void {
    if (this.gridApi === null) return;
    this.filteredRowCount.set(this.gridApi.paginationGetRowCount());
    this.currentPage.set(this.gridApi.paginationGetCurrentPage());
    this.totalPages.set(this.gridApi.paginationGetTotalPages());
  }

  readonly isFirstPage = computed(() => this.currentPage() === 0);
  readonly isLastPage = computed(() => this.currentPage() >= this.totalPages() - 1);

  readonly rowRangeLabel = computed(() => {
    const total = this.filteredRowCount();
    if (total === 0) return '0 of 0';
    const first = this.currentPage() * this.pageSize() + 1;
    const last = Math.min(total, (this.currentPage() + 1) * this.pageSize());
    return `${first} to ${last} of ${total}`;
  });

  readonly pagerLabel = computed(() => `Page ${this.currentPage() + 1} of ${Math.max(1, this.totalPages())}`);

  goToPreviousPage(): void {
    this.gridApi?.paginationGoToPreviousPage();
  }

  goToNextPage(): void {
    this.gridApi?.paginationGoToNextPage();
  }

  setPageSize(size: number): void {
    this.pageSize.set(size);
  }

  toggleDensity(): void {
    this.isCompact.update((compact) => !compact);
    this.gridApi?.resetRowHeights();
  }

  toggleColumnsPanel(): void {
    this.columnsPanelOpen.update((open) => !open);
  }

  isColumnVisible(columnId: string): boolean {
    return !this.hiddenColumnIds().has(columnId);
  }

  toggleColumn(columnId: string): void {
    const wasVisible = this.isColumnVisible(columnId);
    this.hiddenColumnIds.update((hidden) => {
      const next = new Set(hidden);
      if (wasVisible) next.add(columnId);
      else next.delete(columnId);
      return next;
    });
    this.gridApi?.setColumnsVisible([columnId], !wasVisible);
  }

  /**
   * The board's Export: the rows in view, as the reviewer filtered them. No
   * endpoint is involved — the grid writes the file.
   *
   * `processCellCallback` is the hook where a cell is serialised, so it is
   * where the formula guard belongs — one place, every column, rather than a
   * rule each row builder has to remember. `formatValue` is called first
   * because the callback path hands over the RAW value: without it the
   * Submitted column would export past its own `valueFormatter`.
   */
  exportVisibleRows(): void {
    this.gridApi?.exportDataAsCsv({
      fileName: 'reep-registrations.csv',
      processCellCallback: (params: ProcessCellForExportParams<QueueRow>): string =>
        csvCellAsText(params.formatValue(params.value) ?? ''),
    });
  }

  // ------- the plain inputs the template binds --------------------------

  onQuickFilterInput(event: Event): void {
    this.quickFilter.set(this.inputValue(event));
  }

  onDecisionNoteInput(event: Event): void {
    this.decisionNote.set(this.inputValue(event));
    this.noteError.set(null);
  }

  setCollegeFilter(value: string): void {
    this.collegeFilter.set(value);
  }

  setBatchFilter(value: string): void {
    this.batchFilter.set(value);
  }

  setSubmittedFilter(value: string): void {
    this.submittedFilter.set(value);
  }

  inputValue(event: Event): string {
    const input = event.target as HTMLInputElement | HTMLTextAreaElement;
    return input.value;
  }

  selectValue(event: Event): string {
    const select = event.target as HTMLSelectElement;
    return select.value;
  }

  numberValue(event: Event): number {
    const select = event.target as HTMLSelectElement;
    return Number(select.value);
  }

  clearReview(): void {
    this.focusedRegistrationId.set(null);
    this.noteError.set(null);
    this.gridApi?.deselectAll();
    this.selectedRows.set([]);
  }

  // ========================================================= the decisions ==

  /**
   * Approve, carrying the note if one was typed.
   *
   * `decide()` stores `body.note` as `review_note` on EVERY decision, not only
   * on a rejection (`app/routers/registration.py`), and that row is the record
   * of why this application was let through. Sending `null` here regardless
   * threw away what the reviewer had already typed into a box labelled
   * "Decision note", silently, at the moment they committed the decision.
   * Empty stays `null` rather than `''` — a note nobody wrote is not a note.
   */
  async approveTargets(): Promise<void> {
    const targets = this.decisionTargets();
    if (targets.length === 0) return;
    const note = this.decisionNote().trim();
    await this.decide(targets, 'APPROVE', note === '' ? null : note);
  }

  /**
   * Reject, with the reason the API demands.
   *
   * `POST /decision` answers 422 — `detail` as a LIST, which is why `detailOf`
   * exists — when REJECT arrives without a note, and a rejected applicant is
   * not a user, so that note is the only channel the product has to them. The
   * screen refuses first, in the same words the server uses.
   */
  async rejectTargets(): Promise<void> {
    const targets = this.decisionTargets();
    if (targets.length === 0) return;
    const reason = this.decisionNote().trim();
    if (reason === '') {
      this.noteError.set('A reason is required when rejecting an application.');
      return;
    }
    await this.decide(targets, 'REJECT', reason);
  }

  private async decide(
    targets: QueueRow[],
    decision: 'APPROVE' | 'REJECT',
    note: string | null,
  ): Promise<void> {
    this.deciding.set(true);
    this.error.set(null);
    this.flash.set(null);
    const decided: RegistrationApiRow[] = [];
    try {
      for (const target of targets) {
        const response = await fetch(
          `${environment.apiBase}/register/${target.registrationId}/decision`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision, note }),
          },
        );
        if (!response.ok) {
          this.error.set(await detailOf(response));
          break;
        }
        decided.push(target.application);
      }
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.deciding.set(false);
    }
    if (decided.length === 0) return;
    this.dropDecidedRows(decided);
    this.flash.set(this.decisionLineFor(decided, decision));
    if (decision === 'REJECT') this.lastRejected.set(decided);
    else this.lastRejected.set([]);
  }

  private dropDecidedRows(decided: RegistrationApiRow[]): void {
    const decidedIds = new Set(decided.map((application) => application.id));
    this.applications.update((loaded) =>
      (loaded ?? []).filter((application) => !decidedIds.has(application.id)),
    );
    this.decisionNote.set('');
    this.noteError.set(null);
    this.focusedRegistrationId.set(null);
    this.gridApi?.deselectAll();
    this.selectedRows.set([]);
  }

  /**
   * What the reviewer is told, and it is no longer wrong.
   *
   * Approval provisions the account and emails the onboarding link — three
   * steps on one URL that end at the ordinary sign-in (AGENTS.md). The old
   * line said the student should "sign in with Google", which is a different
   * door from the one the mail actually opens.
   */
  private decisionLineFor(decided: RegistrationApiRow[], decision: 'APPROVE' | 'REJECT'): string {
    const who =
      decided.length <= 3
        ? decided.map((application) => application.name).join(', ')
        : `${decided.length} applicants`;
    if (decision === 'APPROVE') {
      return `${who} approved — the account is created and the onboarding link is on its way to their college email.`;
    }
    return `${who} rejected — your reason has been emailed to them.`;
  }

  /** Reopen the rejections the last action made. One request per row; rows that
   *  reopen return to the queue. */
  async undoLastRejection(): Promise<void> {
    const rejected = this.lastRejected();
    if (rejected.length === 0 || this.undoing()) return;
    this.undoing.set(true);
    this.error.set(null);
    const reopened: RegistrationApiRow[] = [];
    try {
      for (const application of rejected) {
        const response = await fetch(
          `${environment.apiBase}/register/${application.id}/reopen`,
          { method: 'POST', credentials: 'include' },
        );
        if (!response.ok) {
          this.error.set(await detailOf(response));
          break;
        }
        reopened.push((await response.json()) as RegistrationApiRow);
      }
    } catch {
      this.error.set('Could not reach the server.');
    } finally {
      this.undoing.set(false);
    }
    if (reopened.length === 0) return;
    this.applications.update((loaded) => [...reopened, ...(loaded ?? [])]);
    this.lastRejected.set([]);
    this.flash.set(
      reopened.length === 1
        ? `${reopened[0].name} is back in the queue.`
        : `${reopened.length} applications are back in the queue.`,
    );
  }

  // =========================================================== seating rules ==

  openSeatingRules(): void {
    this.seatingRulesOpen.set(true);
    if (this.seatingRules() === null) void this.loadSeatingRules();
  }

  closeSeatingRules(): void {
    this.seatingRulesOpen.set(false);
  }

  // =============================================================== loading ==

  private async loadQueue(): Promise<void> {
    try {
      const response = await fetch(`${environment.apiBase}/register/pending`, {
        credentials: 'include',
      });
      if (!response.ok) {
        this.error.set('Could not load pending applications.');
        this.applications.set([]);
        return;
      }
      this.applications.set((await response.json()) as RegistrationApiRow[]);
    } catch {
      this.error.set('Could not reach the server.');
      this.applications.set([]);
    }
  }

  /** Batch names for the queue and the College filter. A nicety: the queue
   *  still reads without them, so a failure here is not the screen's error. */
  private async loadBatchNames(): Promise<void> {
    try {
      const response = await fetch(`${environment.apiBase}/register/hierarchy`, {
        credentials: 'include',
      });
      if (!response.ok) return;
      const body = (await response.json()) as { colleges: HierarchyCollege[] };
      const named = new Map<string, string>();
      for (const college of body.colleges) {
        for (const department of college.departments) {
          for (const batch of department.batches) {
            named.set(batch.id, `${batch.name} · ${batch.batch_label}`);
          }
        }
      }
      this.batchNames.set(named);
    } catch {
      /* the queue still reads without the batch names */
    }
  }

  private async loadSeatingRules(): Promise<void> {
    try {
      const response = await fetch(`${environment.apiBase}/register/rules`, {
        credentials: 'include',
      });
      if (!response.ok) {
        this.seatingRulesError.set('Could not load the seating rules.');
        this.seatingRules.set([]);
        return;
      }
      const rules = (await response.json()) as SeatingRuleApiRow[];
      this.seatingRules.set(rules.map((rule) => this.toSeatingRuleLine(rule)));
    } catch {
      this.seatingRulesError.set('Could not reach the server.');
      this.seatingRules.set([]);
    }
  }

  private toSeatingRuleLine(rule: SeatingRuleApiRow): SeatingRuleLine {
    const conditions: string[] = [];
    if (rule.email_domain !== null) conditions.push(`email on ${rule.email_domain}`);
    if (rule.usn_pattern !== null) conditions.push(`USN like ${rule.usn_pattern}`);
    if (rule.degree_level !== null) conditions.push(rule.degree_level);
    return {
      id: rule.id,
      name: rule.name,
      priority: rule.priority,
      enabled: rule.enabled,
      autoApprove: rule.auto_approve,
      conditions: conditions.length === 0 ? 'Matches every application' : conditions.join(' · '),
      seatsIn: this.seatLabelFor(rule.cohort_id),
    };
  }

  private seatLabelFor(cohortId: string | null): string {
    if (cohortId === null) return 'No batch';
    const named = this.batchNames().get(cohortId);
    // Not "a batch this deployment no longer lists": the hierarchy read can
    // simply have failed, and this screen cannot tell that from a deletion.
    if (named === undefined) return `Batch ${cohortId.slice(0, 8)}`;
    return named;
  }
}

/**
 * The refusal the server wrote, not a generic one.
 *
 * FastAPI answers a schema error with `detail` as a LIST of objects, so
 * `body?.detail` renders "[object Object]" — the trap leave.component.ts hit
 * when `LeaveIn` grew a date check. Same helper as governance.component.ts's
 * `detailOf`; the sentences worth showing here name specifics ("A reason is
 * required when rejecting an application.").
 */
async function detailOf(response: Response): Promise<string> {
  try {
    const body = await response.json();
    const detail = body?.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail) && detail.length > 0 && typeof detail[0]?.msg === 'string') {
      return String(detail[0].msg).replace(/^Value error,\s*/, '');
    }
  } catch {
    /* fall through to the status */
  }
  return `Could not record the decision (${response.status}).`;
}
