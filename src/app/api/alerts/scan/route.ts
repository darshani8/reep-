import { revalidatePath } from 'next/cache';
import { NextResponse } from 'next/server';

import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { menteeWhere, mentorScope } from '@/lib/mentor-scope';
import { runAlertScan, type ScanResult } from '@/lib/rules';
import type { Role } from '@prisma/client';

/**
 * POST /api/alerts/scan — re-evaluate every rule for the caller's cohorts.
 *
 * The scan is idempotent by design (see `runAlertScan`): re-running it refreshes
 * the numbers on alerts that are still firing and auto-resolves the ones that
 * stopped, so a mentor can hit the button as often as they like.
 *
 * This is the manual trigger; the same function is what a nightly job would call.
 */

const SCAN_ROLES: Role[] = ['MENTOR', 'DIRECTOR', 'ADMIN'];

export async function POST() {
  // A guard that redirects would turn a fetch() into an opaque 3xx, so the
  // session is checked by hand here and answered with real status codes.
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }
  if (!SCAN_ROLES.includes(session.role)) {
    return NextResponse.json({ error: 'Not permitted to run alert scans.' }, { status: 403 });
  }

  // The scan writes: it opens, refreshes and resolves Alert rows for everybody
  // it touches. So the blast radius is decided by role. `session.mentorId ? … :
  // []` decided it by a field, and a MENTOR account with no `Mentor` row fell
  // into the empty-cohort branch below — which scanned, and wrote to, the whole
  // programme.
  const scope = mentorScope(session);
  if (scope.kind === 'none') {
    return NextResponse.json(
      { error: 'This account has no mentor group to scan.' },
      { status: 403 },
    );
  }

  const cohortIds =
    scope.kind === 'mentees'
      ? (
          await prisma.student.findMany({
            where: menteeWhere(session),
            select: { cohortId: true },
            distinct: ['cohortId'],
          })
        ).map((row) => row.cohortId)
      : [];

  const merged: ScanResult = {
    scanned: 0,
    opened: 0,
    reopened: 0,
    autoResolved: 0,
    alerts: [],
  };

  // Sequential rather than parallel: each cohort's pass writes to the same Alert
  // table, and three cohorts is not worth the contention.
  //
  // Branching on the scope rather than on `cohortIds.length === 0` closes the
  // second mouth of the same bug: a real mentor with no mentees yet produces no
  // cohort ids either, and used to fall through to the programme-wide scan.
  if (scope.kind === 'programme') {
    // A director or admin has no mentor group — scan the whole programme.
    absorb(merged, await runAlertScan());
  } else {
    for (const cohortId of cohortIds) {
      absorb(merged, await runAlertScan(cohortId));
    }
  }

  revalidatePath('/mentor/alerts');
  revalidatePath('/mentor');
  revalidatePath('/director');

  return NextResponse.json({
    ...merged,
    cohortIds,
    scope: scope.kind === 'programme' ? 'programme' : 'mentor-cohorts',
    scannedAt: new Date().toISOString(),
  });
}

function absorb(target: ScanResult, result: ScanResult) {
  target.scanned += result.scanned;
  target.opened += result.opened;
  target.reopened += result.reopened;
  target.autoResolved += result.autoResolved;
  target.alerts.push(...result.alerts);
}
