/**
 * Exports — the spreadsheets a placement office actually forwards.
 *
 * The approved board is `docs/redesign-2026-09/design/admin/Exports.html` and
 * the brief is `02-admin-console-spec.md` §22. A grid of report cards, not a
 * builder: each card that downloads anything is a real endpoint behind the
 * console's own gate, and the download is a plain `<a href>` so the browser
 * streams the file to disk rather than a fetch buffering a CSV into memory to
 * re-offer it.
 *
 * B14 HAS LANDED, and three of the four things this screen used to call
 * unbuilt are now real (`app/exports.py`, `app/routers/console.py`):
 *
 *   - SCOPE. Every extract runs through `scope_filter(db, session,
 *     "admin.exports")`, so a department-scoped grant downloads its department
 *     and not the programme. The caller's own reach is stated on the history
 *     card, from the ONE B14 endpoint that has a body to put it in
 *     (`GET /api/admin/exports/history` answers `{scope, events}`; the three
 *     CSVs state the same fact in response headers, because a JSON envelope
 *     around a CSV is not a CSV). It is stated in the three words the server
 *     uses — `programme`, `narrowed`, `none` — and never collapsed to a
 *     boolean: "may see everything" and "may see nothing" are opposite facts.
 *   - PERSONAL COLUMNS. `PERSONAL_COLUMN_CAPABILITY` in `app/exports.py` is
 *     `admin.students`, the ROSTER function — not `carries_pii`, which
 *     `admin.exports` itself is flagged with and which would therefore be true
 *     for every caller. So the card's chip and the column line under it are
 *     drawn from the session's own functions: a holder without the roster
 *     function gets a file whose Name and USN columns are dropped, header and
 *     cell, and printing "Carries name & USN" over that file would be as wrong
 *     as the board's "No personal fields" over a file that carries both.
 *   - THE HISTORY. Every download writes an `export_events` row, and the grid
 *     below reads them. A NARROWED holder sees only their own receipts, by the
 *     endpoint's own rule, which is why the reach is spelled out beside them.
 *
 * WHAT IS STILL NOT BUILT, and how each is rendered:
 *
 *   - The board gives every card a row count ("118 rows") and a last-generated
 *     date. There is no report store and no endpoint that counts a file's rows
 *     without generating it, so no count is drawn. The only date on a card is
 *     the one THIS browser remembers about its own downloads, and it says so;
 *     the authoritative dates are in the history grid.
 *   - Interviews, Registrations and Leave are drawn as extracts on the board
 *     and have no endpoint. B14 shipped without them and could not have
 *     shipped with them: the Interviews extract is summary-only from B6.2, and
 *     the other two sit in the same Phase 4 areas as their screens (B11
 *     registrations, B10 leave). Their cards render their empty state with a
 *     disabled control, rather than a live-looking button that 404s in front
 *     of the placement office.
 *   - "Schedule an export" is `02-admin-console-spec.md` §22's own "(optional,
 *     later)" — no task in `04-backend-changes.md` defines it and no phase
 *     carries it. It is disabled with THAT as its reason rather than a phase
 *     number, because naming a phase would promise a date nothing has agreed.
 *
 * THE BADGE REPORT IS NOT ON THE BOARD AND IS KEPT ANYWAY. It is a working
 * download on main; deleting a live extract to match a drawing is a regression
 * the board never asked for. It carries its own warning: the screen is reached
 * with the `admin.exports` capability, but `/admin/badges/export.csv` is
 * `require_admin` — deliberately, so the file cannot have a weaker lock than
 * the cohort screen that renders the same data — so for a granted faculty
 * member that one card renders DISABLED with the reason on it. A live link
 * there is worse than a dead one: `<a download>` saves whatever comes back,
 * so a 403 body lands on the officer's disk named `.csv` and this browser's
 * "last downloaded" line records it as a success.
 *
 * `/admin/audit` is `roleGuard('ADMIN')` (`admin.governance` is not the gate
 * on that route), so the history card's "Open audit log" is offered to the
 * office account only rather than bouncing off a guard.
 */

import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AgGridAngular } from 'ag-grid-angular';
import type { ColDef, ICellRendererParams, ValueFormatterParams } from 'ag-grid-community';

import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/auth.service';
import { registerReepGrid } from '../../../shared/grid/grid-bootstrap';
import { reepGridTheme } from '../../../shared/grid/reep-grid-theme';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';
import { plural } from '../../../shared/text/plural.pipe';

