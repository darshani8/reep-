'use server';

import { revalidatePath } from 'next/cache';

import { requireMentor } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { menteeWhere } from '@/lib/mentor-scope';

/**
 * Close an alert by hand.
 *
 * `runAlertScan` already auto-resolves a rule that stops firing; this covers the
 * other half — the mentor spoke to the student and the number will catch up
 * later. `resolvedBy` records who made that call, which is why it is a name and
 * not a boolean.
 */
export async function resolveAlertAction(formData: FormData) {
  const session = await requireMentor();
  const alertId = String(formData.get('alertId') ?? '');
  if (!alertId) return;

  // Scoped to this mentor's mentees, so an id lifted from another group is a
  // silent no-op rather than an authorisation hole. A director reaching this
  // screen has no mentor group and may close anything.
  await prisma.alert.updateMany({
    where: {
      id: alertId,
      resolvedAt: null,
      student: menteeWhere(session),
    },
    data: { resolvedAt: new Date(), resolvedBy: session.name },
  });

  revalidatePath('/mentor/alerts');
  revalidatePath('/mentor');
}
