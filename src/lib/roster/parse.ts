/**
 * A student roster export, turned into rows the database will accept.
 *
 * The office exports the roster from the college's student system — one sheet
 * for UG, one for PG, or one mixed sheet — and hands us the file. It is the same
 * problem the jobs sheet has, so this is the jobs parser's sibling and shares
 * its generic half (`../jobs/parse`): the header is never spelled the same twice
 * ("USN" one export, "Reg No" the next), a stray row is broken, and rejecting
 * the whole file over one bad line means the roster stays empty over a typo.
 *
 * Three decisions carry the module:
 *
 *  - **A bad row loses its row, not the sheet.** Every rejection names the 1-based
 *    row the operator sees in their spreadsheet and the column that caused it.
 *  - **USN is the identity, and it is stable.** A re-exported sheet re-imports
 *    onto the same students, so the key is the uppercased USN and nothing else.
 *    A duplicate USN within one sheet is a correction, not a second student —
 *    the last one wins, with a warning.
 *  - **UG/PG is never guessed loosely.** The spec's whole jobs page turns on the
 *    split, so degree level comes from an explicit column when the sheet has one
 *    and from the USN's own branch code when it does not (`1BG24MBA001` → MBA →
 *    PG). A row we cannot place on one side or the other is skipped and reported,
 *    never defaulted — a student filed under the wrong programme is worse than a
 *    student the operator is told to classify by hand.
 *
 * No `server-only`, no Prisma, no exceljs: it takes a grid of cells and returns
 * values, which is what lets the dry-run preview and the commit run the
 * identical parse. A preview produced by different code from the write is a
 * preview of nothing. This is the half a test and a `tsx` script can import.
 */

import type { DegreeLevel } from '@prisma/client';

import {
  flattenCell,
  normaliseHeader,
  parseDegreeLevel,
  parseDelimited,
  type RawCell,
  type RawRow,
  type RowIssue,
} from '../jobs/parse';

// Re-exported so the roster importer and its script have one place to reach for
// the grid-reading primitives, rather than importing half from jobs and half
// from here.
export { flattenCell, parseDelimited, type RawCell, type RawRow, type RowIssue };

/// One student the sheet described well enough to store.
export type ParsedStudent = {
  /// Stable identity across re-imports, uppercased. This is the whole key.
  usn: string;
  name: string;
  email: string | null;
  degreeLevel: DegreeLevel;
  /// The branch or course as written — "MBA", "BBA", "Computer Science". Kept
  /// verbatim for display; the degree level above is the derived, filterable one.
  programme: string | null;
  /// 1–8, or null when the sheet does not carry it.
  semester: number | null;
  section: string | null;
  phone: string | null;
  /// Where in the sheet it came from, for the preview table.
  rowNumber: number;
  /// How degreeLevel was decided, so the preview can flag the inferred ones for
  /// a second look. A whole cohort inferred from USNs is worth a glance before
  /// it is committed.
  degreeSource: 'column' | 'usn';
};

export type ParsedRoster = {
  students: ParsedStudent[];
  /// Rows that were skipped.
  errors: RowIssue[];
  /// Rows that were kept, with something worth telling the operator.
  warnings: RowIssue[];
  /// The 1-based sheet row the headers were found on, or 0 when they were not.
  headerRow: number;
};

// ---------------------------------------------------------------------------
// Header matching
// ---------------------------------------------------------------------------

