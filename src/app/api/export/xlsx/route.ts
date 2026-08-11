import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth';
import {
  collectProgrammeData,
  exportFileStem,
  resolveRequestedScope,
} from '@/lib/export/collect';
import { XLSX_CONTENT_TYPE, buildWorkbook } from '@/lib/export/workbook';

/**
 * GET /api/export/xlsx?cohortId=…&studentId=…
 *
 * Every table as one workbook, one sheet each. This is the file the programme
 * office actually wants: they will pivot it, colour it and mail it, and they
 * should never have to stitch nine CSVs together first.
 *
 * With `studentId` it is the same workbook narrowed to one person — the same
 * sheets, the same columns, everybody else's rows gone — so a student's record
 * and their cohort's are the same document at two scopes rather than two
 * documents that have to be kept in step.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  await requireRole('DIRECTOR', 'ADMIN');

  const params = new URL(request.url).searchParams;

  const scope = await resolveRequestedScope({
    cohortId: params.get('cohortId'),
    studentId: params.get('studentId'),
  });
  if (!scope) {
    return NextResponse.json({ error: 'Unknown cohort or student.' }, { status: 400 });
  }

  const data = await collectProgrammeData({
    cohortId: scope.cohortId ?? undefined,
    studentId: scope.studentId ?? undefined,
  });
  const workbook = await buildWorkbook(data);
  const filename = `${exportFileStem(scope)}.xlsx`;

  return new NextResponse(workbook, {
    headers: {
      'content-type': XLSX_CONTENT_TYPE,
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': String(workbook.byteLength),
      'cache-control': 'no-store',
    },
  });
}
