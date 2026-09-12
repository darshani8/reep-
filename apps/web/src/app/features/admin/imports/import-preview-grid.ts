/**
 * The preview grid's columns, and the history grid's.
 *
 * THE COLUMNS ARE THE PART OF THIS BOARD THAT CAN BE BUILT TODAY. There is no
 * import endpoint on `main` at all — B8.1, Phase 4 — so both grids render with
 * no rows and the screen says so in one `.notice.accent`. What the columns do
 * is agree, now, on what the office will read after a file is validated: the
 * per-row verdict first, then who the row is about, then what it carries.
 *
 * AG Grid builds cells outside Angular's template compiler, so a
 * component-scoped class never reaches them; the one renderer below therefore
 * uses the GLOBAL `.chip` classes (styles/reep-v2.scss), exactly as the roster
 * grid does. It interpolates only this file's own literal words — never a
 * value off a row — so there is nothing here to escape.
 */

import type { ColDef, ICellRendererParams, ValueFormatterParams } from 'ag-grid-community';

import { NOT_READABLE, type ImportPreviewRow, type ImportRowVerdict, type RecentImportRow } from './import-dataset';

/** Status is shape and text together, never colour alone: `.chip.dot` puts a
 *  7px dot before a word that also says what happened. */
const VERDICT_CHIPS: Record<ImportRowVerdict, { label: string; tone: string }> = {
  ok: { label: 'OK', tone: 'good' },
  warning: { label: 'Warning', tone: 'warn' },
  error: { label: 'Error', tone: 'risk' },
};

function renderVerdictCell(params: ICellRendererParams<ImportPreviewRow>): string {
  const row = params.data;
  if (!row) return '';
  const chip = VERDICT_CHIPS[row.verdict];
  if (!chip) return '';
  return `<span class="chip dot ${chip.tone}">${chip.label}</span>`;
}

function formatNumberOrDash(params: ValueFormatterParams<ImportPreviewRow, number | null>): string {
  if (params.value === null || params.value === undefined) return NOT_READABLE;
  return String(params.value);
}

export const DEFAULT_IMPORT_COLUMN: ColDef = {
  sortable: true,
  resizable: true,
  suppressHeaderMenuButton: false,
};

/** Shared by both datasets: the verdict, then who the row is about. The USN is
 *  pinned, because it is the column that says which student a message is
 *  refusing and it must not scroll away from the message. */
const WHO_THE_ROW_IS_ABOUT: ColDef<ImportPreviewRow>[] = [
  {
    colId: 'verdict',
    field: 'verdict',
    headerName: 'Check',
    minWidth: 110,
    cellRenderer: renderVerdictCell,
    headerTooltip: 'The verdict the server returns for this row — OK, Warning or Error',
  },
  {
    colId: 'usn',
    field: 'usn',
    headerName: 'USN',
    pinned: 'left',
    minWidth: 160,
    cellStyle: { fontVariantNumeric: 'tabular-nums' },
  },
  {
    colId: 'studentName',
    field: 'studentName',
    headerName: 'Student',
    minWidth: 160,
    flex: 1,
  },
];

export const MARKS_PREVIEW_COLUMNS: ColDef<ImportPreviewRow>[] = [
  ...WHO_THE_ROW_IS_ABOUT,
  {
    colId: 'semester',
    field: 'semester',
    headerName: 'Sem',
    type: 'numericColumn',
    minWidth: 90,
    valueFormatter: formatNumberOrDash,
  },
  {
    colId: 'message',
    field: 'message',
    headerName: 'Subjects / message',
    minWidth: 280,
    flex: 2,
    headerTooltip: 'The subjects read from the row, or the reason the row was refused',
  },
  {
    colId: 'sgpa',
    field: 'sgpa',
    headerName: 'SGPA',
    type: 'numericColumn',
    minWidth: 100,
    valueFormatter: formatNumberOrDash,
  },
  {
    colId: 'liveBacklogs',
    field: 'liveBacklogs',
    headerName: 'Backlogs',
    type: 'numericColumn',
    minWidth: 110,
    valueFormatter: formatNumberOrDash,
    headerTooltip: 'Live backlogs — the count the placement criteria read',
  },
];

export const ATTENDANCE_PREVIEW_COLUMNS: ColDef<ImportPreviewRow>[] = [
  ...WHO_THE_ROW_IS_ABOUT,
  {
    colId: 'message',
    field: 'message',
    headerName: 'Subject / message',
    minWidth: 280,
    flex: 2,
    headerTooltip: 'The subject the sessions belong to, or the reason the row was refused',
  },
  {
    colId: 'sessionsHeld',
    field: 'sessionsHeld',
    headerName: 'Sessions held',
    type: 'numericColumn',
    minWidth: 130,
    valueFormatter: formatNumberOrDash,
  },
  {
    colId: 'sessionsAttended',
    field: 'sessionsAttended',
    headerName: 'Attended',
    type: 'numericColumn',
    minWidth: 120,
    valueFormatter: formatNumberOrDash,
  },
  {
    colId: 'attendancePercent',
    field: 'attendancePercent',
    headerName: 'Attendance %',
    type: 'numericColumn',
    minWidth: 130,
    valueFormatter: formatNumberOrDash,
  },
];

export const RECENT_IMPORT_COLUMNS: ColDef<RecentImportRow>[] = [
  {
    colId: 'datasetLabel',
    field: 'datasetLabel',
    headerName: 'Dataset',
    minWidth: 200,
    flex: 1.4,
  },
  {
    colId: 'batchLabel',
    field: 'batchLabel',
    headerName: 'Batch',
    minWidth: 160,
    flex: 1,
  },
  {
    colId: 'rowsLabel',
    field: 'rowsLabel',
    headerName: 'Rows',
    minWidth: 130,
  },
  {
    colId: 'byName',
    field: 'byName',
    headerName: 'By',
    minWidth: 160,
    flex: 1,
  },
  {
    colId: 'whenLabel',
    field: 'whenLabel',
    headerName: 'When',
    minWidth: 130,
  },
];