/** One extract on the board: a card, and either a file or a stated absence. */
interface ExtractCard {
  key: string;
  title: string;
  description: string;
  /** The file's header row as it is actually written — the columns in order,
   *  or null while the extract is still a backend task and has no header row
   *  to quote. The personal ones are named separately rather than marked in
   *  place, for `app/exports.py::drop_personal`'s own reason: a flag beside a
   *  column is one more thing to keep in step with the server. */
  columns: string[] | null;
  /** The columns this file drops for a caller without the roster function.
   *  The same names `drop_personal` is called with on the server. */
  personalColumns: string[];
  /** The API path the download link points at; null while it does not exist. */
  path: string | null;
  filename: string;
  /** `/admin/badges/export.csv` answers to `require_admin`, not to this
   *  screen's `admin.exports` capability. */
  mainAdminOnly: boolean;
}

/** `GET /api/admin/exports/history` — `ExportEventOut` in `routers/console.py`. */
interface ExportEventWire {
  id: string;
  kind: string;
  at: string;
  rows: number;
  carried_pii: boolean;
  filters: Record<string, unknown>;
  /** Null once the account that downloaded it has been deleted: the FK is
   *  ON DELETE SET NULL, so the export survives the exporter. */
  by_user_id: string | null;
  by_name: string | null;
}

/** `ExportHistoryOut`: the receipts, and the reach of the person reading them. */
interface ExportHistoryWire {
  scope: Record<string, unknown>;
  events: ExportEventWire[];
}

/** A row of the audited download history, in the board's own columns. */
interface ExportDownloadRow {
  id: string;
  file: string;
  scopeUsed: string;
  /** The ids behind `scopeUsed`, for the cell's tooltip. A narrowed receipt
   *  names uuids, which are unreadable in a 30%-wide column and are still the
   *  only way to answer "which department was that". */
  scopeDetail: string;
  rows: number;
  downloadedBy: string | null;
  downloadedAt: string;
  auditLabel: string;
  auditTone: 'good' | 'risk';
}

/**
 * The phase that brings the three extracts the board draws and nothing serves.
 *
 * NOT A GUESS AND NOT B14. B14 (Phase 3) shipped Students, Placement, Ledger,
 * the scope filter, the personal-column rule and the history — it is the task
 * this screen was waiting for and it is done. The three that are still grey
 * each wait on a Phase 4 area rather than on an exports task: the Interviews
 * extract is summary-only from B6.2 (`-interviews`), Registrations is B11 and
 * Leave is B10 (`05-delivery-workflow.md` §1). Leaving them reading "Available
 * with Phase 3" after Phase 3 landed would be the stale reason the directive's
 * docstring warns about — a control that names a date already past.
 */
const UNBUILT_EXTRACT_PHASE = 4;

/** The function that unlocks the columns which NAME a person, mirroring
 *  `PERSONAL_COLUMN_CAPABILITY` in `apps/api-py/app/exports.py`. The server
 *  decides; this constant only decides what the card SAYS the file will hold,
 *  and it has to be the same key or the label lies about the download. */
const PERSONAL_COLUMN_CAPABILITY = 'admin.students';

/** Where this browser remembers its own downloads. Not a record of anything. */
const LAST_DOWNLOAD_STORAGE_KEY = 'reep.exports.last';

/** How long the "your browser is saving the file" line stays up. A live region
 *  that never clears reads, ten minutes later, as a download still in flight. */
const REQUEST_NOTE_MS = 6000;

/** How long after a download the history is re-read. The receipt is committed
 *  before the file is returned (`record_export` commits), but the browser is
 *  streaming that file on its own connection and nothing tells this component
 *  when it finished. So the refetch is a courtesy on a timer and the Refresh
 *  button is the answer when it loses the race. */
const HISTORY_REFRESH_AFTER_DOWNLOAD_MS = 2000;

/** How many receipts are asked for. The endpoint's own default is 100 and its
 *  ceiling is 500; asking explicitly is what lets the status bar say "the 100
 *  most recent" and be right. */
const HISTORY_LIMIT = 100;

@Component({
  selector: 'app-admin-exports',
  standalone: true,
  imports: [RouterLink, AgGridAngular, PendingControlDirective],
  templateUrl: './exports.component.html',
  styleUrl: './exports.component.scss',
})
export class AdminExportsComponent implements OnDestroy {
  private readonly auth = inject(AuthService);

