import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';

import type { UploadKind } from '@prisma/client';

import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { saveUpload, validateUpload } from '@/lib/uploads';

const KINDS: UploadKind[] = ['CERTIFICATE_PROOF', 'RESUME', 'PROFILE_PHOTO', 'DOCUMENT'];

/// POST multipart/form-data: file, kind, and optionally certCode + title.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.studentId) {
    return NextResponse.json({ error: 'Sign in as a student to upload.' }, { status: 401 });
  }

  const form = await request.formData();
  const file = form.get('file');
  const kind = String(form.get('kind') ?? '') as UploadKind;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file was attached.' }, { status: 400 });
  }
  if (!KINDS.includes(kind)) {
    return NextResponse.json({ error: 'Unknown upload type.' }, { status: 400 });
  }

  const validation = validateUpload(kind, file);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.reason }, { status: 400 });
  }

  const certCode = form.get('certCode') ? String(form.get('certCode')) : null;
  if (kind === 'CERTIFICATE_PROOF' && certCode) {
    // Only accept a certification this student is actually enrolled on, so a
    // proof cannot be filed against someone else's course.
    const enrolled = await prisma.certificationProgress.count({
      where: { studentId: session.studentId, certCode },
    });
    if (enrolled === 0) {
      return NextResponse.json(
        { error: 'You are not enrolled on that certification.' },
        { status: 400 },
      );
    }
  }

  const saved = await saveUpload(session.studentId, file);

  const upload = await prisma.upload.create({
    data: {
      studentId: session.studentId,
      kind,
      certCode: kind === 'CERTIFICATE_PROOF' ? certCode : null,
      title: String(form.get('title') || file.name),
      originalName: file.name,
      storedName: saved.storedName,
      mimeType: saved.mimeType,
      sizeBytes: saved.sizeBytes,
      // A photo is not evidence of anything, so it needs no mentor review.
      status: kind === 'PROFILE_PHOTO' ? 'VERIFIED' : 'PENDING_REVIEW',
    },
  });

  revalidatePath('/student/uploads');
  revalidatePath('/student/profile');
  revalidatePath('/student/certifications');

  return NextResponse.json({ upload }, { status: 201 });
}
