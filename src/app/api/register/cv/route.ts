import { NextResponse } from 'next/server';

import { UploadRejectedError } from '@/lib/uploads';
import { assistCvExtraction } from '@/lib/registration/cv-llm';
import { mapCvText } from '@/lib/registration/cv-map';
import { extractCvText } from '@/lib/registration/cv-text';
import { clientKey, registrationUploadLimiter } from '@/lib/registration/limits';
import {
  createBundle,
  isQuarantineToken,
  readBundle,
  recordCvExtraction,
  saveQuarantineFile,
  sweepQuarantine,
} from '@/lib/registration/quarantine';
import { REGISTRATION_FIELD_LABEL } from '@/lib/registration/schema';
import { retryAfterSeconds } from '@/lib/rate-limit';

/**
 * "Upload your CV and the system will auto-fill."
 *
 * The one endpoint in this product that an unauthenticated stranger may POST a
 * 10 MB file to, which is why almost all of it is refusals:
 *
 *  - **Rate limited by IP before the body is touched.** Reading the multipart
 *    body is itself the expensive part, so the ceiling is checked first.
 *  - **The bytes decide the type.** `saveQuarantineFile` runs the same
 *    `validateUpload` + sniff the signed-in upload path runs; a `.pdf` that is
 *    really an SVG never reaches disk.
 *  - **The token is ours.** A caller may pass one back to add a photo to the
 *    same application, and it is checked for shape and for existence — an
 *    unrecognised token gets a *new* bundle rather than creating a directory of
 *    the caller's choosing.
 *  - **Nothing is stored in the database.** No `Registration` row exists yet.
 *    The file sits in quarantine and is promoted only if a reviewer approves.
 *
 * The response is the auto-fill: proposed values, the education and skills the
 * mapper found, and — the part that matters — the list of fields it could *not*
 * fill. An auto-filler that silently leaves boxes empty teaches applicants to
 * submit half a form.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const now = new Date();

  const verdict = registrationUploadLimiter.check(clientKey(request.headers, 'reg-upload'), now.getTime());
  if (!verdict.allowed) {
    const seconds = retryAfterSeconds(verdict, now.getTime());
    return NextResponse.json(
      { error: `That is a lot of uploads from one place. Try again in ${seconds > 60 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`}.` },
      { status: 429, headers: rateHeaders(verdict.limit, verdict.remaining, verdict.resetAt, seconds) },
    );
  }

  // Amortised, the way `rate-limit.ts` evicts: no cron job, no timer holding the
  // process open. An instance that takes registrations sweeps; one that does not
  // has nothing to sweep.
  void sweepQuarantine(now).catch(() => {});

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file was attached.' }, { status: 400 });
  }

  const token = await resolveToken(form.get('token'), now);

  let saved;
  try {
    saved = await saveQuarantineFile(token, 'cv', file, now);
  } catch (error) {
    if (error instanceof UploadRejectedError) {
      return NextResponse.json({ error: error.reason }, { status: 400 });
    }
    throw error;
  }

  const extracted = await extractCvText(saved.bytes, saved.saved.mimeType);
  if (!extracted.ok) {
    // The file is kept — a reviewer can still open it even though we could not
    // read it — and the applicant is told to type the form themselves. This is a
    // 200: the upload worked, the reading did not.
    return NextResponse.json({
      token,
      fileName: saved.saved.originalName,
      fields: {},
      education: [],
      skills: [],
      missing: Object.keys(REGISTRATION_FIELD_LABEL),
      note: extracted.reason,
      autofilled: false,
    });
  }

  const deterministic = mapCvText(extracted.text);

  // The optional second pass, and the gate in front of it. When
  // `studentDataEgressAllowed()` refuses — the default — this returns no fields
  // and a sentence saying the document never left the machine.
  const assist = await assistCvExtraction(extracted.text, deterministic, request.signal);

  const fields = { ...deterministic.fields, ...assist.fields };
  const missing = deterministic.missing.filter((field) => fields[field] === undefined);

  await recordCvExtraction(token, extracted.text, { ...deterministic, fields, missing }, now);

  return NextResponse.json({
    token,
    fileName: saved.saved.originalName,
    fields,
    education: deterministic.education,
    skills: deterministic.skills,
    missing,
    missingLabels: missing.map((field) => REGISTRATION_FIELD_LABEL[field]),
    note: assist.note,
    autofilled: Object.keys(fields).length > 0,
  });
}

/**
 * The bundle this upload belongs to.
 *
 * A token the caller sends back is honoured only if it is both well-formed and
 * already on disk. Anything else — absent, malformed, or naming a bundle that
 * has been swept — starts a fresh one. Trusting a caller-supplied token to name
 * a *new* directory would let anyone choose where files land, which is the whole
 * reason the token is generated here.
 */
async function resolveToken(raw: FormDataEntryValue | null, now: Date): Promise<string> {
  const candidate = typeof raw === 'string' ? raw.trim() : '';
  if (candidate && isQuarantineToken(candidate) && (await readBundle(candidate))) {
    return candidate;
  }
  return (await createBundle(now)).token;
}

function rateHeaders(limit: number, remaining: number, resetAt: number, retryAfter: number) {
  return {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(Math.floor(resetAt / 1000)),
    'Retry-After': String(retryAfter),
  };
}