/// Every spelling of a column seen in a real export, plus the obvious synonyms.
/// Matched against the header cell normalised to lowercase words.
const COLUMN_ALIASES: Record<string, string[]> = {
  usn: [
    'usn', 'university seat number', 'reg no', 'reg number', 'register no',
    'register number', 'registration number', 'registration no', 'roll no',
    'roll number', 'student id', 'admission no', 'admission number',
  ],
  name: ['name', 'student name', 'full name', 'name of student', 'candidate name', 'student'],
  email: ['email', 'email id', 'e mail', 'mail', 'email address', 'college email', 'official email'],
  degreeLevel: ['degree level', 'level', 'ug pg', 'ug pg', 'degree type', 'programme level', 'program level'],
  programme: [
    'programme', 'program', 'branch', 'course', 'department', 'dept',
    'discipline', 'stream', 'specialization', 'specialisation', 'degree',
  ],
  semester: ['semester', 'sem', 'current semester', 'sem no', 'current sem'],
  section: ['section', 'sec', 'division', 'div'],
  phone: [
    'phone', 'mobile', 'contact', 'phone number', 'phone no', 'mobile number',
    'mobile no', 'contact number', 'contact no',
  ],
};

/// The columns without which a row is not a student.
const REQUIRED_COLUMNS = ['usn', 'name'] as const;

type ColumnMap = Partial<Record<keyof typeof COLUMN_ALIASES, number>>;

function text(value: RawCell): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

/// The first row that names at least a USN and a name is the header. A sheet
/// with a college banner above the table is the normal case, not an error.
function findHeader(rows: RawRow[]): { index: number; columns: ColumnMap } | null {
  for (let index = 0; index < rows.length; index += 1) {
    const columns = mapColumns(rows[index] ?? []);
    if (columns.usn != null && columns.name != null) return { index, columns };
  }
  return null;
}

function mapColumns(row: RawRow): ColumnMap {
  const columns: ColumnMap = {};
  row.forEach((cell, position) => {
    const header = normaliseHeader(cell);
    if (!header) return;
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (columns[field as keyof ColumnMap] != null) continue;
      if (aliases.includes(header)) {
        columns[field as keyof ColumnMap] = position;
        return;
      }
    }
  });
  return columns;
}

// ---------------------------------------------------------------------------
// USN
// ---------------------------------------------------------------------------

/// VTU USNs that belong to a postgraduate programme. Everything else with a
/// recognised branch code is undergraduate — the engineering branches (CS, IS,
/// EC, ME, CV, EE…) and the bachelor programmes (BBA, BCA) are all UG.
const PG_BRANCHES = new Set(['MBA', 'MCA', 'MTECH', 'MTE', 'MT']);

/// `1BG24MBA001` → college `1BG`, year `24`, branch `MBA`, serial `001`. The
/// branch is the half that decides UG vs PG when the sheet does not say.
const USN_PATTERN = /^(\d[A-Z]{2})(\d{2})([A-Z]{2,5})(\d{1,4})$/;

/// A USN uppercased and stripped of spaces, or null when the cell is empty.
/// A value that is present but does not look like a USN is returned as-is
/// (uppercased) rather than rejected — some colleges issue provisional numbers
/// during admission, and the identity still has to be stable.
export function normaliseUsn(value: RawCell): string | null {
  const raw = text(value).toUpperCase().replace(/\s+/g, '');
  return raw || null;
}

/// The branch code inside a USN, or null when it does not parse as one.
export function usnBranch(usn: string): string | null {
  const match = USN_PATTERN.exec(usn);
  return match ? match[3] : null;
}

