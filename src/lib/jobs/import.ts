import 'server-only';

/**
 * The weekly sheet, written into the board.
 *
 * `parse.ts` decides what the cells mean; this decides what the database does
 * about it, and the split is what makes the dry run trustworthy. Preview and
 * commit are the *same* function with one flag: the operator is shown the plan
 * produced by the code that will carry it out, not a second implementation of
 * it that might disagree. A preview that lies is worse than no preview.
 *
 * Idempotence is the other half. `Job.sourceRef` is unique, so a sheet that
 * numbers its rows re-imports onto the rows it wrote last week. A sheet that
 * does not is keyed on company + title + apply URL, built by `compositeKey()`
 * from both sides — the parsed row and the stored one — so the two spellings
 * cannot drift. Re-sending Tuesday's sheet on Wednesday must move nothing.
 *
 * `JobImportRun` is written even when rows failed, and especially then. "The
 * board is stale" and "the board is stale because Tuesday's sheet had a broken
 * date column" are different problems, and only the run row tells them apart.
 */

import { Workbook } from 'exceljs';
import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';

import {
  compositeKey,
  flattenCell,
  parseDelimited,
  parseJobSheet,
  type ParsedJob,
  type RawRow,
  type RowIssue,
} from './parse';

/// Bigger than any weekly sheet has ever been, small enough that a mis-picked
/// file is refused before it is parsed.
export const MAX_SHEET_BYTES = 5 * 1024 * 1024;

/// What the importer will read. `.xls` is deliberately absent: exceljs cannot
/// open the old binary format, and failing on the extension with a sentence
/// about re-saving is far kinder than failing inside the parser.
export const ACCEPTED_EXTENSIONS = ['.xlsx', '.csv'] as const;

/// What this run would do, or did, to one posting.
export type JobDisposition = 'create' | 'update' | 'unchanged';

export type PlannedJob = {
  job: ParsedJob;
  disposition: JobDisposition;
  /// The row this will overwrite, when there is one.
  existingId: string | null;
  /// Field names that differ from the stored row — the preview's "what changes"
  /// column, and the reason `unchanged` can be reported at all.
  changes: string[];
};

export type JobImportReport = {
  fileName: string;
  /// 1-based row the headers were found on; 0 when they were not found.
  headerRow: number;
  /// Data rows the sheet offered — the ones that became jobs plus the ones that
  /// were rejected.
  rowsSeen: number;
  planned: PlannedJob[];
  errors: RowIssue[];
  warnings: RowIssue[];
  counts: Record<JobDisposition, number>;
  /// Null for a dry run. Set once the rows are actually in.
  committed: { runId: string; created: number; updated: number } | null;
};

export class JobSheetError extends Error {}

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

/// A grid of cells from either format. Nothing here knows what a column means.
export async function readJobSheet(bytes: ArrayBuffer, fileName: string): Promise<RawRow[]> {
  const name = fileName.toLowerCase();

  if (name.endsWith('.csv')) {
    return parseDelimited(new TextDecoder('utf-8').decode(bytes));
  }

  if (!name.endsWith('.xlsx')) {
    throw new JobSheetError(
      `${fileName} is not a sheet this importer can read. Save it as .xlsx or .csv and try again.`,
    );
  }

  const workbook = new Workbook();
  try {
    await workbook.xlsx.load(bytes);
  } catch {
    throw new JobSheetError(
      'That file could not be opened as a spreadsheet. If it came from an old version of Excel, re-save it as .xlsx.',
    );
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new JobSheetError('The workbook has no sheets in it.');

  const rows: RawRow[] = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    // exceljs indexes cells from 1 and puts a hole at 0.
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    rows[rowNumber - 1] = values.map((value) => flattenCell(value));
  });

  // `eachRow` skips nothing with includeEmpty, but a sparse array would still
  // hand `undefined` to the parser if the sheet ends oddly.
  for (let i = 0; i < rows.length; i += 1) rows[i] ??= [];

  return rows;
}

/**
 * Every spelling of every catalogue skill, normalised the way the parser
 * normalises a cell.
 *
 * Without this a sheet saying "MS Excel" stores `ms-excel`, which matches no
 * student's `excel` and scores the whole cohort 0% — the failure mode the seed
 * comment warns about, arriving through the importer instead of the catalogue.
 */
