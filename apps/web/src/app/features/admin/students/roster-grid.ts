/**
 * The roster grid: its columns, its cell renderers and its selection rules.
 *
 * AG Grid builds cell contents itself, outside Angular's template compiler, so
 * a component-scoped class never reaches them. Every renderer below therefore
 * uses GLOBAL classes (`.chip`, `.avatar`, `.btn`, `.icon` in
 * styles/reep-v2.scss) and inline styles, exactly as the mentor-load grid on
 * Analytics does — and escapes every value it interpolates, because a student's
 * name is somebody else's text.
 *
 * READINESS, CGPA AND ATTENDANCE ARE HERE AND THEY ARE EMPTY, AND THAT IS NOT
 * A PHASE. The board draws the three columns; `GET /api/admin/students` does
 * not carry any of them — it answers identity, seating and stage. All three
 * exist and are read per student on Student 360, one request per student, so a
 * roster that filled these cells would issue one request per ROW on every page.
 * Each therefore renders an em dash and its header tooltip says where the
 * number actually lives. The screen repeats that once in a `.notice.accent`. A
 * plausible number in a screenshot is indistinguishable from working software.
 */

import type {
  ColDef,
  ICellRendererParams,
  RowSelectionOptions,
  SelectionColumnDef,
  ValueFormatterParams,
} from 'ag-grid-community';

import { INITIALLY_HIDDEN_COLUMN_IDS, NOT_READABLE, escapeHtml, type RosterRow } from './roster-row';

function renderUsnCell(params: ICellRendererParams<RosterRow>): string {
  const row = params.data;
  if (!row) return '';
  if (row.usn === null) {
    return `<span style="color: var(--faint);">Not on record</span>`;
  }
  return `<span style="font-variant-numeric: tabular-nums; letter-spacing: 0.01em;">${escapeHtml(row.usn)}</span>`;
}

/** What the roster hands its cell renderers. */
export interface RosterGridContext {
  /** Whether this reader can open Student 360 — see renderStudentCell. */
  readonly canOpenDetail: boolean;
}

function renderStudentCell(params: ICellRendererParams<RosterRow>): string {
  const row = params.data;
  if (!row) return '';
  const identity =
    `<span style="font-size: 11px; color: var(--faint); overflow: hidden; text-overflow: ellipsis;">` +
    `${escapeHtml(row.email)}</span>`;

  // THE NAME IS A LINK ONLY WHEN THE READER CAN FOLLOW IT. This roster is
  // guarded by `admin.students` alone, while Student 360 is a new screen and
  // carries `ui.console_v2` as well, so a faculty member granted the roster and
  // not the preview would have seen a purple link on every row that bounced
  // them back to their own home — the dead link the navigation model exists to
  // make impossible. For them the name is plain text.
  const name = (params.context as RosterGridContext | undefined)?.canOpenDetail
    ? // A real anchor, so the keyboard reaches it and the status bar shows where
      // it goes; the click is intercepted into the router so the SPA does not
      // reload.
      `<a href="/admin/students/${encodeURIComponent(row.studentId)}" style="color: var(--brand-purple); font-weight: 600; text-decoration: none; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(row.name)}</a>`
    : `<span style="font-weight: 600; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(row.name)}</span>`;

  return (
    `<span class="avatar">${escapeHtml(row.initials)}</span>` +
    `<span style="display: inline-flex; flex-direction: column; line-height: 1.25; min-width: 0;">` +
    name +
    identity +
    `</span>`
  );
}

function renderSpecializationCell(params: ICellRendererParams<RosterRow>): string {
  const row = params.data;
  if (!row) return '';
  if (row.specializationCode === null) {
    return `<span style="color: var(--faint);">${NOT_READABLE}</span>`;
  }
  const dot =
    `<span style="width: 7px; height: 7px; border-radius: 4px; display: inline-block; ` +
    `margin-right: 6px; background: ${row.specializationColour};"></span>`;
  return `<span class="chip">${dot}${escapeHtml(row.specializationCode)}</span>`;
}

function renderMentorCell(params: ICellRendererParams<RosterRow>): string {
  const row = params.data;
  if (!row) return '';
  if (row.mentorName === null) {
    return '<span class="chip warn">Not assigned</span>';
  }
  return escapeHtml(row.mentorName);
}

function renderStatusCell(params: ICellRendererParams<RosterRow>): string {
  const row = params.data;
  if (!row) return '';
  // Label and tone are this file's own words, never roster text.
  return `<span class="chip dot ${row.statusTone}">${row.statusLabel}</span>`;
}

function renderEditCell(params: ICellRendererParams<RosterRow>): string {
  const row = params.data;
  if (!row) return '';
  return (
    `<button type="button" class="btn ghost sm" aria-label="Edit ${escapeHtml(row.name)}">` +
    `<span class="icon" aria-hidden="true">edit</span></button>`
  );
}

