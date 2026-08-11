import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth';
import {
  EXPORT_TABLES,
  collectProgrammeData,
  exportFileStem,
  resolveRequestedScope,
  rowCounts,
} from '@/lib/export/collect';

/**
 * GET /api/export/json?cohortId=…&studentId=…
 *
 * The same nine tables, pretty-printed, for whoever is writing the script that
 * loads this into a warehouse or a notebook. The `schema` block names each
 * table's fields in order, so a consumer can build a header row without having
 * to assume the first record has every key populated.
 *
 * This is not the same file as `/api/export/student/[id]`. That one is the
 * dossier — the shape the printable record renders, nested and readable. This
 * one is the flat tabular shape, narrowed to one student, for anything that
 * expects rows.
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
  const counts = rowCounts(data);

  const payload = {
    generatedAt: data.generatedAt,
    scope: data.scope,
    counts: { ...counts.byTable, total: counts.total },
    schema: Object.fromEntries(
      EXPORT_TABLES.map((table) => [
        table.key,
        table.columns.map((column) => column.key),
      ]),
    ),
    ...Object.fromEntries(EXPORT_TABLES.map((table) => [table.key, data[table.key]])),
  };

  const filename = `${exportFileStem(scope)}.json`;

  // Two-space indentation: this is a download a human will open in an editor,
  // not a payload on a hot path, so readability beats bytes.
  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