  readonly unbuiltExtractPhase = UNBUILT_EXTRACT_PHASE;
  readonly gridTheme = reepGridTheme;

  /** `/admin/badges/export.csv` is `require_admin`, and `/admin/audit` is
   *  `roleGuard('ADMIN')`. This screen admits anyone holding `admin.exports`,
   *  so both have to be rendered as unavailable for a granted faculty member
   *  rather than as controls that answer 403 or bounce off a guard. */
  readonly isMainAdmin = computed(() => this.auth.session()?.role === 'ADMIN');

  /** Whether this caller's files will name the students in them. The session's
   *  capability list is resolved by the API on every `/auth/me`; the server
   *  re-decides on the request itself, so this is a label, never a gate. */
  readonly carriesPersonalColumns = computed(() =>
    (this.auth.session()?.capabilities ?? []).includes(PERSONAL_COLUMN_CAPABILITY),
  );

  /** Board order, with the badge report last because it is not on the board. */
  readonly extracts: ExtractCard[] = [
    {
      key: 'students',
      title: 'Students',
      description:
        'One row per admitted student with their REEP stage, semester, batch and assigned mentor.',
      columns: ['name', 'usn', 'reep stage', 'semester', 'cohort', 'mentor'],
      // The mentor's name stays in a redacted file: it is a member of staff
      // acting in their professional role, and it is this file's subject.
      personalColumns: ['name', 'usn'],
      path: '/admin/exports/students.csv',
      filename: 'reep-students-mentor-map.csv',
      mainAdminOnly: false,
    },
    {
      key: 'placement',
      title: 'Placement',
      description:
        'Every submitted offer, one row per offer: company, role, CTC and the decision with its dates.',
      columns: [
        'student',
        'usn',
        'company',
        'role',
        'role type',
        'ctc (inr)',
        'status',
        'submitted',
        'decided',
      ],
      personalColumns: ['student', 'usn'],
      path: '/admin/exports/placement.csv',
      filename: 'reep-placement-summary.csv',
      mainAdminOnly: false,
    },
    {
      key: 'ledger',
      title: 'Ledger',
      description:
        'Time Allocation Ledger compliance per student: days logged and submitted, hours entered and the productive share.',
      columns: [
        'name',
        'usn',
        'days logged',
        'days submitted',
        'hours logged',
        'productive hours',
      ],
      personalColumns: ['name', 'usn'],
      path: '/admin/exports/ledger.csv',
      filename: 'reep-ledger-compliance.csv',
      mainAdminOnly: false,
    },
    {
      key: 'interviews',
      title: 'Interviews',
      description: 'Score summaries per session — never transcripts, never audio.',
      columns: null,
      personalColumns: [],
      path: null,
      filename: '',
      mainAdminOnly: false,
    },
    {
      key: 'registrations',
      title: 'Registrations',
      description: 'Applications with the domain check, the decision and who decided it.',
      columns: null,
      personalColumns: [],
      path: null,
      filename: '',
      mainAdminOnly: false,
    },
    {
      key: 'leave',
      title: 'Leave',
      description: 'Requests with both signatures and the balance left after each one.',
      columns: null,
      personalColumns: [],
      path: null,
      filename: '',
      mainAdminOnly: false,
    },
    {
      key: 'badges',
      title: 'Skills & badges',
      description:
        'One row per student: badges earned by category, points, and mean growth from the T0 baseline.',
      columns: [
        'name',
        'usn',
        'reep stage',
        'points',
        'one column per badge category',
        'mean growth from T0',
      ],
      personalColumns: ['name', 'usn'],
      path: '/admin/badges/export.csv',
      filename: 'reep-cohort-skill-report.csv',
      mainAdminOnly: true,
    },
  ];

  /** When this browser last downloaded each extract. A convenience, not a
   *  record: the audited one is the history grid, and it lives on the server. */
  readonly lastDownloadedInThisBrowser = signal<Record<string, string>>(
    readRememberedDownloads(),
  );

  /** The extract whose download was just started, for the live region. */
  readonly justRequested = signal<string | null>(null);

  // ------------------------------------------------------ the history card --

  readonly downloadHistory = signal<ExportDownloadRow[]>([]);
  readonly historyLoading = signal(false);
  readonly historyError = signal<string | null>(null);

  /** Whether a load has ever come back. An empty history and a history that
   *  has not answered are different states and must not share an empty state:
   *  "nothing has been exported here" is a fact, "we could not ask" is not. */
  readonly historyLoaded = signal(false);

