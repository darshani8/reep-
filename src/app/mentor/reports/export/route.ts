import { NextResponse } from 'next/server';

import { getSession } from '@/lib/auth';
import { getMentorCohortForSession } from '@/lib/queries';
import { PACE_LABEL, STAGE_LABEL } from '@/lib/reep';
import type { Role, Stage } from '@prisma/client';

/**
 * GET /mentor/reports/export — the roster as CSV.
 *
 * Same rows and same derived numbers as the printable report, so a coordinator
 * who pivots this in a spreadsheet cannot end up disagreeing with the PDF.
 */

const EXPORT_ROLES: Role[] = ['MENTOR', 'DIRECTOR', 'ADMIN'];

const COLUMNS = [
  'USN',
  'Name',
  'Stage',
  'Semester',
  'Overall %',
  'Attendance %',
  'Cert pace',
  'Cert actual %',
  'Cert expected %',
  'Cert deviation %',
  'Last active',
  'Open alerts',
  'Flag',
] as const;

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }
  if (!EXPORT_ROLES.includes(session.role)) {
    return NextResponse.json({ error: 'Not permitted to export this roster.' }, { status: 403 });
  }
  const scoped = await getMentorCohortForSession(session);

  // Three answers, and the old `if (!session.mentorId)` could only give two. It
  // pointed the safe way — a mentor with no `Mentor` row was sent to the
  // director analytics along with the actual directors — but they are not the
  // same case: a director has programme-wide scope and merely no group of their
  // own (400, below), while that mentor account may not read a roster at all
  // (403, here, where a 404 "Mentor not found" used to be).
  if (scoped.kind === 'denied') {
    return NextResponse.json(
      { error: 'No student roster is in scope for this account.' },
      { status: 403 },
    );
  }
  if (scoped.kind === 'no-group') {
    return NextResponse.json(
      { error: 'This export is scoped to a mentor group; use the director analytics instead.' },
      { status: 400 },
    );
  }

  const data = scoped.cohort;

  const rows = data.roster.map((r) => [
    r.usn,
    r.name,
    STAGE_LABEL[r.stage as Stage],
    r.semester,
    r.overallPct.toFixed(1),
    r.attendancePct.toFixed(1),
    PACE_LABEL[r.certPace.status],
    r.certPace.actualPct.toFixed(1),
    r.certPace.expectedPct.toFixed(1),
    r.certPace.deviationPct.toFixed(1),
    r.lastActiveAt ? r.lastActiveAt.toISOString().slice(0, 10) : 'Never',
    r.openAlerts,
    r.atRisk ? 'At risk' : r.behind ? 'Behind pace' : 'On track',
  ]);

  const csv = [COLUMNS, ...rows].map((row) => row.map(escapeCell).join(',')).join('\r\n');
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `reep-roster-${slug(data.mentor.mentorGroup)}-${stamp}.csv`;

  // The BOM is what makes Excel on Windows read this as UTF-8 rather than as
  // the system codepage, which otherwise mangles the student names.
  return new NextResponse(`﻿${csv}`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}

function escapeCell(value: string | number): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cohort';
}
