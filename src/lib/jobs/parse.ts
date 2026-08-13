/**
 * The weekly jobs sheet, turned into rows the database will accept.
 *
 * The placement cell sends a spreadsheet every Tuesday. It is typed by a human,
 * so the header row is never the same twice ("Role" one week, "Job Title" the
 * next), dates arrive as text as often as dates, and two lines in twenty are
 * broken. Three decisions follow from that, and they are the reason this module
 * exists at all:
 *
 *  - **A bad row loses its row, not the sheet.** Rejecting the whole file
 *    because line 14 says "ASAP" in the closing-date column means the board
 *    stays a week stale over one typo. Every rejection is reported with its row
 *    number and the column that caused it, so the operator can fix exactly that
 *    line.
 *  - **A sheet re-sent is a sheet re-imported.** The same posting must land on
 *    the same row every time, so each parsed job carries a `key`:
 *    `sourceRef` when the sheet numbers its rows, and a normalisation of
 *    company + title + apply URL when it does not. Getting this wrong is how a
 *    board ends up showing Tuesday's twenty vacancies four times.
 *  - **Nothing here touches exceljs, Prisma or the request.** It takes a grid
 *    of cells and returns values, which is what lets the dry-run preview and
 *    the commit run the identical parse — a preview that used different code
 *    from the write would be a preview of nothing.
 *
 * No `server-only`: this is the half a test and a script can import.
 */

import type { DegreeLevel } from '@prisma/client';

/// One cell, as either a CSV reader or exceljs hands it over.
export type RawCell = string | number | boolean | Date | null | undefined;
export type RawRow = RawCell[];

/// A row the importer will not write, and why. `row` is 1-based — the number
/// the operator sees in the corner of their spreadsheet.
export type RowIssue = { row: number; column: string; message: string };

/// A posting the sheet described well enough to store.
export type ParsedJob = {
  /// Stable identity across re-imports. Never shown to a reader.
  key: string;
  sourceRef: string | null;
  title: string;
  company: string;
  degreeLevel: DegreeLevel;
  location: string | null;
  applyUrl: string | null;
  description: string;
  /// Canonical `Skill.slug` values, resolved through the catalogue where the
  /// sheet used a name or an alias.
  requiredSkills: string[];
  postedOn: Date;
  closesOn: Date | null;
  /// Where in the sheet it came from, for the preview table.
  rowNumber: number;
};

export type ParsedSheet = {
  jobs: ParsedJob[];
  /// Rows that were skipped.
  errors: RowIssue[];
  /// Rows that were kept, with something worth telling the operator.
  warnings: RowIssue[];
  /// The 1-based sheet row the headers were found on, or 0 when they were not.
  headerRow: number;
};

export type ParseOptions = {
  /**
   * Normalised skill spelling → canonical `Skill.slug`, built from the
   * catalogue by the caller. Absent, every skill cell is slugified as written,
   * which is right for a test and wrong for a real import — the match
   * percentage is computed against catalogue slugs, so a sheet saying
   * "MS Excel" has to resolve to `excel` or it scores nobody.
   */
  skillSlugs?: Map<string, string>;
  /// Stands in for "today" when the sheet gives no posting date, and in tests.
  today?: Date;
};

// ---------------------------------------------------------------------------
// Header matching
// ---------------------------------------------------------------------------

/// Every spelling of a column seen in a real sheet, plus the obvious synonyms.
/// Matched against the header cell normalised to lowercase words.
const COLUMN_ALIASES: Record<string, string[]> = {
  sourceRef: ['ref', 'reference', 'source ref', 'job id', 'job code', 'id', 'sl no', 'code'],
  title: ['title', 'job title', 'role', 'position', 'designation', 'post'],
  company: ['company', 'employer', 'organisation', 'organization', 'firm', 'company name'],
  degreeLevel: ['degree level', 'degree', 'level', 'ug pg', 'ug/pg', 'programme', 'program', 'eligibility'],
  location: ['location', 'city', 'place', 'work location', 'base location'],
  applyUrl: ['apply url', 'apply link', 'application link', 'link', 'url', 'apply', 'careers link'],
  description: ['description', 'job description', 'jd', 'details', 'about the role', 'summary'],
  requiredSkills: ['skills', 'required skills', 'key skills', 'skill', 'skills required'],
  postedOn: ['posted on', 'posted', 'date posted', 'posting date', 'published', 'date'],
  closesOn: ['closes on', 'closing date', 'last date', 'deadline', 'apply by', 'closes', 'valid till'],
};