  /** The caller's own reach, as the server stated it in the response body. */
  private readonly historyScope = signal<Record<string, unknown> | null>(null);

  /** `programme` | `narrowed` | `none`, or null before the first answer. */
  readonly scopeWord = computed(() => {
    const scope = this.historyScope();
    const word = scope?.['scope'];
    return typeof word === 'string' ? word : null;
  });

  /** The reach as text AND colour, never colour alone — and never the same
   *  rendering for `programme` and `none`, which are opposite facts. */
  readonly scopeChip = computed<{ label: string; tone: 'good' | 'warn' | 'risk' } | null>(() => {
    switch (this.scopeWord()) {
      case 'programme':
        return { label: 'Whole programme', tone: 'good' };
      case 'narrowed':
        return { label: 'Narrowed to your grant', tone: 'warn' };
      case 'none':
        return { label: 'Reaches no students', tone: 'risk' };
      default:
        return null;
    }
  });

  /** What that reach means for the files and for this list. */
  readonly scopeSentence = computed(() => {
    switch (this.scopeWord()) {
      case 'programme':
        return 'Your Exports function covers the whole programme, so the files above carry every student and this list carries every download anyone made.';
      case 'narrowed':
        return 'Your Exports function is scoped, so the files above carry only the students it reaches — and this list shows your own downloads only.';
      case 'none':
        return 'Your Exports function currently reaches no students: the files above will download with their header row and nothing under it. Only your own downloads are listed.';
      default:
        return '';
    }
  });

  readonly historyColumns: ColDef<ExportDownloadRow>[] = [
    { headerName: 'File', field: 'file', flex: 1.1, minWidth: 150 },
    {
      headerName: 'Scope used',
      field: 'scopeUsed',
      flex: 1.8,
      minWidth: 200,
      cellRenderer: renderScopeCell,
    },
    { headerName: 'Rows', field: 'rows', type: 'numericColumn', width: 110 },
    {
      headerName: 'By',
      field: 'downloadedBy',
      flex: 1.5,
      minWidth: 180,
      cellRenderer: renderByCell,
    },
    {
      headerName: 'When',
      field: 'downloadedAt',
      flex: 1,
      minWidth: 140,
      sort: 'desc',
      valueFormatter: formatDownloadedAt,
    },
    { headerName: 'Audit', field: 'auditLabel', width: 150, cellRenderer: renderAuditCell },
  ];

  readonly defaultHistoryColumn: ColDef<ExportDownloadRow> = {
    sortable: true,
    resizable: true,
    suppressHeaderMenuButton: false,
  };

  readonly rowId = (params: { data: ExportDownloadRow }): string => params.data.id;

  /** "6 downloads shown", and whether that is everything. The endpoint answers
   *  the newest `HISTORY_LIMIT` receipts, so a full page is a truncated
   *  history and saying only the count would read as the whole record. */
  readonly historyCountLine = computed(() => {
    const shown = this.downloadHistory().length;
    const counted = `${plural(shown, 'download')} shown`;
    return shown >= HISTORY_LIMIT ? `${counted} — the ${HISTORY_LIMIT} most recent` : counted;
  });

  readonly historyEmptyOverlay =
    '<span style="color:var(--muted);font-size:12.5px">No downloads recorded yet</span>';

  constructor() {
    // AG Grid 33+ refuses to draw until its modules are registered, and fails
    // as an empty rectangle rather than an exception (shared/grid docstring).
    registerReepGrid();
    void this.loadHistory();
  }

  /** Read the receipts. The same call answers the caller's reach, which is why
   *  the scope line above the grid needs no second request and no HEAD. */
  async loadHistory(): Promise<void> {
    this.historyLoading.set(true);
    this.historyError.set(null);
    try {
      const response = await fetch(
        `${environment.apiBase}/admin/exports/history?limit=${HISTORY_LIMIT}`,
        { credentials: 'include' },
      );
      if (!response.ok) {
        this.historyError.set(await detailOf(response));
        return;
      }
      const body = (await response.json()) as ExportHistoryWire;
      this.historyScope.set(body.scope ?? null);
      this.downloadHistory.set(body.events.map((event) => this.toRow(event)));
      this.historyLoaded.set(true);
    } catch {
      this.historyError.set(
        'The download history could not be read — the server could not be reached.',
      );
    } finally {
      this.historyLoading.set(false);
    }
  }

