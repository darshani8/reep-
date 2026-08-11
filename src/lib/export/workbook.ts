import 'server-only';

/**
 * The whole programme as one .xlsx — a sheet per table, plus a cover sheet.
 *
 * The cover sheet is not decoration. A workbook that lands in a placement
 * cell's inbox three weeks from now has to answer "what is this, when was it
 * taken, and which cohort" without anyone opening the dashboard; leaving that
 * out is how a stale export gets quoted in a meeting as current.
 *
 * Column order, headers and widths all come from the catalogue in `collect.ts`,
 * so a sheet can never disagree with the CSV of the same table.
 */

import { Workbook } from 'exceljs';

import { EXPORT_TABLES, type ProgrammeData } from './collect';

/// Excel refuses sheet names over 31 characters or containing []:*?/\.
const SHEET_NAME_LIMIT = 31;

const HEADER_FILL_ROW = 1;

export async function buildWorkbook(data: ProgrammeData): Promise<ArrayBuffer> {
  const workbook = new Workbook();
  const generatedAt = new Date(data.generatedAt);

  workbook.creator = 'REEP Dashboard — BGSCET MBA';
  workbook.created = generatedAt;
  workbook.modified = generatedAt;

  // --- cover sheet --------------------------------------------------------

  const cover = workbook.addWorksheet('About this export');
  // No `header` on the columns: widths only, so exceljs does not insert a
  // header row above the title.
  cover.columns = [
    { key: 'label', width: 24 },
    { key: 'count', width: 12 },
    { key: 'detail', width: 92 },
  ];

  cover.addRow(['REEP programme export']).font = { bold: true, size: 14 };
  cover.addRow(['Scope', '', data.scope.label]);
  cover.addRow(['Generated', '', generatedAt.toISOString()]);
  cover.addRow([]);
  cover.addRow(['Sheet', 'Rows', 'What it contains']).font = { bold: true };

  let total = 0;
  for (const table of EXPORT_TABLES) {
    const rows = data[table.key];
    total += rows.length;
    cover.addRow([table.sheetName, rows.length, table.description]);
  }
  cover.addRow(['Total rows', total, '']).font = { bold: true };
  cover.getColumn('detail').alignment = { wrapText: true, vertical: 'top' };

  // --- one sheet per table ------------------------------------------------

  for (const table of EXPORT_TABLES) {
    const sheet = workbook.addWorksheet(table.sheetName.slice(0, SHEET_NAME_LIMIT), {
      // Freezing the header keeps the column you are reading identifiable when
      // a 1,400-row sessions sheet is scrolled.
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    sheet.columns = table.columns.map((column) => ({
      header: column.header,
      key: column.key,
      width: column.width,
    }));

    table.columns.forEach((column, index) => {
      // Percentages and hours read as noise at full float precision.
      if (column.header.includes('%') || column.header.includes('hrs')) {
        sheet.getColumn(index + 1).numFmt = '0.0';
      }
    });

    const header = sheet.getRow(HEADER_FILL_ROW);
    header.font = { bold: true };
    header.alignment = { vertical: 'middle' };

    if (table.columns.length > 0) {
      sheet.autoFilter = {
        from: { row: HEADER_FILL_ROW, column: 1 },
        to: { row: HEADER_FILL_ROW, column: table.columns.length },
      };
    }

    // addRow keyed by object maps each value onto the column with that key, so
    // a column reorder in the catalogue cannot desynchronise the data.
    for (const row of data[table.key]) sheet.addRow(row);
  }

  // exceljs hands back a Node Buffer here, which is a view onto a pooled
  // allocation — copying out the exact range is what makes it safe to pass
  // straight to a Response as an ArrayBuffer.
  const written = (await workbook.xlsx.writeBuffer()) as unknown as ArrayBuffer | Uint8Array;
  if (written instanceof Uint8Array) {
    return written.buffer.slice(
      written.byteOffset,
      written.byteOffset + written.byteLength,
    ) as ArrayBuffer;
  }
  return written;
}

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
