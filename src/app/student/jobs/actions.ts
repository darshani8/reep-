'use server';

/**
 * The two things a student can change on the jobs board.
 *
 * Both are Server Actions rather than route handlers because both are ordinary
 * mutations with nothing to cancel — unlike resume generation, which runs a
 * model for a minute and moved to `fetch` for exactly that reason. And both
 * re-check the session: a Server Action is a public POST endpoint, and the fact
 * that the page rendered a checkbox for this student is not evidence that this
 * request came from them.
 *
 * `jobExists` is not defensive clutter. Without it a crafted call writes a
 * `JobApplication` against any string, and the board would then render a row
 * for a vacancy nobody ever posted.
 */

import { revalidatePath } from 'next/cache';

import { requireStudent } from '@/lib/auth';
import { jobExists, recordApplyIntent, setApplied } from '@/lib/jobs/board';

/// Ticking the box is the student's own word, so the answer they get back is
/// whether it was recorded — not whether anyone verified it.
export type TrackResult = { ok: true } | { ok: false; error: string };

/**
 * The student followed the employer's link.
 *
 * Called from the click handler on the apply anchor, which does *not* wait for
 * it — the new tab opens either way. A recorded intent that failed to save is
 * not worth blocking a student from applying over.
 */
export async function recordApplyIntentAction(jobId: string): Promise<TrackResult> {
  const { studentId } = await requireStudent();
  if (!jobId || !(await jobExists(jobId))) return { ok: false, error: 'No such posting.' };

  await recordApplyIntent(studentId, jobId);
  revalidatePath('/student/jobs');
  return { ok: true };
}

/// The self-attestation behind the "check if applied" column.
export async function setAppliedAction(jobId: string, applied: boolean): Promise<TrackResult> {
  const { studentId } = await requireStudent();
  if (!jobId || !(await jobExists(jobId))) return { ok: false, error: 'No such posting.' };

  await setApplied(studentId, jobId, applied);
  revalidatePath('/student/jobs');
  return { ok: true };
}