  private toRow(event: ExportEventWire): ExportDownloadRow {
    const scope = describeScope(event.filters);
    return {
      id: event.id,
      // The card titles are the names on this screen; an unrecognised kind is
      // shown as the server wrote it rather than dropped.
      file: this.extracts.find((extract) => extract.key === event.kind)?.title ?? event.kind,
      scopeUsed: scope.label,
      scopeDetail: scope.detail,
      // A real zero. `rows: 0` is a file that was downloaded and carried no
      // rows — which is what a reach of `none` produces — and it is a fact, not
      // a missing value, so it is not rendered as a dash.
      rows: event.rows,
      downloadedBy: event.by_name,
      downloadedAt: event.at,
      auditLabel: event.carried_pii ? 'PII · audited' : 'Audited',
      auditTone: event.carried_pii ? 'risk' : 'good',
    };
  }

  // ------------------------------------------------------------- the cards --

  downloadUrl(extract: ExtractCard): string {
    if (extract.path === null) return '';
    return `${environment.apiBase}${extract.path}`;
  }

  /** The header row this caller's file will actually have. */
  columnLine(extract: ExtractCard): string | null {
    if (extract.columns === null) return null;
    const dropped = new Set(this.carriesPersonalColumns() ? [] : extract.personalColumns);
    return extract.columns.filter((name) => !dropped.has(name)).join(' · ');
  }

  /** The PII chip: what the header row holds for THIS caller, text and colour
   *  together. The board prints "No personal fields" on four of six cards; that
   *  is only true of a caller without the roster function, and printing it over
   *  a file that leads with a name and a USN would be the most expensive wrong
   *  label on this screen. */
  piiChip(extract: ExtractCard): { label: string; tone: 'risk' | 'neutral' } | null {
    if (extract.columns === null || extract.personalColumns.length === 0) return null;
    return this.carriesPersonalColumns()
      ? { label: 'Carries name & USN', tone: 'risk' }
      : { label: 'Name & USN omitted', tone: 'neutral' };
  }

  lastDownloadedLabel(extract: ExtractCard): string {
    const rememberedAt = this.lastDownloadedInThisBrowser()[extract.key];
    if (!rememberedAt) return 'Not downloaded from this browser yet';
    const when = new Date(rememberedAt);
    if (Number.isNaN(when.getTime())) return 'Not downloaded from this browser yet';
    const stamp = when.toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
    return `Last downloaded ${stamp} from this browser`;
  }

  /** True where the card has a file AND this caller may actually fetch it. */
  canDownload(extract: ExtractCard): boolean {
    return extract.path !== null && (!extract.mainAdminOnly || this.isMainAdmin());
  }

  private requestNoteTimer: ReturnType<typeof setTimeout> | null = null;
  private historyRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnDestroy(): void {
    if (this.requestNoteTimer !== null) clearTimeout(this.requestNoteTimer);
    if (this.historyRefreshTimer !== null) clearTimeout(this.historyRefreshTimer);
  }

  noteDownload(extract: ExtractCard): void {
    const remembered = {
      ...this.lastDownloadedInThisBrowser(),
      [extract.key]: new Date().toISOString(),
    };
    this.lastDownloadedInThisBrowser.set(remembered);
    this.justRequested.set(extract.title);
    if (this.requestNoteTimer !== null) clearTimeout(this.requestNoteTimer);
    this.requestNoteTimer = setTimeout(() => this.justRequested.set(null), REQUEST_NOTE_MS);
    // The download writes its own receipt; pick it up without making the
    // officer press Refresh for the usual case.
    if (this.historyRefreshTimer !== null) clearTimeout(this.historyRefreshTimer);
    this.historyRefreshTimer = setTimeout(
      () => void this.loadHistory(),
      HISTORY_REFRESH_AFTER_DOWNLOAD_MS,
    );
    try {
      localStorage.setItem(LAST_DOWNLOAD_STORAGE_KEY, JSON.stringify(remembered));
    } catch {
      // A browser that refuses storage just forgets; the download still happened.
    }
  }
}

function readRememberedDownloads(): Record<string, string> {
  try {
    const stored = localStorage.getItem(LAST_DOWNLOAD_STORAGE_KEY);
    const parsed = stored ? (JSON.parse(stored) as unknown) : null;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
    return {};
  } catch {
    return {};
  }
}

