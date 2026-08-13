import { NextResponse } from 'next/server';

import { retryAfterSeconds } from '@/lib/rate-limit';
import { UploadRejectedError, formatBytes } from '@/lib/uploads';
import { clientKey, registrationUploadLimiter } from '@/lib/registration/limits';
import {
  createBundle,
  isQuarantineToken,
  readBundle,
  saveQuarantineFile,
} from '@/lib/registration/quarantine';

/**
 * The professional photo, into the same quarantine as the CV.
 *
 * A separate route from the CV rather than one endpoint with a `kind` field,
 * because the two do genuinely different work after the file is written: a CV is
 * parsed and mapped back into the form, a photo is stored and looked at. Sharing
 * a handler would mean a branch at the top and two unrelated response shapes at
 * the bottom.
 *
 * What it does *not* do is return a URL. The bytes are readable only through
 * `/api/register/file/[token]/[name]`, which requires a DIRECTOR or ADMIN
 * session — so the applicant uploads a photo and is shown its name and size, not
 * a preview. The alternative is a public read endpoint keyed on a token that
 * appears in the applicant's own page source, which is an open image host.
 *
 * On approval `provision.ts` promotes this to a VERIFIED `Upload` and points
 * `StudentProfile.photoUploadId` at it — the canonical photo pointer, the same
 * one the ordinary upload path writes.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const now = new Date();

  const verdict = registrationUploadLimiter.check(clientKey(request.headers, 'reg-upload'), now.getTime());
  if (!verdict.allowed) {
    const seconds = retryAfterSeconds(verdict, now.getTime());
    return NextResponse.json(
      { error: `That is a lot of uploads from one place. Try again in ${seconds > 60 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`}.` },
      { status: 429, headers: { 'Retry-After': String(seconds) } },
    );
  }

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file was attached.' }, { status: 400 });
  }

  const candidate = String(form.get('token') ?? '').trim();
  const token =
    candidate && isQuarantineToken(candidate) && (await readBundle(candidate))
      ? candidate
      : (await createBundle(now)).token;

  try {
    const { saved } = await saveQuarantineFile(token, 'photo', file, now);
    return NextResponse.json({
      token,
      fileName: saved.originalName,
      sizeLabel: formatBytes(saved.sizeBytes),
    });
  } catch (error) {
    if (error instanceof UploadRejectedError) {
      return NextResponse.json({ error: error.reason }, { status: 400 });
    }
    throw error;
  }
}