/// The columns without which a row is not a vacancy.
const REQUIRED_COLUMNS = ['title', 'company', 'degreeLevel'] as const;

type ColumnMap = Partial<Record<keyof typeof COLUMN_ALIASES, number>>;

/// Lowercase words, single-spaced — "Apply  URL " and "apply_url" become the
/// same header.
export function normaliseHeader(value: RawCell): string {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function text(value: RawCell): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

/**
 * exceljs does not always hand back a primitive: a cell can be rich text, a
 * hyperlink, a formula with a cached result, or an error. Flattening lives here
 * rather than beside the exceljs import so it can be tested without a workbook.
 */
export function flattenCell(value: unknown): RawCell {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'object') {
    const cell = value as Record<string, unknown>;
    if (Array.isArray(cell.richText)) {
      return (cell.richText as { text?: string }[]).map((run) => run.text ?? '').join('');
    }
    // A hyperlink cell carries both the label and the target; the target is the
    // useful half in an "Apply link" column.
    if (typeof cell.hyperlink === 'string') return cell.hyperlink;
    if (cell.result != null) return flattenCell(cell.result);
    if (typeof cell.text === 'string') return cell.text;
    if (cell.error != null) return null;
  }
  return null;
}

/// The first row that names at least a title and a company is the header. A
/// sheet with a title banner above the table is the normal case, not an error.
function findHeader(rows: RawRow[]): { index: number; columns: ColumnMap } | null {
  for (let index = 0; index < rows.length; index += 1) {
    const columns = mapColumns(rows[index] ?? []);
    if (columns.title != null && columns.company != null) return { index, columns };
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
// Value parsing
// ---------------------------------------------------------------------------

const UG_WORDS = ['ug', 'undergraduate', 'bachelor', 'bachelors', 'bba', 'bcom', 'bca', 'graduate'];
const PG_WORDS = ['pg', 'postgraduate', 'master', 'masters', 'mba', 'mca', 'msc', 'pgdm'];

/// Two-word spellings that contain a word belonging to the *other* list, so
/// they have to be settled before the word scan runs. "Post Graduate" reading
/// as UG because it contains "graduate" is not a hypothetical — it is what the
/// first version of this function did.
const PHRASES: [RegExp, DegreeLevel][] = [
  [/\bpost\s?graduate\b/, 'PG'],
  [/\bunder\s?graduate\b/, 'UG'],
];

export function parseDegreeLevel(value: RawCell): DegreeLevel | null {
  const normalised = normaliseHeader(value);
  if (!normalised) return null;

  for (const [pattern, level] of PHRASES) {
    if (pattern.test(normalised)) return level;
  }

  // Checked in this order so "UG/PG" — a row open to both — lands on UG, the
  // wider audience. A vacancy shown to a cohort that cannot take it wastes a
  // click; one hidden from a cohort that can costs them the vacancy.
  const words = normalised.split(' ').filter(Boolean);
  if (words.some((word) => UG_WORDS.includes(word))) return 'UG';
  if (words.some((word) => PG_WORDS.includes(word))) return 'PG';
  return null;
}

/// Excel stores a date as days since 1899-12-30. A cell the sender never
/// formatted as a date arrives here as that integer, and reading it as a year
/// is how a posting ends up dated 45,000 AD.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const EXCEL_SERIAL_MIN = 1;
const EXCEL_SERIAL_MAX = 2_958_465; // 9999-12-31

const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

/**
 * A date from a cell, or null when there is nothing there, or `false` when
 * there is something there that is not a date.
 *
 * Three outcomes rather than two because "blank" and "the word ASAP" need
 * different handling: one is a column the sender left empty, the other is a row
 * the operator has to be told about.
 */
export function parseSheetDate(value: RawCell): Date | null | false {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? false : value;

  if (typeof value === 'number') {
    if (value < EXCEL_SERIAL_MIN || value > EXCEL_SERIAL_MAX) return false;
    return new Date(EXCEL_EPOCH_MS + Math.round(value) * 86_400_000);
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // ISO first: unambiguous, and what a well-behaved export produces.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return utc(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // "14 Aug 2026" / "14-Aug-2026".
  const worded = /^(\d{1,2})[\s\-/]+([a-zA-Z]{3,})[\s\-/]+(\d{4})$/.exec(raw);
  if (worded) {
    const month = MONTHS.indexOf(worded[2].slice(0, 3).toLowerCase());
    if (month < 0) return false;
    return utc(Number(worded[3]), month + 1, Number(worded[1]));
  }

  // Day-first, which is what the sender types. `03/04/2026` is 3 April here,
  // not 4 March: the sheet is written in Bengaluru, and guessing the American
  // order would silently move a third of all dates by up to eleven months.
  const numeric = /^(\d{1,2})[\-/.](\d{1,2})[\-/.](\d{2,4})$/.exec(raw);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    const year = numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3]);
    if (month > 12 || day > 31 || month < 1 || day < 1) return false;
    return utc(year, month, day);
  }

  return false;
}

