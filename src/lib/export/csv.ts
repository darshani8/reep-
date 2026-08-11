/**
 * RFC 4180 CSV, written for the spreadsheet that will actually open it.
 *
 * Three details matter more than the format itself:
 *
 *  - **The BOM.** Excel on Windows decodes a plain `.csv` as the system
 *    codepage, which turns half a roster of Kannada-origin names into mojibake.
 *    A leading U+FEFF is what makes it read UTF-8, and it costs three bytes.
 *  - **CRLF line endings**, which is what RFC 4180 specifies and what Excel,
 *    Numbers and Google Sheets all agree on.
 *  - **Formula neutralisation.** A mentor note that happens to begin `=` or `+`
 *    is data, not a formula; prefixing it stops a spreadsheet evaluating text
 *    a student typed. This is the standard CSV-injection mitigation.
 */

import type { Cell, ColumnSpec, ExportRow } from './collect';

export const UTF8_BOM = '﻿';

/// Characters that make a spreadsheet treat a text cell as a formula.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/// Anything that forces a field to be quoted.
const NEEDS_QUOTES = /[",\r\n]/;

function render(value: Cell | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return value;
}

export function escapeCell(value: Cell | undefined): string {
  let text = render(value);
  // Numbers are emitted as numbers, so a leading '-' here is always text.
  if (typeof value === 'string' && FORMULA_LEAD.test(text)) text = `'${text}`;
  if (NEEDS_QUOTES.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/// Header row plus every data row, in the column order the catalogue declares.
export function toCsv(columns: ColumnSpec[], rows: ExportRow[]): string {
  const header = columns.map((column) => escapeCell(column.header)).join(',');
  const body = rows.map((row) =>
    columns.map((column) => escapeCell(row[column.key])).join(','),
  );
  return [header, ...body].join('\r\n');
}

/// The bytes to hand back from a route: BOM first, then the CSV.
export function csvDocument(columns: ColumnSpec[], rows: ExportRow[]): string {
  return `${UTF8_BOM}${toCsv(columns, rows)}`;
}
