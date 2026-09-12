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
 * WHAT THE BOARD SHOWS THAT NOTHING CAN ANSWER YET, and how each is rendered:
 *
 *   - The board gives every card a row count ("118 rows") and a last-generated
 *     date. There is no report store and no endpoint that counts a file's rows
 *     without generating it, so no count is drawn. The only date on a card is
 *     the one THIS browser remembers about its own downloads, and it says so.
 *   - Interviews, Registrations and Leave are drawn as extracts on the board
 *     and exist nowhere on main. Their cards render their empty state with a
 *     disabled control and the notice under the grid names the task, rather
 *     than a live-looking button that 404s in front of the placement office.
 *   - The board's PII flag reads "No personal fields" on four of six cards.
 *     That is the state AFTER `B14` omits personal columns from a caller
 *     without the PII-carrying function. TODAY every one of these files leads
 *     with the student's name and USN — printing "No personal fields" over a
 *     file that carries both would be the most expensive wrong label on this
 *     screen. So the chip says what the header row actually holds, and the
 *     column line under each description is that header row verbatim.
 *   - Download history is `GET /api/admin/exports/history`, also `B14`. The
 *     grid is built with its real columns and no rows, because the shape of
 *     the record is design and the rows would be fiction.
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
 * `/admin/audit` is `roleGuard('ADMIN')` for the same reason (`admin.governance`
 * does not exist until `B2.6`), so the history card's "Open audit log" is
 * offered to the office account only rather than bouncing off a guard.
 */

import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AgGridAngular } from 'ag-grid-angular';
import type { ColDef } from 'ag-grid-community';

import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/auth.service';
import { registerReepGrid } from '../../../shared/grid/grid-bootstrap';
import { reepGridTheme } from '../../../shared/grid/reep-grid-theme';
import { PendingControlDirective } from '../../../shared/pending/pending.directive';

/** One extract on the board: a card, and either a file or a stated absence. */
interface ExtractCard {
  key: string;
  title: string;
  description: string;
  /** The file's header row as it is actually written, or null while the
   *  extract is still a backend task and has no header row to quote. */
  headerRow: string | null;
  /** The API path the download link points at; null while it does not exist. */
  path: string | null;
  filename: string;
  /** Every extract that names a student carries their name and their USN
   *  today. The per-column PII gate that removes them is `B14`. */
  carriesNameAndUsn: boolean;
  /** `/admin/badges/export.csv` answers to `require_admin`, not to this
   *  screen's `admin.exports` capability. */
  mainAdminOnly: boolean;
}

/** A row of the audited download history `B14` adds. Declared here so the
 *  grid's columns are the real ones the day rows start arriving. */
interface ExportDownloadRow {
  file: string;
  scopeUsed: string;
  rows: number;
  downloadedBy: string;
  downloadedAt: string;
  auditState: string;
}

/** The phase that makes the unbuilt halves of this screen work (`B14`,
 *  `04-backend-changes.md`, scheduled in `05-delivery-workflow.md` Phase 3). */
const EXPORTS_BACKEND_PHASE = 3;

/** Where this browser remembers its own downloads. Not a record of anything. */
const LAST_DOWNLOAD_STORAGE_KEY = 'reep.exports.last';

/** How long the "your browser is saving the file" line stays up. A live region
 *  that never clears reads, ten minutes later, as a download still in flight. */
const REQUEST_NOTE_MS = 6000;

@Component({
  selector: 'app-admin-exports',
  standalone: true,
  imports: [RouterLink, AgGridAngular, PendingControlDirective],
  templateUrl: './exports.component.html',
  styleUrl: './exports.component.scss',
})
export class AdminExportsComponent implements OnDestroy {
  private readonly auth = inject(AuthService);

  readonly exportsBackendPhase = EXPORTS_BACKEND_PHASE;
  readonly gridTheme = reepGridTheme;

  /** `/admin/badges/export.csv` is `require_admin`, and `/admin/audit` is
   *  `roleGuard('ADMIN')`. This screen admits anyone holding `admin.exports`,
   *  so both have to be rendered as unavailable for a granted faculty member
   *  rather than as controls that answer 403 or bounce off a guard. */
  readonly isMainAdmin = computed(() => this.auth.session()?.role === 'ADMIN');