export async function skillLookup(): Promise<Map<string, string>> {
  const skills = await prisma.skill.findMany({
    select: { slug: true, name: true, aliases: true },
  });

  const lookup = new Map<string, string>();
  const add = (spelling: string, slug: string) => {
    const key = spelling.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (key && !lookup.has(key)) lookup.set(key, slug);
  };

  for (const skill of skills) {
    add(skill.slug, skill.slug);
    add(skill.name, skill.slug);
    for (const alias of skill.aliases) add(alias, skill.slug);
  }
  return lookup;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/// The columns a re-import is allowed to overwrite, and therefore the ones the
/// preview compares. `postedOn` is in the list: a sheet that re-dates a posting
/// is correcting it.
const COMPARED = [
  'title',
  'company',
  'degreeLevel',
  'location',
  'applyUrl',
  'description',
  'requiredSkills',
  'postedOn',
  'closesOn',
] as const;

type StoredJob = {
  id: string;
  sourceRef: string | null;
  title: string;
  company: string;
  degreeLevel: string;
  location: string | null;
  applyUrl: string | null;
  description: string;
  requiredSkills: string[];
  postedOn: Date;
  closesOn: Date | null;
};

function changedFields(job: ParsedJob, stored: StoredJob): string[] {
  const changes: string[] = [];
  for (const field of COMPARED) {
    if (field === 'requiredSkills') {
      const before = [...stored.requiredSkills].sort().join(',');
      const after = [...job.requiredSkills].sort().join(',');
      if (before !== after) changes.push(field);
      continue;
    }
    if (field === 'postedOn' || field === 'closesOn') {
      if ((stored[field]?.getTime() ?? null) !== (job[field]?.getTime() ?? null)) {
        changes.push(field);
      }
      continue;
    }
    if ((stored[field] ?? null) !== (job[field] ?? null)) changes.push(field);
  }
  return changes;
}

async function planAgainstDatabase(jobs: ParsedJob[]): Promise<PlannedJob[]> {
  const refs = jobs.map((job) => job.sourceRef).filter((ref): ref is string => Boolean(ref));
  const companies = jobs.filter((job) => !job.sourceRef).map((job) => job.company);

  const stored: StoredJob[] =
    refs.length === 0 && companies.length === 0
      ? []
      : await prisma.job.findMany({
          where: {
            OR: [
              ...(refs.length > 0 ? [{ sourceRef: { in: refs } }] : []),
              // Fetched by company alone and narrowed on the composite key
              // below, because the key includes a normalisation Postgres has no
              // index for. A weekly sheet names a handful of firms.
              ...(companies.length > 0
                ? [{ company: { in: companies, mode: 'insensitive' as const } }]
                : []),
            ],
          },
          select: {
            id: true,
            sourceRef: true,
            title: true,
            company: true,
            degreeLevel: true,
            location: true,
            applyUrl: true,
            description: true,
            requiredSkills: true,
            postedOn: true,
            closesOn: true,
          },
        });

  const byRef = new Map(stored.filter((row) => row.sourceRef).map((row) => [row.sourceRef!, row]));
  const byComposite = new Map(stored.map((row) => [compositeKey(row), row]));

  return jobs.map((job) => {
    const existing = job.sourceRef ? byRef.get(job.sourceRef) : byComposite.get(compositeKey(job));
    if (!existing) return { job, disposition: 'create' as const, existingId: null, changes: [] };
    const changes = changedFields(job, existing);
    return {
      job,
      disposition: changes.length > 0 ? ('update' as const) : ('unchanged' as const),
      existingId: existing.id,
      changes,
    };
  });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export type ImportInput = {
  bytes: ArrayBuffer;
  fileName: string;
  /// The staff member running it. Recorded on the run, never on the job.
  uploadedById: string;
  /// False produces the plan and writes nothing.
  commit: boolean;
};

export async function importJobSheet(input: ImportInput): Promise<JobImportReport> {
  if (input.bytes.byteLength === 0) throw new JobSheetError('That file is empty.');
  if (input.bytes.byteLength > MAX_SHEET_BYTES) {
    throw new JobSheetError('That file is larger than 5 MB — it is probably not a jobs sheet.');
  }

  const rows = await readJobSheet(input.bytes, input.fileName);
  const parsed = parseJobSheet(rows, { skillSlugs: await skillLookup() });
  const planned = await planAgainstDatabase(parsed.jobs);

  const counts: Record<JobDisposition, number> = { create: 0, update: 0, unchanged: 0 };
  for (const entry of planned) counts[entry.disposition] += 1;

  const report: JobImportReport = {
    fileName: input.fileName,
    headerRow: parsed.headerRow,
    rowsSeen: parsed.jobs.length + parsed.errors.length,
    planned,
    errors: parsed.errors,
    warnings: parsed.warnings,
    counts,
    committed: null,
  };

  if (!input.commit) return report;

  // Nothing to write is not an error, but it must not leave a run row claiming
  // a successful import of a sheet the parser could make no sense of.
  if (planned.length === 0 && parsed.errors.length === 0) {
    throw new JobSheetError('That sheet has no job rows in it.');
  }

  const run = await prisma.$transaction(
    async (tx) => {
      const created = await tx.jobImportRun.create({
        data: {
          fileName: input.fileName,
          uploadedById: input.uploadedById,
          rowsSeen: report.rowsSeen,
          errors: [...parsed.errors, ...parsed.warnings] as unknown as Prisma.InputJsonValue,
        },
      });

      for (const entry of planned) {
        const data = {
          sourceRef: entry.job.sourceRef,
          title: entry.job.title,
          company: entry.job.company,
          degreeLevel: entry.job.degreeLevel,
          location: entry.job.location,
          applyUrl: entry.job.applyUrl,
          description: entry.job.description,
          requiredSkills: entry.job.requiredSkills,
          postedOn: entry.job.postedOn,
          closesOn: entry.job.closesOn,
          importRunId: created.id,
        };

        if (entry.disposition === 'create') {
          await tx.job.create({ data });
        } else if (entry.disposition === 'update') {
          await tx.job.update({ where: { id: entry.existingId! }, data });
        }
        // `unchanged` is left alone on purpose, importRunId included: this run
        // did not write that row, and saying it did would make the provenance
        // trail useless for finding which sheet introduced a mistake.
      }

      return tx.jobImportRun.update({
        where: { id: created.id },
        data: {
          finishedAt: new Date(),
          rowsCreated: counts.create,
          rowsUpdated: counts.update,
        },
      });
    },
    { timeout: 30_000 },
  );

  return {
    ...report,
    committed: { runId: run.id, created: counts.create, updated: counts.update },
  };
}

/// The last few runs, for the audit strip on the director screen.
export async function recentImportRuns(take = 5) {
  return prisma.jobImportRun.findMany({
    orderBy: { startedAt: 'desc' },
    take,
    select: {
      id: true,
      fileName: true,
      startedAt: true,
      finishedAt: true,
      rowsSeen: true,
      rowsCreated: true,
      rowsUpdated: true,
      errors: true,
    },
  });
}
