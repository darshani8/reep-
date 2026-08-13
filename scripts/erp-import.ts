/**
 * The student roster, previewed before it is imported.
 *
 *   npm run roster -- ./exports/students-ug.csv
 *   npm run roster -- ./exports/roster.xlsx
 *
 * You export the roster from the college's own student portal — the way you are
 * meant to use it, one click — and hand this the file. It reads it, shows you
 * exactly what would be imported and what it could not make sense of, and writes
 * NOTHING. It never contacts the portal, and it needs no database: it is the
 * `parseRoster` from `src/lib/roster` run over your file, and nothing else.
 *
 * It imports only from `src/lib/roster` and `src/lib/jobs/parse`, both free of
 * `server-only` and of Prisma — which is what lets it run under plain `tsx` at
 * all (see the note in AGENTS.md about why installing `server-only` is the wrong
 * fix). Writing the previewed rows into the database is the deliberate next
 * step: a student needs a cohort assigned, and that mapping is a decision to
 * make against your real columns once this preview shows what they are — not a
 * guess to bake in now.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Workbook } from 'exceljs';

import {
  parseRoster,
  parseDelimited,
  flattenCell,
  type ParsedStudent,
  type RawRow,
  type RowIssue,
} from '../src/lib/roster/parse';

const USAGE = `
REEP roster preview

  npm run roster -- <file.csv | file.xlsx>

Reads a student roster exported from the college portal and shows what would be
imported. Writes nothing, contacts nothing. UG and PG are separated the way the
jobs page separates them — from a degree column, or from the USN branch code.
`.trim();

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/// A grid of cells from either format. The same reader the committing importer
/// uses, kept here so the preview cannot diverge from it.
async function readSheet(file: string): Promise<RawRow[]> {
  const name = file.toLowerCase();
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      fail(`No such file: ${file}`);
    }
    throw error;
  }

  if (name.endsWith('.csv')) {
    return parseDelimited(new TextDecoder('utf-8').decode(bytes));
  }
  if (!name.endsWith('.xlsx')) {
    fail(`${path.basename(file)} is not a .csv or .xlsx. Re-save it in one of those formats.`);
  }

  const workbook = new Workbook();
  try {
    // exceljs wants an ArrayBuffer; a Node Buffer is a view onto one, so hand
    // over exactly its bytes rather than the whole backing store.
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    await workbook.xlsx.load(arrayBuffer as ArrayBuffer);
  } catch {
    fail('That file could not be opened as a spreadsheet. If it is an old .xls, re-save it as .xlsx.');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) fail('The workbook has no sheets in it.');

  const rows: RawRow[] = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    rows[rowNumber - 1] = values.map((value) => flattenCell(value));
  });
  for (let i = 0; i < rows.length; i += 1) rows[i] ??= [];
  return rows;
}

function table(students: ParsedStudent[]): void {
  const width = (pick: (s: ParsedStudent) => string, min: number) =>
    Math.max(min, ...students.map((s) => pick(s).length));

  const usnW = width((s) => s.usn, 6);
  const nameW = Math.min(28, width((s) => s.name, 4));
  const progW = Math.min(16, width((s) => s.programme ?? '—', 9));
  const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t).padEnd(n);

  console.log();
  console.log(
    `  ${cut('USN', usnW)}  ${cut('NAME', nameW)}  ${'LEVEL'.padEnd(5)}  ${cut('PROGRAMME', progW)}  SEM  VIA`,
  );
  for (const s of students) {
    console.log(
      `  ${cut(s.usn, usnW)}  ${cut(s.name, nameW)}  ${s.degreeLevel.padEnd(5)}  ` +
        `${cut(s.programme ?? '—', progW)}  ${String(s.semester ?? '—').padEnd(3)}  ${s.degreeSource}`,
    );
  }
  console.log();
}

function issues(label: string, rows: RowIssue[]): void {
  if (rows.length === 0) return;
  console.log(`  ${label} (${rows.length}):`);
  for (const issue of rows) {
    console.log(`    row ${issue.row}  [${issue.column}]  ${issue.message}`);
  }
  console.log();
}

async function main(): Promise<void> {
  const [file] = process.argv.slice(2);
  if (!file || file === '--help' || file === 'help') {
    console.log(`\n${USAGE}\n`);
    return;
  }

  const rows = await readSheet(file);
  const { students, errors, warnings, headerRow } = parseRoster(rows);

  console.log(`\n  ${path.basename(file)} — header on row ${headerRow || '(not found)'}`);

  const ug = students.filter((s) => s.degreeLevel === 'UG').length;
  const pg = students.filter((s) => s.degreeLevel === 'PG').length;
  const inferred = students.filter((s) => s.degreeSource === 'usn').length;

  console.log(
    `  ${students.length} students would be imported — ${pg} PG, ${ug} UG` +
      `${errors.length ? `, ${errors.length} rows skipped` : ''}` +
      `${inferred ? `. ${inferred} classified from the USN, not a column — worth a glance.` : '.'}`,
  );

  if (students.length > 0) table(students);
  issues('Skipped', errors);
  issues('Kept, with a warning', warnings);

  console.log(
    '  This was a preview — nothing was written. If the columns above look right,\n' +
      '  tell me and I will wire the commit step (each student needs a cohort assigned).\n',
  );
}

main().catch((error: unknown) => {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