function utc(year: number, month: number, day: number): Date | false {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return false;
  // Rejects 31 February, which `Date.UTC` would roll forward into March.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  return date;
}

/// `https://…` untouched, a bare domain given a scheme, anything else refused.
/// A `javascript:` "link" reaching an anchor on the student board is the reason
/// this is a whitelist rather than a tidy-up.
export function parseApplyUrl(value: RawCell): string | null | false {
  const raw = text(value);
  if (!raw) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (!url.hostname.includes('.')) return false;
    return url.toString();
  } catch {
    return false;
  }
}

/// Splits on the separators a person actually types, then resolves each name
/// through the catalogue. Unresolved names are still kept — slugified — so a
/// posting for a skill the catalogue has not caught up with is not silently
/// stripped of its requirements; the caller reports them as a warning.
export function parseSkills(
  value: RawCell,
  skillSlugs?: Map<string, string>,
): { slugs: string[]; unresolved: string[] } {
  const parts = text(value)
    .split(/[,;|/\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const slugs: string[] = [];
  const unresolved: string[] = [];

  for (const part of parts) {
    const normalised = normaliseHeader(part);
    if (!normalised) continue;
    const resolved = skillSlugs?.get(normalised);
    if (resolved) {
      if (!slugs.includes(resolved)) slugs.push(resolved);
      continue;
    }
    const slug = normalised.replace(/ /g, '-');
    if (!slugs.includes(slug)) slugs.push(slug);
    if (!unresolved.includes(part)) unresolved.push(part);
  }

  return { slugs, unresolved };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The fallback identity for a sheet that does not number its rows.
 *
 * Company and title alone are not enough — a firm that runs two Business
 * Analyst drives in a term would have the second overwrite the first — so the
 * apply URL joins the key. Exported because the importer has to build the same
 * key from a `Job` row already in the database; two spellings of this function
 * would mean a re-import that duplicates everything.
 */
export function compositeKey(job: {
  company: string;
  title: string;
  applyUrl?: string | null;
}): string {
  return [
    normaliseHeader(job.company),
    normaliseHeader(job.title),
    normaliseHeader(job.applyUrl ?? ''),
  ].join('|');
}

export function jobKey(job: {
  sourceRef?: string | null;
  company: string;
  title: string;
  applyUrl?: string | null;
}): string {
  const ref = (job.sourceRef ?? '').trim();
  return ref ? `ref:${ref}` : `fp:${compositeKey(job)}`;
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

export function parseJobSheet(rows: RawRow[], options: ParseOptions = {}): ParsedSheet {
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  const today = options.today ?? new Date();

  const header = findHeader(rows);
  if (!header) {
    return {
      jobs: [],
      headerRow: 0,
      warnings,
      errors: [
        {
          row: 0,
          column: 'header',
          message:
            'No header row found. The sheet needs a row naming at least the job title and the company.',
        },
      ],
    };
  }

  const missing = REQUIRED_COLUMNS.filter((field) => header.columns[field] == null);
  if (missing.length > 0) {
    return {
      jobs: [],
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

  /// Last row wins on a repeated key: a sheet that corrects an earlier line
  /// further down is correcting it, not describing a second vacancy.
  const byKey = new Map<string, ParsedJob>();

  for (let index = header.index + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const rowNumber = index + 1;

    // A blank line between blocks is not an error worth reporting.
    if (row.every((cell) => text(cell) === '')) continue;

    const title = text(at(row, 'title'));
    const company = text(at(row, 'company'));
    if (!title || !company) {
      errors.push({
        row: rowNumber,
        column: !title ? 'title' : 'company',
        message: `Blank ${!title ? 'job title' : 'company'} — row skipped`,
      });
      continue;
    }

    const degreeLevel = parseDegreeLevel(at(row, 'degreeLevel'));
    if (!degreeLevel) {
      errors.push({
        row: rowNumber,
        column: 'degreeLevel',
        message: text(at(row, 'degreeLevel'))
          ? `Unrecognised degree level "${text(at(row, 'degreeLevel'))}" — row skipped`
          : 'Blank degree level — row skipped',
      });
      continue;
    }

    const postedOn = parseSheetDate(at(row, 'postedOn'));
    if (postedOn === false) {
      errors.push({
        row: rowNumber,
        column: 'postedOn',
        message: `Unparseable date "${text(at(row, 'postedOn'))}" — row skipped`,
      });
      continue;
    }

    const closesOn = parseSheetDate(at(row, 'closesOn'));
    if (closesOn === false) {
      errors.push({
        row: rowNumber,
        column: 'closesOn',
        message: `Unparseable date "${text(at(row, 'closesOn'))}" — row skipped`,
      });
      continue;
    }

    let applyUrl = parseApplyUrl(at(row, 'applyUrl'));
    if (applyUrl === false) {
      // Not fatal. A vacancy with no working link is still worth showing —
      // the board disables the apply button and says why — and dropping the
      // whole row would lose a real posting over a mistyped address.
      warnings.push({
        row: rowNumber,
        column: 'applyUrl',
        message: `"${text(at(row, 'applyUrl'))}" is not a usable web address — the posting is imported without an apply link`,
      });
      applyUrl = null;
    }

    const skills = parseSkills(at(row, 'requiredSkills'), options.skillSlugs);
    if (skills.unresolved.length > 0 && options.skillSlugs) {
      warnings.push({
        row: rowNumber,
        column: 'requiredSkills',
        message: `Not in the skill catalogue: ${skills.unresolved.join(', ')} — kept on the posting, but no student can match it`,
      });
    }

    const sourceRef = text(at(row, 'sourceRef')) || null;
    const job: ParsedJob = {
      key: jobKey({ sourceRef, company, title, applyUrl }),
      sourceRef,
      title,
      company,
      degreeLevel,
      location: text(at(row, 'location')) || null,
      applyUrl,
      description: text(at(row, 'description')),
      requiredSkills: skills.slugs,
      // A sheet that does not date its rows is dated by its import; the board
      // sorts on this, and a null would sink every such posting to the bottom.
      postedOn: postedOn ?? today,
      closesOn: closesOn,
      rowNumber,
    };

    const earlier = byKey.get(job.key);
    if (earlier) {
      warnings.push({
        row: rowNumber,
        column: 'sourceRef',
        message: `Same posting as row ${earlier.rowNumber} — this row replaces it`,
      });
    }
    byKey.set(job.key, job);
  }

  return { jobs: [...byKey.values()], errors, warnings, headerRow: header.index + 1 };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180 in reverse — `export/csv.ts` writes this shape, and a director who
 * exports the board, edits two cells and sends it back must get their edits
 * imported rather than a parse error.
 *
 * The BOM `csvDocument()` writes is stripped here for the same reason it is
 * written there: it exists for Excel, and leaving it on turns the first header
 * into `﻿Title`, which matches no column alias.
 */
export function parseDelimited(input: string, delimiter = ','): RawRow[] {
  const body = input.replace(/^﻿/, '');
  const rows: RawRow[] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];

    if (quoted) {
      if (char === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\r') {
      // Swallowed: the \n that follows ends the record.
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
