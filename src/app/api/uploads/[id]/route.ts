import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';

import { prisma } from '@/lib/db';
import { accessForStudent } from '@/lib/upload-access';
import { deleteUpload, readUpload } from '@/lib/uploads';

/// Streams the file back. Files are never served from /public — every read goes
/// through this handler so the ownership check cannot be bypassed by URL.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload) return new NextResponse('Not found', { status: 404 });

  const access = await accessForStudent(upload.studentId);
  if (!access) return new NextResponse('Unauthorized', { status: 401 });
  if (!access.canView) return new NextResponse('Forbidden', { status: 403 });

  try {
    const bytes = await readUpload(upload.studentId, upload.storedName);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        // `saveUpload` stores the type sniffed from the bytes, so for anything
        // uploaded since that change this is a fact rather than the uploader's
        // string. Rows written before it are not re-sniffed, which is why the
        // two headers below are not optional — they are what makes an old row
        // with a lying mimeType harmless. An empty stored value would otherwise
        // let the browser fall back to guessing.
        'Content-Type': upload.mimeType || 'application/octet-stream',
        'Content-Length': String(upload.sizeBytes),
        // inline so PDFs and images preview in the browser rather than download
        'Content-Disposition': `inline; filename="${encodeURIComponent(upload.originalName)}"`,
        'Cache-Control': 'private, max-age=300',
        // Take the Content-Type literally. Without this a browser may sniff the
        // body itself and render a file stored as image/png as HTML.
        'X-Content-Type-Options': 'nosniff',
        // A bare `sandbox` denies scripts, forms, popups, and — critically — a
        // same-origin identity, so even if some future body does get rendered
        // as a document it holds no session and can read nothing back. This is
        // the layer that survives a mistake in the sniffing rules.
        'Content-Security-Policy': 'sandbox',
      },
    });
  } catch {
    return new NextResponse('The stored file is missing.', { status: 410 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const access = await accessForStudent(upload.studentId);
  if (!access?.canDelete) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
  }

  await deleteUpload(upload.studentId, upload.storedName);
  await prisma.upload.delete({ where: { id } });

  revalidatePath('/student/uploads');
  revalidatePath('/student/profile');

  return NextResponse.json({ deleted: id });
}
