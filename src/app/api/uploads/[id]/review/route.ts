import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';

import { prisma } from '@/lib/db';
import { accessForStudent } from '@/lib/upload-access';

/// Mentor verification of an uploaded certificate proof. This is the "spot-checked
/// by the mentor" half of the wireframe's certification-progress note.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const access = await accessForStudent(upload.studentId);
  if (!access?.canReview) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
  }

  const body = (await request.json()) as { status?: string; note?: string };
  if (body.status !== 'VERIFIED' && body.status !== 'REJECTED') {
    return NextResponse.json(
      { error: 'status must be VERIFIED or REJECTED' },
      { status: 400 },
    );
  }

  const updated = await prisma.upload.update({
    where: { id },
    data: {
      status: body.status,
      reviewedById: access.session.userId,
      reviewedAt: new Date(),
      reviewNote: body.note?.trim() || null,
    },
  });

  // A verified proof is stronger evidence than a self-reported figure, so stop
  // treating that certification's progress as unverified.
  if (body.status === 'VERIFIED' && upload.certCode) {
    await prisma.certificationProgress.updateMany({
      where: { studentId: upload.studentId, certCode: upload.certCode },
      data: { selfReported: false },
    });
  }

  revalidatePath('/mentor/uploads');
  revalidatePath(`/mentor/student/${upload.studentId}`);
  revalidatePath('/student/uploads');

  return NextResponse.json({ upload: updated });
}