  /** Board order, with the badge report last because it is not on the board. */
  readonly extracts: ExtractCard[] = [
    {
      key: 'students',
      title: 'Students',
      description:
        'One row per admitted student with their REEP stage, semester, batch and assigned mentor.',
      headerRow: 'name · usn · reep stage · semester · cohort · mentor',
      path: '/admin/exports/students.csv',
      filename: 'reep-students-mentor-map.csv',
      carriesNameAndUsn: true,
      mainAdminOnly: false,
    },
    {
      key: 'placement',
      title: 'Placement',
      description:
        'Every submitted offer, one row per offer: company, role, CTC and the decision with its dates.',
      headerRow:
        'student · usn · company · role · role type · ctc (inr) · status · submitted · decided',
      path: '/admin/exports/placement.csv',
      filename: 'reep-placement-summary.csv',
      carriesNameAndUsn: true,
      mainAdminOnly: false,
    },
    {
      key: 'ledger',
      title: 'Ledger',
      description:
        'Time Allocation Ledger compliance per student: days logged and submitted, hours entered and the productive share.',
      headerRow: 'name · usn · days logged · days submitted · hours logged · productive hours',
      path: '/admin/exports/ledger.csv',
      filename: 'reep-ledger-compliance.csv',
      carriesNameAndUsn: true,
      mainAdminOnly: false,
    },
    {
      key: 'interviews',
      title: 'Interviews',
      description: 'Score summaries per session — never transcripts, never audio.',
      headerRow: null,
      path: null,
      filename: '',
      carriesNameAndUsn: false,
      mainAdminOnly: false,
    },
    {
      key: 'registrations',
      title: 'Registrations',
      description: 'Applications with the domain check, the decision and who decided it.',
      headerRow: null,
      path: null,
      filename: '',
      carriesNameAndUsn: false,
      mainAdminOnly: false,
    },
    {
      key: 'leave',
      title: 'Leave',
      description: 'Requests with both signatures and the balance left after each one.',
      headerRow: null,
      path: null,
      filename: '',
      carriesNameAndUsn: false,
      mainAdminOnly: false,
    },
    {
      key: 'badges',
      title: 'Skills & badges',
      description:
        'One row per student: badges earned by category, points, and mean growth from the T0 baseline.',
      headerRow:
        'name · usn · reep stage · points · one column per badge category · mean growth from T0',
      path: '/admin/badges/export.csv',
      filename: 'reep-cohort-skill-report.csv',
      carriesNameAndUsn: true,
      mainAdminOnly: true,
    },
  ];

  /** When this browser last downloaded each extract. A convenience, not a
   *  record: the audited one is `B14`'s, and it lives on the server. */
  readonly lastDownloadedInThisBrowser = signal<Record<string, string>>(
    readRememberedDownloads(),
  );

  /** The extract whose download was just started, for the live region. */
  readonly justRequested = signal<string | null>(null);

  /** The audited history. Empty until `GET /api/admin/exports/history` exists,
   *  and deliberately never filled from anywhere else. */
  readonly downloadHistory = signal<ExportDownloadRow[]>([]);

  readonly historyColumns: ColDef<ExportDownloadRow>[] = [
    { headerName: 'File', field: 'file', flex: 1.1, minWidth: 150 },
    { headerName: 'Scope used', field: 'scopeUsed', flex: 1.8, minWidth: 200 },
    { headerName: 'Rows', field: 'rows', type: 'numericColumn', width: 110 },
    { headerName: 'By', field: 'downloadedBy', flex: 1.5, minWidth: 180 },
    { headerName: 'When', field: 'downloadedAt', flex: 1, minWidth: 140, sort: 'desc' },
    { headerName: 'Audit', field: 'auditState', width: 140 },
  ];

  readonly defaultHistoryColumn: ColDef<ExportDownloadRow> = {
    sortable: true,
    resizable: true,
    suppressHeaderMenuButton: false,
  };

  readonly historyEmptyOverlay =
    '<span class="ag-overlay-no-rows-center">No downloads recorded yet</span>';

  constructor() {
    registerReepGrid();
  }

  downloadUrl(extract: ExtractCard): string {
    if (extract.path === null) return '';
    return `${environment.apiBase}${extract.path}`;
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

  ngOnDestroy(): void {
    if (this.requestNoteTimer !== null) clearTimeout(this.requestNoteTimer);
  }

  noteDownload(extract: ExtractCard): void {
    const remembered = { ...this.lastDownloadedInThisBrowser(), [extract.key]: new Date().toISOString() };
    this.lastDownloadedInThisBrowser.set(remembered);
    this.justRequested.set(extract.title);
    if (this.requestNoteTimer !== null) clearTimeout(this.requestNoteTimer);
    this.requestNoteTimer = setTimeout(() => this.justRequested.set(null), REQUEST_NOTE_MS);
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
