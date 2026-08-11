import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth';
import {
  EXPORT_TABLES,
  collectProgrammeData,
  exportFileStem,
  resolveRequestedScope,
  resolveTableKey,
  tableMeta,
} from '@/lib/export/collect';
import { csvDocument } from '@/lib/export/csv';

/**
 * GET /api/export/csv?table=students&cohortId=…&studentId=…
 *
 * One table, one file. CSV is the format someone opens to answer a single
 * question — "who is behind on attendance" — so making the caller pick a table
 * keeps the file small enough to actually work with. The whole picture is what
 * the .xlsx route is for.
 *
 * `studentId` narrows the same table to one person, which is what a mentor
 * wants when they need that student's sessions in a spreadsheet and nothing
 * else.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  await requireRole('DIRECTOR', 'ADMIN');

  const params = new URL(request.url).searchParams;

  const key = resolveTableKey(params.get('table'));
  if (!key) {
    return NextResponse.json(
      {
        error: 'Unknown table.',
        accepts: EXPORT_TABLES.map((table) => table.param),
      },
      { status: 400 },
    );
  }

  // A cohort or student id that does not exist is a caller error, not an empty
  // result — silently returning the whole programme would be worse than failing.
  const scope = await resolveRequestedScope({
    cohortId: params.get('cohortId'),
    studentId: params.get('studentId'),
  });
  if (!scope) {
    return NextResponse.json({ error: 'Unknown cohort or student.' }, { status: 400 });
  }

  const meta = tableMeta(key);
  const data = await collectProgrammeData({
    cohortId: scope.cohortId ?? undefined,
    studentId: scope.studentId ?? undefined,
  });
  const body = csvDocument(meta.columns, data[key]);

  // The filename is built from our own slug and today's date, so nothing a
  // caller supplied can reach the Content-Disposition header.
  const filename = `${exportFileStem(scope, meta.param)}.csv`;

  return new NextResponse(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
