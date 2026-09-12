/**
 * The Jobs sheet's grid: its columns, its cell renderers and its selection
 * rules (board `design/admin/JobsSheet.html`, spec §14).
 *
 * AG Grid builds cell contents outside Angular's template compiler, so a
 * component-scoped class never reaches them. Every renderer below therefore
 * uses GLOBAL classes (`.chip`, `.icon` in styles/reep-v2.scss) and inline
 * styles, exactly as the roster grid does — and escapes every value it
 * interpolates, because a company name is somebody else's text.
 *
 * TRACK AND CTC ARE HERE AND THEY ARE EMPTY. The board draws both columns and
 * `jobs` answers neither: tracks arrive with B12.1 (Phase 4) and a posting
 * records no pay at all. Each renders an em dash and says so in its header
 * tooltip; the screen repeats it once in a `.notice.accent`.
 */

import type {
  ColDef,
  ICellRendererParams,
  RowSelectionOptions,
  SelectionColumnDef,
  ValueFormatterParams,
} from 'ag-grid-community';

import {
  INITIALLY_HIDDEN_COLUMN_IDS,
  NOT_READABLE,
  escapeHtml,
  type JobPostingRow,
} from './job-posting-row';

function renderPostingCell(params: ICellRendererParams<JobPostingRow>): string {
  const row = params.data;
  if (!row) return '';
  return (
    `<span style="display: inline-flex; flex-direction: column; line-height: 1.25; min-width: 0;">` +
    `<span style="font-weight: 600; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(row.title)}</span>` +
    `<span style="font-size: 11px; color: var(--faint); overflow: hidden; text-overflow: ellipsis;">${escapeHtml(row.companyAndLocation)}</span>` +
    `</span>`
  );
}

function renderStatusCell(params: ICellRendererParams<JobPostingRow>): string {
  const row = params.data;
  if (!row) return '';
  // Label and tone are this file's own words, never posting text.
  return `<span class="chip dot ${row.statusTone}">${escapeHtml(row.statusLabel)}</span>`;
}

function renderLevelCell(params: ICellRendererParams<JobPostingRow>): string {
  const row = params.data;
  if (!row) return '';
  return `<span class="chip">${escapeHtml(row.degreeLevel)}</span>`;
}

/** The two columns the board draws and nothing answers yet. */
function formatNotReadable(): string {
  return NOT_READABLE;
}

/** A posting's OWN eligibility gate. `GET /api/admin/jobs` answers these per
 *  row and `routers/student.py` prefers them over the programme's criteria, so
 *  a posting that carries one is stricter than the form's "Synced" fields
 *  claim. Null is the inherit case and says so — never a 0, which on a backlogs
 *  gate is the strictest value there is. */
function formatInheritedGate(params: ValueFormatterParams<JobPostingRow, number | null>): string {
  if (params.value === null || params.value === undefined) return 'Programme default';
  return `${params.value}`;
}

export const JOBS_ROW_SELECTION: RowSelectionOptions<JobPostingRow> = {
  mode: 'multiRow',
  checkboxes: true,
  headerCheckbox: true,
  // Ticking is a deliberate act: the toolbar's Duplicate and Remove act on the
  // ticked row, and Remove is not undoable, so a stray click on a cell must not
  // change what they would touch.
  enableClickSelection: false,
};

/** The tick column travels with the pinned Posting column rather than
 *  scrolling away from the row it selects. */
export const JOBS_SELECTION_COLUMN: SelectionColumnDef = { pinned: 'left', width: 44 };

export const DEFAULT_JOBS_COLUMN: ColDef<JobPostingRow> = {
  sortable: true,
  resizable: true,
  filter: true,
  floatingFilter: true,
  suppressHeaderMenuButton: false,
};

export const JOBS_COLUMNS: ColDef<JobPostingRow>[] = [
  {
    colId: 'posting',
    field: 'title',
    headerName: 'Posting',
    pinned: 'left',
    minWidth: 260,
    flex: 1.6,
    cellStyle: { display: 'flex', alignItems: 'center' },
    cellRenderer: renderPostingCell,
    headerTooltip: 'The role, with the company and location under it',
  },
  {
    colId: 'track',
    headerName: 'Track',
    minWidth: 110,
    sortable: false,
    filter: false,
    floatingFilter: false,
    valueFormatter: formatNotReadable,
    headerTooltip:
      'Which tracks a posting is visible to arrives with the scope and track task, B12.1 (Phase 4)',
  },
  {
    colId: 'ctc',
    headerName: 'CTC',
    type: 'numericColumn',
    minWidth: 110,
    sortable: false,
    filter: false,
    floatingFilter: false,
    valueFormatter: formatNotReadable,
    headerTooltip: 'A posting records no pay today, and no backend task adds one',
  },
  {
    colId: 'deadline',
    field: 'deadlineLabel',
    headerName: 'Deadline',
    minWidth: 140,
    headerTooltip: 'The closing date the posting was published with',
  },
  {
    colId: 'applied',
    field: 'applicants',
    headerName: 'Applied',
    type: 'numericColumn',
    minWidth: 110,
    headerTooltip:
      'Students who have applied. The eligible denominator the board draws arrives with B12.1 (Phase 4)',
  },
  {
    colId: 'status',
    field: 'statusLabel',
    headerName: 'Status',
    minWidth: 150,
    cellRenderer: renderStatusCell,
    headerTooltip:
      'Read from the closing date. Closing a posting by hand arrives with B12.2 (Phase 4)',
  },
  {
    colId: 'minCgpa',
    field: 'minCgpa',
    headerName: 'Min CGPA',
    minWidth: 150,
    hide: INITIALLY_HIDDEN_COLUMN_IDS.includes('minCgpa'),
    valueFormatter: formatInheritedGate,
    headerTooltip:
      "This posting's own CGPA gate. Blank means it inherits the programme's placement criteria",
  },
  {
    colId: 'maxLiveBacklogs',
    field: 'maxLiveBacklogs',
    headerName: 'Max backlogs',
    minWidth: 150,
    hide: INITIALLY_HIDDEN_COLUMN_IDS.includes('maxLiveBacklogs'),
    valueFormatter: formatInheritedGate,
    headerTooltip:
      "This posting's own backlog gate. Blank means it inherits the programme's placement criteria",
  },
  {
    colId: 'level',
    field: 'degreeLevel',
    headerName: 'Level',
    minWidth: 100,
    hide: INITIALLY_HIDDEN_COLUMN_IDS.includes('level'),
    cellRenderer: renderLevelCell,
    headerTooltip: 'PG or UG — which board the posting is published to',
  },
];

/** What the Columns panel lists. The selection column is the grid's own and is
 *  not on it. */
export const TOGGLEABLE_JOBS_COLUMNS = JOBS_COLUMNS.map((column) => ({
  id: column.colId ?? '',
  label: column.headerName ?? '',
}));