/** The server's own sentence where there is one. FastAPI answers a schema
 *  error with `detail` as a LIST, which rendered raw says "[object Object]". */
async function detailOf(response: Response): Promise<string> {
  try {
    const body = await response.json();
    const detail = body?.detail;
    if (typeof detail === 'string') {
      return detail;
    }
    if (Array.isArray(detail) && detail.length > 0 && typeof detail[0]?.msg === 'string') {
      return detail[0].msg;
    }
  } catch {
    /* fall through to the status */
  }
  return `The download history was refused (${response.status}).`;
}

/** The rungs a narrowed receipt can name, in the order `scope_note` writes
 *  them (`apps/api-py/app/exports.py`). */
const SCOPE_RUNGS: { key: string; one: string; many: string }[] = [
  { key: 'colleges', one: 'college', many: 'colleges' },
  { key: 'departments', one: 'department', many: 'departments' },
  { key: 'courses', one: 'course', many: 'courses' },
  { key: 'specializations', one: 'specialization', many: 'specializations' },
  { key: 'cohorts', one: 'batch', many: 'batches' },
  { key: 'students', one: 'student', many: 'students' },
];

/**
 * A receipt's `filters` as a sentence. The stored shape is `scope_note`'s:
 * `{scope: "programme" | "narrowed" | "none", colleges?: [...], ...}`.
 *
 * The ids go to the tooltip rather than the cell. "Who exported what" is
 * unanswerable without the filters, and equally unanswerable when the column
 * is thirty uuids wide and ellipsised at the first one.
 */
function describeScope(filters: Record<string, unknown>): { label: string; detail: string } {
  const word = filters?.['scope'];
  if (word === 'programme') return { label: 'Whole programme', detail: '' };
  if (word === 'none') return { label: 'No students in reach', detail: '' };
  if (word !== 'narrowed') {
    // A receipt whose filters were not written by `scope_note`. Say so rather
    // than inventing a reading of it; the raw JSON is in the tooltip.
    return { label: '— filters not recorded', detail: JSON.stringify(filters ?? {}) };
  }
  const parts: string[] = [];
  const detail: string[] = [];
  for (const rung of SCOPE_RUNGS) {
    const ids = filters[rung.key];
    if (!Array.isArray(ids) || ids.length === 0) continue;
    parts.push(`${ids.length} ${ids.length === 1 ? rung.one : rung.many}`);
    detail.push(`${rung.many}: ${ids.join(', ')}`);
  }
  return {
    // A grant scoped at a rung the receipt does not name is still narrowed, and
    // saying only "Narrowed" is the truthful reading of that row.
    label: parts.length === 0 ? 'Narrowed' : `Narrowed · ${parts.join(', ')}`,
    detail: detail.join(' | '),
  };
}

function formatDownloadedAt(
  params: ValueFormatterParams<ExportDownloadRow, string>,
): string {
  if (!params.value) return '—';
  const when = new Date(params.value);
  if (Number.isNaN(when.getTime())) return '—';
  return when.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** AG Grid cell renderers build their own DOM, so a name out of the roster
 *  reaches innerHTML: escape it here rather than trusting the roster. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A cell renderer builds its DOM after Angular has compiled this component's
 *  stylesheet, so a class declared in exports.component.scss never reaches it.
 *  `.chip` is global and does; everything else here is an inline style reading
 *  the design system's own tokens. */
const FAINT_CELL = 'color:var(--faint)';

function renderScopeCell(params: ICellRendererParams<ExportDownloadRow>): string {
  const row = params.data;
  if (!row) return '';
  const title = row.scopeDetail ? ` title="${escapeHtml(row.scopeDetail)}"` : '';
  return `<span${title}>${escapeHtml(row.scopeUsed)}</span>`;
}

function renderByCell(params: ICellRendererParams<ExportDownloadRow>): string {
  const row = params.data;
  if (!row) return '';
  // The account was deleted after the export: the FK is ON DELETE SET NULL, so
  // the receipt outlives the exporter. A dash alone would read as "nobody".
  if (row.downloadedBy === null) {
    return `<span style="${FAINT_CELL}">— account since deleted</span>`;
  }
  return escapeHtml(row.downloadedBy);
}

function renderAuditCell(params: ICellRendererParams<ExportDownloadRow>): string {
  const row = params.data;
  if (!row) return '';
  return `<span class="chip dot ${row.auditTone}">${escapeHtml(row.auditLabel)}</span>`;
}
