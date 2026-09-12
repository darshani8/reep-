/**
 * The faculty directory grid: its columns, its cell renderers, its selection.
 *
 * AG Grid builds cell contents itself, outside Angular's template compiler, so
 * a component-scoped class never reaches them. Every renderer below uses GLOBAL
 * classes (`.chip`, `.avatar`, `.btn`, `.icon` in styles/reep-v2.scss) and
 * inline styles, exactly as the roster grid on Students & batches does — and
 * escapes every value it interpolates.
 *
 * STATUS AND SIGN-IN ARE HERE AND THEY ARE EMPTY. The board draws both columns
 * and nothing on `main` reports either per faculty account: Active / Invited /
 * Disabled needs the disable columns (`B3.3`) and "has this person ever signed
 * in" needs the login events table (`B15`), both Phase 3. Each renders an em
 * dash and names its task in the header tooltip, and the screen repeats it once
 * in a `.notice.accent`. A plausible "Active · today 09:12" in a screenshot is
 * indistinguishable from working software.
 *
 * FUNCTIONS IS HALF ANSWERABLE AND SHOWS EXACTLY THAT HALF. The mentor function
 * is real today — it is the `Mentor` group the office creates by assigning the
 * first student — so a held group renders as the board's "Mentor · 14" chip.
 * HOD, placement officer and verifier are `B2.3` and are not guessed at; an
 * account with no group reads "No mentor group", which is what the API said,
 * and never "No function", which would be a claim about grants nothing here can
 * read.
 */

import type { ColDef, ICellRendererParams, RowSelectionOptions, SelectionColumnDef } from 'ag-grid-community';

import { NOT_READABLE, escapeHtml, type FacultyRow } from './faculty-row';

/** The tasks that will fill the two empty columns, said once here so the header
 *  tooltip and the screen's notice cannot drift apart. */
export const STATUS_PENDING_REASON =
  'Active / Invited / Disabled needs the account-disable columns (B3.3) and the sign-in history (B15), both Phase 3.';
export const SIGN_IN_PENDING_REASON =
  'Last sign-in is read from the login events table, which arrives with B15 (Phase 3).';

function renderNotReadable(): string {
  return `<span style="color: var(--faint);">${NOT_READABLE}</span>`;
}

function renderFacultyCell(params: ICellRendererParams<FacultyRow>): string {
  const row = params.data;
  if (!row) return '';
  return (
    `<span class="avatar">${escapeHtml(row.initials)}</span>` +
    `<span style="display: inline-flex; flex-direction: column; line-height: 1.25; min-width: 0;">` +
    `<span style="color: var(--brand-purple); font-weight: 600; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(row.name)}</span>` +
    `<span style="font-size: 11px; color: var(--faint); overflow: hidden; text-overflow: ellipsis;">${escapeHtml(row.email)}</span>` +
    `</span>`
  );
}

function renderDepartmentCell(params: ICellRendererParams<FacultyRow>): string {
  const row = params.data;
  if (!row) return '';
  if (row.isFiled) return escapeHtml(row.departmentLine);
  // Unfiled is not a blank: the API sorts these first precisely so somebody
  // files them, and the chip is what makes them findable in a long list.
  return `<span class="chip warn">${escapeHtml(row.departmentLine)}</span>`;
}

function renderDesignationCell(params: ICellRendererParams<FacultyRow>): string {
  const row = params.data;
  if (!row) return '';
  if (row.designation === null) {
    return `<span style="color: var(--faint);">Not on record</span>`;
  }
  return escapeHtml(row.designation);
}

function renderFunctionsCell(params: ICellRendererParams<FacultyRow>): string {
  const row = params.data;
  if (!row) return '';
  if (row.holdsMentorGroup === null) return renderNotReadable();
  if (!row.holdsMentorGroup) {
    return `<span class="chip">No mentor group</span>`;
  }
  const mentees = row.menteeCount ?? 0;
  return `<span class="chip accent">Mentor · ${mentees}</span>`;
}

function renderEditCell(params: ICellRendererParams<FacultyRow>): string {
  const row = params.data;
  if (!row) return '';
  return (
    `<button type="button" class="btn ghost sm" aria-label="Open ${escapeHtml(row.name)}">` +
    `<span class="icon" aria-hidden="true">chevron_right</span></button>`
  );
}

/** Ticking is a deliberate act: the toolbar's actions read the ticked rows, so
 *  a stray click on a cell must not change what they would touch. */
export const FACULTY_ROW_SELECTION: RowSelectionOptions<FacultyRow> = {
  mode: 'multiRow',
  checkboxes: true,
  headerCheckbox: true,
  enableClickSelection: false,
};

/** The tick travels with the pinned name column rather than scrolling away
 *  from the person it selects. */
export const FACULTY_SELECTION_COLUMN: SelectionColumnDef = { pinned: 'left', width: 44 };

export const DEFAULT_FACULTY_COLUMN: ColDef<FacultyRow> = {
  sortable: true,
  resizable: true,
  filter: true,
  floatingFilter: true,
  suppressHeaderMenuButton: false,
};

export const FACULTY_COLUMNS: ColDef<FacultyRow>[] = [
  {
    colId: 'faculty',
    field: 'name',
    headerName: 'Faculty',
    pinned: 'left',
    width: 250,
    cellRenderer: renderFacultyCell,
    cellClass: 'faculty-cell',
    // The quick filter matches the address as well as the name, because the
    // address is what the office has when somebody says "she cannot sign in".
    getQuickFilterText: (params) => `${params.data.name} ${params.data.email}`,
  },
  {
    colId: 'department',
    field: 'departmentLine',
    headerName: 'Department',
    width: 180,
    cellRenderer: renderDepartmentCell,
  },
  {
    colId: 'designation',
    field: 'designation',
    headerName: 'Designation',
    width: 165,
    cellRenderer: renderDesignationCell,
  },
  {
    colId: 'functions',
    headerName: 'Functions',
    width: 165,
    sortable: false,
    filter: false,
    floatingFilter: false,
    cellRenderer: renderFunctionsCell,
    headerTooltip:
      'The mentor function is the group the office assigns. HOD, placement officer and verifier arrive with B2.3 (Phase 3).',
  },
  {
    colId: 'status',
    headerName: 'Status',
    width: 140,
    sortable: false,
    filter: false,
    floatingFilter: false,
    cellRenderer: renderNotReadable,
    headerTooltip: STATUS_PENDING_REASON,
  },
  {
    colId: 'signIn',
    headerName: 'Sign-in',
    width: 130,
    sortable: false,
    filter: false,
    floatingFilter: false,
    cellRenderer: renderNotReadable,
    headerTooltip: SIGN_IN_PENDING_REASON,
  },
  {
    colId: 'actions',
    headerName: '',
    width: 60,
    sortable: false,
    filter: false,
    floatingFilter: false,
    resizable: false,
    cellRenderer: renderEditCell,
  },
];

/** What the Columns popover offers. The pinned name column is not among them:
 *  hiding the column that says who the row is leaves a grid of attributes. */
export const TOGGLEABLE_FACULTY_COLUMNS = [
  { id: 'department', label: 'Department' },
  { id: 'designation', label: 'Designation' },
  { id: 'functions', label: 'Functions' },
  { id: 'status', label: 'Status' },
  { id: 'signIn', label: 'Sign-in' },
];
