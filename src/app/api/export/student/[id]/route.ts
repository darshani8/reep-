import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth';
import { buildStudentRecord, studentRecordJson } from '@/app/director/student/record';

export const dynamic = 'force-dynamic';

/**
 * The complete record of one student as JSON.
 *
 * Built from the same `buildStudentRecord` the printable document renders, so a
 * director can circulate the PDF and the data file together and be sure they
 * agree. Pretty-printed on purpose: this is read by people at least as often as
 * by scripts, and two-space indentation costs nothing next to the round trip of
 * asking someone to re-export it readable.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireRole('DIRECTOR', 'ADMIN');
  const { id } = await params;

  const record = await buildStudentRecord(id);
  if (!record) {
    return NextResponse.json({ error: 'No such student.' }, { status: 404 });
  }

  const filename = `reep-record-${record.student.usn}.json`;

  return new NextResponse(JSON.stringify(studentRecordJson(record), null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      // A record is a snapshot of right now; never let a proxy serve yesterday's.
      'Cache-Control': 'no-store',
    },
  });
}
