'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';

/**
 * Moving a student between mentors.
 *
 * `Student.mentorId` is the only thing that scopes a mentor's world — the
 * roster, the focus log, the alert queue and the upload review check all read
 * it. So these two functions are the whole of "reassignment": there is no
 * second table to keep in step, and nothing is copied. That also means they are
 * the only place a mentor's caseload can change, which is why the role is
 * re-checked here rather than trusted from the screen that rendered the form.
 */

export type AssignResult = {
  message?: string;
  error?: string;
  /// Rows actually written, so the client can report the truth rather than the
  /// number it asked for.
  movedCount?: number;
};

/// Ids arrive from a client selection, so they are validated as shapes only —
/// the real protection is that every write is an `updateMany` keyed by `id`,
/// which silently ignores anything that is not a student.
const StudentIds = z
  .array(z.string().min(1).max(64))
  .min(1, 'Select at least one student first.')
  .max(1000, 'That is more students than this programme has.');

const AssignSchema = z.object({
  studentIds: StudentIds,
  /// Null is a real choice here: it means "take this student off every mentor".
  mentorId: z.string().min(1).max(64).nullable(),
});

const BalanceSchema = z.object({
  studentIds: StudentIds,
  mentorIds: z
    .array(z.string().min(1).max(64))
    .min(1, 'Choose at least one mentor to split across.')
    .max(50),
});

/// Seeded mentor names already carry the honorific, so prefixing unconditionally
/// gives "Prof. Prof. Anita Desai". Same rule as the mentor home screen.
function displayName(mentor: { title: string; user: { name: string } }): string {
  const { title, user } = mentor;
  return (user.name.startsWith(title) ? user.name : `${title} ${user.name}`).trim();
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/// Refresh everything a mentorId is read on: this screen, the director rollups,
/// and every mentor surface whose scope just changed.
function revalidateAssignmentSurfaces() {
  revalidatePath('/director/mentors');
  revalidatePath('/director');
  revalidatePath('/mentor');
  revalidatePath('/mentor/alerts');
}

// ---------------------------------------------------------------------------

/**
 * Point every selected student at one mentor, or at nobody.
 */
export async function assignStudents(input: {
  studentIds: string[];
  mentorId: string | null;
}): Promise<AssignResult> {
  await requireRole('DIRECTOR', 'ADMIN');

  const parsed = AssignSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'That selection is not valid.' };
  }
  const { studentIds, mentorId } = parsed.data;

  // Resolve the mentor before writing, so a stale id fails loudly instead of
  // pointing 40 students at a row that no longer exists.
  const mentor = mentorId
    ? await prisma.mentor.findUnique({ where: { id: mentorId }, include: { user: true } })
    : null;

  if (mentorId && !mentor) {
    return { error: 'That mentor no longer exists. Reload the page and try again.' };
  }

  const unique = Array.from(new Set(studentIds));
  const { count } = await prisma.student.updateMany({
    where: { id: { in: unique } },
    data: { mentorId },
  });

  if (count === 0) {
    return { error: 'None of those students could be found. Reload the page and try again.' };
  }

  revalidateAssignmentSurfaces();

  return {
    movedCount: count,
    message: mentor
      ? `Moved ${count} ${plural(count, 'student', 'students')} to ${displayName(mentor)}.`
      : `Unassigned ${count} ${plural(count, 'student', 'students')} — they no longer appear on any mentor's roster.`,
  };
}

/**
 * Deal the selected students round-robin across the chosen mentors.
 *
 * The mapping is positional — student *i* goes to mentor *i % mentors* — so the
 * split the director was shown before pressing the button is the split that
 * happens. Nothing here is random, and nothing outside the selection moves.
 */
export async function balanceStudents(input: {
  studentIds: string[];
  mentorIds: string[];
}): Promise<AssignResult> {
  await requireRole('DIRECTOR', 'ADMIN');

  const parsed = BalanceSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'That split is not valid.' };
  }

  const studentIds = Array.from(new Set(parsed.data.studentIds));
  const mentorIds = Array.from(new Set(parsed.data.mentorIds));

  const mentors = await prisma.mentor.findMany({
    where: { id: { in: mentorIds } },
    include: { user: true },
  });
  if (mentors.length !== mentorIds.length) {
    return { error: 'One of those mentors no longer exists. Reload the page and try again.' };
  }

  // Keep the caller's mentor order — it is the order the preview counted in.
  const byId = new Map(mentors.map((m) => [m.id, m]));
  const ordered = mentorIds.map((id) => byId.get(id)!);

  const plan = new Map<string, string[]>(mentorIds.map((id) => [id, []]));
  studentIds.forEach((studentId, i) => {
    plan.get(mentorIds[i % mentorIds.length])!.push(studentId);
  });

  // One write per mentor rather than one per student: 3 statements instead of 46.
  const counts = await prisma.$transaction(
    ordered.map((mentor) =>
      prisma.student.updateMany({
        where: { id: { in: plan.get(mentor.id)! } },
        data: { mentorId: mentor.id },
      }),
    ),
  );

  const moved = counts.reduce((sum, r) => sum + r.count, 0);
  if (moved === 0) {
    return { error: 'None of those students could be found. Reload the page and try again.' };
  }

  revalidateAssignmentSurfaces();

  const split = ordered
    .map((mentor, i) => `${displayName(mentor)} ${counts[i].count}`)
    .join(', ');

  return {
    movedCount: moved,
    message: `Split ${moved} ${plural(moved, 'student', 'students')} across ${ordered.length} ${plural(ordered.length, 'mentor', 'mentors')} — ${split}.`,
  };
}