export function degreeFromUsn(usn: string): DegreeLevel | null {
  const branch = usnBranch(usn);
  if (!branch) return null;
  return PG_BRANCHES.has(branch) ? 'PG' : 'UG';
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

/// A semester number 1–8, or null. VTU numbers semesters 1–8 for a four-year
/// UG and 1–4 for a two-year PG; anything outside 1–8 is a typo, not a semester.
export function parseSemester(value: RawCell): number | null {
  const raw = text(value);
  if (!raw) return null;
  const digits = /(\d{1,2})/.exec(raw);
  if (!digits) return null;
  const semester = Number(digits[1]);
  return semester >= 1 && semester <= 8 ? semester : null;
}

/// An email lowercased, or null when blank, or `false` when it is plainly not an
/// address. Kept lenient — one broken email must not cost a student their row,
/// so the caller warns rather than skips.
export function parseEmail(value: RawCell): string | null | false {
  const raw = text(value).toLowerCase();
  if (!raw) return null;
  // Deliberately loose: a local-part, an @, a dotted domain. Rejecting valid
  // but unusual addresses would be worse than passing a rare bad one.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : false;
}

/// Digits and a leading + only. A phone column full of "N/A" and "-" should
/// leave the field null, not store the punctuation.
export function parsePhone(value: RawCell): string | null {
  const raw = text(value).replace(/[^\d+]/g, '');
  const digits = raw.replace(/\D/g, '');
  // Fewer than eight digits is not a phone number; it is a leftover dash.
  return digits.length >= 8 ? raw : null;
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

export function parseRoster(rows: RawRow[]): ParsedRoster {
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];

  const header = findHeader(rows);
  if (!header) {
    return {
      students: [],
      headerRow: 0,
      warnings,
      errors: [
        {
          row: 0,
          column: 'header',
          message:
            'No header row found. The sheet needs a row naming at least a USN and a name column.',
        },
      ],
    };
  }

  const missing = REQUIRED_COLUMNS.filter((field) => header.columns[field] == null);
  if (missing.length > 0) {
    return {
      students: [],
      headerRow: header.index + 1,
      warnings,
      errors: [
        {
          row: header.index + 1,
          column: missing.join(', '),
          message: `The header row names no ${missing.join(' or ')} column, so no row can be read.`,
        },
      ],
    };
  }

  const at = (row: RawRow, field: keyof ColumnMap): RawCell => {
    const position = header.columns[field];
    return position == null ? null : (row[position] ?? null);
  };

  /// Last row wins on a repeated USN: a sheet that corrects an earlier line
  /// further down is correcting it, not describing a second student.
  const byUsn = new Map<string, ParsedStudent>();

  for (let index = header.index + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const rowNumber = index + 1;

    if (row.every((cell) => text(cell) === '')) continue;

    const usn = normaliseUsn(at(row, 'usn'));
    const name = text(at(row, 'name'));
    if (!usn || !name) {
      errors.push({
        row: rowNumber,
        column: !usn ? 'usn' : 'name',
        message: `Blank ${!usn ? 'USN' : 'name'} — row skipped`,
      });
      continue;
    }

    // Degree level: the sheet's own column first, the USN's branch code second,
    // and a skip-with-reason when neither can place the student. Never a default.
    const stated = parseDegreeLevel(at(row, 'degreeLevel')) ?? parseDegreeLevel(at(row, 'programme'));
    const degreeLevel = stated ?? degreeFromUsn(usn);
    if (!degreeLevel) {
      errors.push({
        row: rowNumber,
        column: 'degreeLevel',
        message:
          `Cannot tell whether ${usn} is UG or PG — no degree column, and the USN branch is unrecognised. ` +
          'Add a degree/programme column or check the USN — row skipped',
      });
      continue;
    }
    const degreeSource: ParsedStudent['degreeSource'] = stated ? 'column' : 'usn';

    const email = parseEmail(at(row, 'email'));
    if (email === false) {
      warnings.push({
        row: rowNumber,
        column: 'email',
        message: `"${text(at(row, 'email'))}" is not a usable email — the student is imported without one`,
      });
    }

    const student: ParsedStudent = {
      usn,
      name,
      email: email === false ? null : email,
      degreeLevel,
      programme: text(at(row, 'programme')) || null,
      semester: parseSemester(at(row, 'semester')),
      section: text(at(row, 'section')) || null,
      phone: parsePhone(at(row, 'phone')),
      rowNumber,
      degreeSource,
    };

    const earlier = byUsn.get(usn);
    if (earlier) {
      warnings.push({
        row: rowNumber,
        column: 'usn',
        message: `Same USN as row ${earlier.rowNumber} — this row replaces it`,
      });
    }
    byUsn.set(usn, student);
  }

  return { students: [...byUsn.values()], errors, warnings, headerRow: header.index + 1 };
}
