import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';

import { getSession } from '@/lib/auth';
import {
  ACCEPTED_EXTENSIONS,
  JobSheetError,
  MAX_SHEET_BYTES,
  importJobSheet,
  type JobImportReport,
} from '@/lib/jobs/import';
import { toImportPreview } from '@/lib/jobs/preview';

export const dynamic = 'force-dynamic';

/**
 * The weekly sheet, previewed and then committed.
 *
 * **The file is uploaded twice on purpose.** The dry run could have returned a
 * parsed plan for the browser to post back on commit, and that would have been
 * one upload — but then the rows written would be rows the client handed back,
 * and a director's browser is not a trustworthy source for what a spreadsheet
 * said. Re-parsing the same file on commit costs a second upload of something
 * under 5 MB, and buys a guarantee that the preview and the write read the same
 * bytes through the same code.
 */
export async function POST(request: Request) {
  const session = await getSession();
  // A route handler answers a fetch, so this checks the role itself rather than
  // calling requireRole() and redirecting a JSON caller to a login page.
  if (!session || (session.role !== 'DIRECTOR' && session.role !== 'ADMIN')) {
    return NextResponse.json(
      { error: 'Only the programme office can import the jobs sheet.' },
      { status: session ? 403 : 401 },
    );
  }

  const form = await request.formData();
  const file = form.get('file');
  const commit = String(form.get('mode') ?? 'preview') === 'commit';

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file was attached.' }, { status: 400 });
  }
  if (file.size > MAX_SHEET_BYTES) {
    return NextResponse.json(
      { error: 'That file is larger than 5 MB — it is probably not a jobs sheet.' },
      { status: 400 },
    );
  }
  if (!ACCEPTED_EXTENSIONS.some((extension) => file.name.toLowerCase().endsWith(extension))) {
    return NextResponse.json(
      { error: `Upload a ${ACCEPTED_EXTENSIONS.join(' or ')} file.` },
      { status: 400 },
    );
  }

  let report: JobImportReport;
  try {
    report = await importJobSheet({
      bytes: await file.arrayBuffer(),
      fileName: file.name,
      uploadedById: session.userId,
      commit,
    });
  } catch (error) {
    // A sheet the importer cannot read is the operator's problem to fix, not a
    // server fault — it gets the sentence, not a 500.
    if (error instanceof JobSheetError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  if (report.committed) {
    revalidatePath('/director/jobs');
    revalidatePath('/student/jobs');
  }

  return NextResponse.json(toImportPreview(report), {
    status: report.committed ? 201 : 200,
  });
}
