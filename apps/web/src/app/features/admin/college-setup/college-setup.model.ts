/**
 * The pure half of "Set up a college": what a batch is called, when it runs,
 * and which mock interview its students will meet — derived from the codes
 * and names the office types, with no I/O, so a test can pin every rule.
 *
 * THE CONVENTIONS ARE THE SEEDER'S, on purpose. `apps/api-py/app/seed_catalogue.py`
 * writes the same spine from code, and a batch created from this screen must
 * be indistinguishable from one it wrote: the same code shape
 * (COLLEGE-DEPT-COURSE[-SPEC]-LABEL, upper-cased, globally unique), the same
 * name ("Course - Specialization 2026-28"), the same academic year (July to
 * the last day of June) and the same track match (an exact, case-folded
 * comparison of the leaf's code against the enabled tracks — the rule
 * `_default_track` applies when a student opens the interviewer).
 */

/** The month an academic year begins. `ACADEMIC_YEAR_START_MONTH` in
 *  app/seed_catalogue.py; July, 1-based. */
export const ACADEMIC_YEAR_START_MONTH = 7;

export type DegreeLevel = 'UG' | 'PG';

/** "2026-28" for a two-year programme starting in 2026. */
export function batchLabel(startYear: number, years: number): string {
  const end = startYear + years;
  return `${startYear}-${String(end).slice(-2)}`;
}

/**
 * The dates a label implies: entry on 1 July of the first year, completion on
 * the day before the academic year would next begin (30 June of the last).
 * A label that is not `<start>-<end>` spanning one to ten years yields null —
 * refused rather than guessed, exactly as the seeder refuses it.
 */
export function batchDates(label: string): { entry: string; completion: string } | null {
  const m = /^(\d{4})-(\d{2}|\d{4})$/.exec(label.trim());
  if (!m) return null;
  const start = Number(m[1]);
  let end = Number(m[2]);
  if (end < 100) end += start - (start % 100);
  if (!(start < end && end <= start + 10)) return null;
  const month = String(ACADEMIC_YEAR_START_MONTH).padStart(2, '0');
  // Day 0 of the start month is the last day of the month before it.
  const lastDay = new Date(Date.UTC(end, ACADEMIC_YEAR_START_MONTH - 1, 0));
  return { entry: `${start}-${month}-01`, completion: lastDay.toISOString().slice(0, 10) };
}

/** `cohorts.code` carries the whole path, upper-cased, so it is unique. */
export function batchCode(parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter((p): p is string => !!p && p.trim().length > 0)
    .map((p) => p.trim().toUpperCase())
    .join('-');
}

/** What the office reads on the Batches screen: the department is not
 *  prefixed, because it is already on the row. */
export function batchName(courseName: string, specName: string | null, label: string): string {
  const tail = specName ? ` - ${specName.trim()}` : '';
  return `${courseName.trim()}${tail} ${label.trim()}`;
}

/** "bgscet.ac.in, sjbit.ac.in" → ["bgscet.ac.in", "sjbit.ac.in"]. */
export function parseDomains(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,;]+/)) {
    const domain = raw.trim().toLowerCase().replace(/^@/, '');
    if (domain) seen.add(domain);
  }
  return [...seen];
}

export interface TrackLike {
  code: string;
  label: string;
  enabled: boolean;
}

/** The interview track a leaf's own code selects, or null for the general
 *  interview. The comparison is the server's: exact, case-folded, enabled. */
export function trackFor(code: string, tracks: readonly TrackLike[]): string | null {
  const wanted = code.trim().toLowerCase();
  if (!wanted) return null;
  const hit = tracks.find((t) => t.enabled && t.code.trim().toLowerCase() === wanted);
  return hit ? hit.label : null;
}
