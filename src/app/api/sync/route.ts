import { revalidatePath } from 'next/cache';
import { NextResponse } from 'next/server';

import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { fetchAllProviderProgress, providerName } from '@/lib/providers';
import type { ProgressStatus } from '@prisma/client';

/**
 * Re-pull every certification's completion from the provider adapter and stamp
 * `lastSyncedAt`.
 *
 * Nightly this would be a cron job over the whole cohort; exposing it as a POST
 * lets a student pull their own numbers the moment they finish a Coursera
 * module instead of waiting for the batch. The stamp matters beyond audit — the
 * simulated adapter uses it as the boundary for hours it has not yet credited,
 * so syncing is what stops the same hours counting twice.
 */

export async function POST() {
  const session = await getSession();
  if (!session?.studentId) {
    return NextResponse.json(
      { ok: false, error: 'Sign in as a student to sync your progress.' },
      { status: 401 },
    );
  }
  const studentId = session.studentId;

  const [current, fetched] = await Promise.all([
    prisma.certificationProgress.findMany({
      where: { studentId },
      include: { cert: { select: { name: true, courseCode: true, requiredHours: true } } },
    }),
    fetchAllProviderProgress(studentId),
  ]);

  const byCode = new Map(fetched.map((row) => [row.certCode, row]));
  const syncedAt = new Date();

  const certificates = current.map((row) => {
    const incoming = byCode.get(row.certCode);
    const after = incoming?.progressPct ?? row.progressPct;
    return {
      certCode: row.certCode,
      name: row.cert.name,
      courseCode: row.cert.courseCode,
      requiredHours: row.cert.requiredHours,
      before: row.progressPct,
      after,
      deltaPct: round1(after - row.progressPct),
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      reported: incoming != null,
    };
  });

  await prisma.$transaction(
    certificates.map((row) =>
      prisma.certificationProgress.update({
        where: { studentId_certCode: { studentId, certCode: row.certCode } },
        data: {
          progressPct: row.after,
          hoursLogged: round1((row.requiredHours * row.after) / 100),
          status: nextStatus(row.status, row.after),
          startedAt: row.startedAt ?? (row.after > 0 ? syncedAt : null),
          completedAt: row.completedAt ?? (row.after >= 99.5 ? syncedAt : null),
          lastSyncedAt: syncedAt,
          // Provider-pulled by definition — this is no longer the student's word.
          selfReported: false,
        },
      }),
    ),
  );

  revalidatePath('/student/time-log');
  revalidatePath('/student/certifications');
  revalidatePath('/student');

  const changed = certificates.filter((c) => c.deltaPct > 0);

  return NextResponse.json({
    ok: true,
    provider: providerName(),
    syncedAt: syncedAt.toISOString(),
    total: certificates.length,
    changed: changed.length,
    pointsGained: round1(changed.reduce((sum, c) => sum + c.deltaPct, 0)),
    certificates: certificates.map((c) => ({
      certCode: c.certCode,
      name: c.name,
      courseCode: c.courseCode,
      before: c.before,
      after: c.after,
      deltaPct: c.deltaPct,
    })),
  });
}

/// A sync reports completion, not deadlines — so an OVERDUE row that is still
/// unfinished stays overdue rather than being quietly downgraded.
function nextStatus(previous: ProgressStatus, pct: number): ProgressStatus {
  if (pct >= 99.5) return 'COMPLETED';
  if (previous === 'OVERDUE') return 'OVERDUE';
  return pct > 0 ? 'IN_PROGRESS' : 'NOT_STARTED';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
