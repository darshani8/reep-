'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';

export type CriteriaState = { error?: string; message?: string };

/// Thresholds arrive as form strings; reject blanks explicitly rather than
/// letting an empty field coerce to a silent 0% requirement.
const threshold = z
  .string()
  .trim()
  .min(1, 'Every threshold needs a value.')
  .transform(Number)
  .refine(
    (n) => Number.isFinite(n) && n >= 0 && n <= 100,
    'Thresholds must be a number between 0 and 100.',
  );

const Schema = z.object({
  minReepCompletionPct: threshold,
  minCertCompletionPct: threshold,
  minAttendancePct: threshold,
});

export async function updatePlacementCriteria(
  _prev: CriteriaState,
  formData: FormData,
): Promise<CriteriaState> {
  // A Server Action is a public POST endpoint, so it re-checks the role rather
  // than trusting that the page rendered the form.
  await requireRole('DIRECTOR', 'ADMIN');

  const parsed = Schema.safeParse({
    minReepCompletionPct: String(formData.get('minReepCompletionPct') ?? ''),
    minCertCompletionPct: String(formData.get('minCertCompletionPct') ?? ''),
    minAttendancePct: String(formData.get('minAttendancePct') ?? ''),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Those thresholds are not valid.' };
  }

  const data = {
    ...parsed.data,
    // An unchecked box is simply absent from the payload.
    requireCoreCerts: formData.get('requireCoreCerts') === 'on',
  };

  // Edit whichever row is currently active; the id never reaches the client, so
  // a crafted POST cannot retarget an archived criteria set.
  const active = await prisma.placementCriteria.findFirst({ where: { active: true } });
  if (active) {
    await prisma.placementCriteria.update({ where: { id: active.id }, data });
  } else {
    await prisma.placementCriteria.create({
      data: { name: 'Placement eligibility', active: true, ...data },
    });
  }

  // Readiness is recomputed on read, so refreshing both screens is the whole
  // migration — no stored flag to backfill.
  revalidatePath('/director/placement');
  revalidatePath('/director');

  return { message: 'Criteria saved. Every student below was re-evaluated against them.' };
}
