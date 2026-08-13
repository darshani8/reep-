/**
 * The import report, flattened for the wire.
 *
 * It sits in its own module — with no `server-only` and no value import from
 * `import.ts` — because both ends need it: the route handler builds it and the
 * director's browser renders it. A shape declared inside the route file would
 * drag a type-only import of a server module into the client graph, which is
 * the sort of thing that works until a bundler stops erasing it.
 *
 * Everything here is already a string. Dates do not survive JSON as dates, and
 * a screen that re-parses them is a screen that can get the timezone wrong on
 * the one column — a closing date — where being a day out matters.
 */

import type { JobImportReport } from './import';

export type ImportDisposition = 'create' | 'update' | 'unchanged';

export type ImportPreviewRow = {
  /// The sheet row number, doubling as the grid's row id.
  id: string;
  rowNumber: number;
  disposition: ImportDisposition;
  title: string;
  company: string;
  degreeLevel: string;
  location: string;
  postedLabel: string;
  closesLabel: string;
  skillsLabel: string;
  /// Fields this import would overwrite. Empty for a new row.
  changesLabel: string;
};

export type ImportIssue = { row: number; column: string; message: string };

export type ImportPreview = {
  fileName: string;
  headerRow: number;
  rowsSeen: number;
  counts: Record<ImportDisposition, number>;
  rows: ImportPreviewRow[];
  /// Rows that were, or would be, skipped.
  errors: ImportIssue[];
  /// Rows that came through with something the operator should know.
  warnings: ImportIssue[];
  /// Null for a dry run.
  committed: { runId: string; created: number; updated: number } | null;
};

const DATE: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' };

export function toImportPreview(report: JobImportReport): ImportPreview {
  return {
    fileName: report.fileName,
    headerRow: report.headerRow,
    rowsSeen: report.rowsSeen,
    counts: report.counts,
    errors: report.errors,
    warnings: report.warnings,
    committed: report.committed,
    rows: report.planned.map((entry) => ({
      id: String(entry.job.rowNumber),
      rowNumber: entry.job.rowNumber,
      disposition: entry.disposition,
      title: entry.job.title,
      company: entry.job.company,
      degreeLevel: entry.job.degreeLevel,
      location: entry.job.location ?? '',
      postedLabel: entry.job.postedOn.toLocaleDateString('en-IN', DATE),
      closesLabel: entry.job.closesOn
        ? entry.job.closesOn.toLocaleDateString('en-IN', DATE)
        : 'No closing date',
      skillsLabel: entry.job.requiredSkills.join(', '),
      changesLabel: entry.changes.join(', '),
    })),
  };
}
