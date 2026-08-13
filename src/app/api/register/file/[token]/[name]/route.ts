import { NextResponse } from 'next/server';

import { getSession } from '@/lib/auth';
import { readBundle, readQuarantineFile } from '@/lib/registration/quarantine';

/**
 * The only way to read a quarantined file, and it is staff-only.
 *
 * The bytes under `storage/registration/` are an unauthenticated stranger's
 * upload. They are not in `/public`, they are not linked from the applicant's
 * own confirmation page, and the token that names them is not a capability —
 * possession of it proves nothing, because the applicant's browser holds one
 * too. So the check here is a *role* check: DIRECTOR or ADMIN, the same two
 * roles the review queue admits, and for the same reason its docblock gives —
 * an applicant has no mentor, so `mentorScope()` has no answer about them and a
 * MENTOR has no business reading a stranger's CV.
 *
 * `requireRole()` is not used: it `redirect()`s, which is right for a page and
 * wrong for a fetch, where a 302 to `/login` arrives as an HTML body in an
 * `<img>` tag. The session is read directly and the answer is a status code.
 *
 * This sits under `/api/register/*`, which `middleware.ts` treats as public.
 * That costs nothing — middleware only checks that a cookie is *present*, never
 * that it is valid or what role it carries, so it was never the boundary here.
 * The three lines below are.
 *
 * The response headers are copied from `/api/uploads/[id]` deliberately, down to
 * the `Content-Security-Policy: sandbox`. This is the higher-risk of the two: the
 * uploader is anonymous, and the one person guaranteed to open the file is the
 * director whose session is the most valuable in the product.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string; name: string }> },
) {
  const session = await getSession();
  if (!session) return new NextResponse('Unauthorized', { status: 401 });
  if (session.role !== 'DIRECTOR' && session.role !== 'ADMIN') {
    return new NextResponse('Forbidden', { status: 403 });
  }

  const { token, name } = await params;

  const bundle = await readBundle(token);
  if (!bundle) return new NextResponse('Not found', { status: 404 });

  // Only the two files the manifest actually names. A stored name that is not
  // one of them is refused before it can be resolved to a path, so the manifest
  // — not the URL — decides what is readable.
  const file = [bundle.cv, bundle.photo].find((entry) => entry?.storedName === name);
  if (!file) return new NextResponse('Not found', { status: 404 });

  try {
    const bytes = await readQuarantineFile(token, file.storedName);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': file.mimeType || 'application/octet-stream',
        'Content-Length': String(file.sizeBytes),
        'Content-Disposition': `inline; filename="${encodeURIComponent(file.originalName)}"`,
        // Never cached by a shared cache: this is one applicant's document behind
        // one director's session.
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox',
      },
    });
  } catch {
    // Most likely swept: the manifest outlives nothing, but a directory removed
    // between the read and the fetch leaves this exact gap.
    return new NextResponse('That file is no longer in quarantine.', { status: 410 });
  }
}
