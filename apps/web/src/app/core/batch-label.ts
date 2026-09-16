/**
 * How a batch is written for a person, on the client — the twin of
 * `apps/api-py/app/batch_labels.py`, which carries the whole argument.
 *
 * The short of it: A BATCH IS A YEAR. "2026-28" is the whole of what a batch
 * is; the college, department, course and specialization it belongs to are the
 * spine it hangs off, which `cohorts` already carries as real foreign keys. So
 * the spine comes from the LINKS and the year comes from the BATCH, and they
 * are put together by this one function — never by an f-string in a template,
 * which is how five endpoints each grew their own copy of
 * `name · batch_label` and printed the course twice.
 *
 * Prefer the server's `display_label`, which `GET /api/register/hierarchy` and
 * the admin cohort endpoints now carry, and which is this same rule applied
 * once. This exists for the screens that hold a batch and its spine in memory
 * and have no row to read it from — Set up a college, which is composing
 * batches that do not exist yet.
 */

/** Between a course and its specialization: two rungs of one path. */
export const SPINE_JOIN = ' - ';
/** Between the spine and the batch — the console's own two-facts-one-line dot. */
export const LABEL_JOIN = ' · ';

/**
 * `"General MBA - Finance · 2026-28"` — the spine, then the batch.
 *
 * Each missing part is a real shape, not an error: no specialization (a
 * two-year MBA in Digital Marketing IS the qualification), no course (a batch
 * may hang at department level, because Course is optional), or a name the
 * office typed itself, which is printed verbatim because they are their words.
 */
export function composeBatchLabel(
  courseName: string | null | undefined,
  specializationName: string | null | undefined,
  name: string,
): string {
  const spine = [courseName, specializationName]
    .filter((part): part is string => !!part && part.trim().length > 0)
    .map((part) => part.trim())
    .join(SPINE_JOIN);
  const tail = (name ?? '').trim();
  if (!spine) return tail;
  if (!tail) return spine;
  return `${spine}${LABEL_JOIN}${tail}`;
}