function formatBatch(params: ValueFormatterParams<RosterRow, string | null>): string {
  return params.value ?? 'No batch';
}

/** The three columns the board draws and nothing answers yet. */
function formatNotReadable(): string {
  return NOT_READABLE;
}

export const ROSTER_ROW_SELECTION: RowSelectionOptions<RosterRow> = {
  mode: 'multiRow',
  checkboxes: true,
  headerCheckbox: true,
  // Ticking is a deliberate act on this screen: the toolbar acts on the
  // ticked rows, so a stray click on a cell must not change what a bulk
  // action would touch.
  enableClickSelection: false,
};

/** The tick column travels with the pinned USN column rather than scrolling
 *  away from the row it selects. */
export const ROSTER_SELECTION_COLUMN: SelectionColumnDef = { pinned: 'left', width: 44 };

export const DEFAULT_ROSTER_COLUMN: ColDef<RosterRow> = {
  sortable: true,
  resizable: true,
  filter: true,
  floatingFilter: true,
  suppressHeaderMenuButton: false,
};

export const ROSTER_COLUMNS: ColDef<RosterRow>[] = [
  {
    colId: 'usn',
    field: 'usn',
    headerName: 'USN',
    pinned: 'left',
    minWidth: 160,
    cellRenderer: renderUsnCell,
  },
  {
    colId: 'name',
    field: 'name',
    headerName: 'Student',
    minWidth: 220,
    flex: 1.4,
    cellStyle: { display: 'flex', alignItems: 'center', gap: '8px' },
    cellRenderer: renderStudentCell,
  },
  {
    colId: 'specialization',
    field: 'specializationCode',
    headerName: 'Spec.',
    minWidth: 110,
    cellRenderer: renderSpecializationCell,
    headerTooltip: 'The specialization named on the student’s batch',
  },
  {
    colId: 'semester',
    field: 'semester',
    headerName: 'Sem',
    type: 'numericColumn',
    minWidth: 90,
  },
  {
    colId: 'stage',
    field: 'stageLabel',
    headerName: 'Stage',
    minWidth: 120,
    headerTooltip: 'The REEP programme stage: Reboot, Excel, Excel-Adv, Elevate',
  },
  {
    colId: 'mentor',
    field: 'mentorName',
    headerName: 'Faculty',
    minWidth: 170,
    flex: 1,
    cellRenderer: renderMentorCell,
  },
  {
    colId: 'readiness',
    field: 'readiness',
    headerName: 'Readiness',
    minWidth: 120,
    sortable: false,
    filter: false,
    floatingFilter: false,
    valueFormatter: formatNotReadable,
    headerTooltip:
      'Not on the roster endpoint. Placement readiness is computed per student and is read on Student 360 — open the row.',
  },
  {
    colId: 'cgpa',
    field: 'cgpa',
    headerName: 'CGPA',
    type: 'numericColumn',
    minWidth: 100,
    sortable: false,
    filter: false,
    floatingFilter: false,
    valueFormatter: formatNotReadable,
    headerTooltip:
      'Not on the roster endpoint. Marks are imported on Data imports and read per student on Student 360 — open the row.',
  },
  {
    colId: 'attendance',
    field: 'attendancePercent',
    headerName: 'Attend.',
    type: 'numericColumn',
    minWidth: 110,
    sortable: false,
    filter: false,
    floatingFilter: false,
    valueFormatter: formatNotReadable,
    headerTooltip:
      'Not on the roster endpoint. Attendance is imported on Data imports and read per student on Student 360 — open the row.',
  },
  {
    colId: 'batch',
    field: 'batchName',
    headerName: 'Batch',
    minWidth: 200,
    hide: INITIALLY_HIDDEN_COLUMN_IDS.includes('batch'),
    valueFormatter: formatBatch,
  },
  {
    colId: 'status',
    field: 'statusLabel',
    headerName: 'Status',
    minWidth: 150,
    cellRenderer: renderStatusCell,
    headerTooltip: 'Active once the student has signed in; Invited until they walk the setup link',
  },
  {
    colId: 'actions',
    headerName: '',
    pinned: 'right',
    width: 64,
    sortable: false,
    filter: false,
    floatingFilter: false,
    resizable: false,
    suppressHeaderMenuButton: true,
    cellStyle: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
    cellRenderer: renderEditCell,
  },
];

/** What the Columns panel lists. The selection and action columns are not on
 *  it: one is the grid's own, the other is the only way to open the editor. */
export const TOGGLEABLE_ROSTER_COLUMNS = ROSTER_COLUMNS
  .filter((column) => column.colId !== 'actions')
  .map((column) => ({ id: column.colId ?? '', label: column.headerName ?? '' }));
