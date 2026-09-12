/**
 * What a Data import is made of: the two datasets, the pickers' options, and
 * the row shapes the preview and the history will carry.
 *
 * NOTHING HERE BUILDS A ROW. `ImportPreviewRow` and `RecentImportRow` are
 * declared so the grids beside them have real, typed columns — the columns are
 * what a reviewer checks this screen's board against — and so the Phase 4 task
 * that fills them (B8.1) has the shape already agreed. No function in this
 * directory constructs one: an import preview is what
 * `POST /api/admin/imports/preview` answers after reading the file on the
 * server, and a client that parsed the file itself to draw a plausible table
 * would be showing a reviewer numbers no validator ever checked.
 */

/** The two datasets B8.1 imports, and the only two the board offers. */
export type ImportDatasetKind = 'marks' | 'attendance';

export interface ImportDatasetOption {
  readonly kind: ImportDatasetKind;
  readonly label: string;
  /** The columns B8.1 is EXPECTED to read, and the sentence says so on screen.
   *  Marks are `subject_marks`' own columns; attendance is an AGGREGATE the
   *  table does not hold — `attendance_records` stores one row per session with
   *  a `present` boolean, so "sessions held / attended" is a proposal and not a
   *  shape the schema already agrees to. No importer exists, so a reader who
   *  builds a spreadsheet from this must not be told it is the final format. */
  readonly fileShape: string;
}

export const IMPORT_DATASETS: readonly ImportDatasetOption[] = [
  {
    kind: 'marks',
    label: 'Semester marks',
    fileShape:
      'Proposed for B8.1 — one row per student per subject: USN, subject code, subject name, credits, internal, external.',
  },
  {
    kind: 'attendance',
    label: 'Attendance',
    fileShape:
      'Proposed for B8.1 — one row per student per subject: USN, subject code, sessions held, sessions attended.',
  },
];

/** `PATCH /api/admin/students/{id}` bounds `current_semester` at 1..8, so a
 *  results file cannot name a semester the roster is able to hold. */
export const HIGHEST_SEMESTER = 8;

export const SEMESTERS: readonly number[] = Array.from(
  { length: HIGHEST_SEMESTER },
  (_unused, index) => index + 1,
);

/** What the office's spreadsheets are: B8.1 reads CSV and XLSX. */
export const ACCEPTED_IMPORT_FILE_TYPES = '.csv,.xlsx';

/** Rows per page in the preview's status bar, as the board's pager offers. */
export const PREVIEW_PAGE_SIZES: readonly number[] = [10, 25, 50, 100];
export const DEFAULT_PREVIEW_PAGE_SIZE = 10;

/** Where a value that no endpoint reports yet is drawn. The same dash the
 *  roster uses, so the two screens say "not readable" the same way. */
export const NOT_READABLE = '—';

// --------------------------------------------------------- the pickers ----

export interface CourseOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface BatchOption {
  readonly id: string;
  readonly name: string;
  readonly batchLabel: string;
  readonly courseId: string | null;
  /** The batch is still running — its end date is ahead. Ended batches are
   *  listed and marked, never hidden: a late results file for a batch that
   *  finished last month is the Main Admin's call. */
  readonly isRunning: boolean;
}

// ------------------------------------- what GET /api/register/hierarchy says

export interface HierarchyCourse {
  id: string;
  code: string;
  name: string;
}

export interface HierarchyBatch {
  id: string;
  code: string;
  name: string;
  batch_label: string;
  course_id: string | null;
  current: boolean;
}

export interface HierarchyDepartment {
  id: string;
  code: string;
  name: string;
  courses: HierarchyCourse[];
  batches: HierarchyBatch[];
}

export interface HierarchyCollege {
  id: string;
  code: string;
  name: string;
  departments: HierarchyDepartment[];
}

export interface HierarchyResponse {
  colleges: HierarchyCollege[];
}

// ------------------------------------------- what GET /api/admin/criteria says

export interface PlacementCriteriaOut {
  name: string;
  active: boolean;
  min_cgpa: number;
  max_live_backlogs: number;
  max_gap_months: number;
  min_attendance_pct: number;
  min_reep_completion_pct: number;
  min_cert_completion_pct: number;
  require_core_certs: boolean;
}

/** Where the criteria card is: reading, read, nothing set yet, or refused
 *  because this account holds `admin.institution` without `admin.analytics`. */
export type CriteriaState = 'loading' | 'ready' | 'none' | 'refused';

// ------------------------------------------------------- the grids' rows ----

/** A row's verdict after the SERVER has validated it (B8.1). */
export type ImportRowVerdict = 'ok' | 'warning' | 'error';

export interface ImportPreviewRow {
  readonly verdict: ImportRowVerdict;
  readonly usn: string;
  readonly studentName: string;
  readonly semester: number | null;
  /** The subjects read from the row, or the reason the row was refused. */
  readonly message: string;
  readonly sgpa: number | null;
  readonly liveBacklogs: number | null;
  readonly sessionsHeld: number | null;
  readonly sessionsAttended: number | null;
  readonly attendancePercent: number | null;
}

export interface RecentImportRow {
  readonly datasetLabel: string;
  readonly batchLabel: string;
  readonly rowsLabel: string;
  readonly byName: string;
  readonly whenLabel: string;
}
