import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';

import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { claimBlockedReason, clampLevel } from '@/lib/skills/claim-rules';
import { UploadRejectedError, saveUpload, validateUpload } from '@/lib/uploads';

/**
 * File a skill claim: a certificate, and the skill it is evidence for.
 *
 * This is `/api/uploads` with one extra column, and it stays that way on
 * purpose. The file is stored by the same `saveUpload`, checked by the same
 * `validateUpload` (which sniffs the magic bytes rather than trusting the
 * declared type), recorded as the same `CERTIFICATE_PROOF` kind, and lands
 * `PENDING_REVIEW` in the same mentor queue at `/mentor/uploads`. The only
 * thing this route adds is a `SkillClaim` row pointing at that upload.
 *
 * It is a separate handler rather than a `skillSlug` field bolted onto
 * `/api/uploads` because that route is shared by four kinds and its certCode
 * branch is already the busiest part of it — but nothing here is a second
 * approval path. Nothing in this file writes `VERIFIED`, and nothing here
 * touches `StudentSkill`. The claim becomes a badge only when a mentor decides
 * the *file*, and `syncClaimVerdicts` carries that verdict across.
 *
 * POST multipart/form-data: `file`, `skillSlug`, optional `level` and `title`.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.studentId) {
    return NextResponse.json({ error: 'Sign in as a student to claim a skill.' }, { status: 401 });
  }
  const studentId = session.studentId;

  const form = await request.formData();
  const file = form.get('file');
  const skillSlug = String(form.get('skillSlug') ?? '').trim();

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Attach the certificate first.' }, { status: 400 });
  }
  if (!skillSlug) {
    return NextResponse.json({ error: 'Choose which skill this proves.' }, { status: 400 });
  }

  // Cheap checks before the body is read. `saveUpload` runs the sniff again on
  // the real bytes, so this is a better error message rather than the guard.
  const validation = validateUpload('CERTIFICATE_PROOF', file);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.reason }, { status: 400 });
  }

  const skill = await prisma.skill.findUnique({
    where: { slug: skillSlug },
    select: { id: true, name: true },
  });
  if (!skill) {
    return NextResponse.json({ error: 'That skill is not in the catalogue.' }, { status: 400 });
  }

  // Both reads are scoped to this student, so nobody can probe another
  // student's claims by watching which slugs come back blocked.
  const [pending, holding] = await Promise.all([
    prisma.skillClaim.count({
      where: { studentId, skillId: skill.id, status: 'PENDING_REVIEW' },
    }),
    prisma.studentSkill.findUnique({
      where: { studentId_skillId: { studentId, skillId: skill.id } },
      select: { verified: true },
    }),
  ]);

  const blocked = claimBlockedReason({
    hasPendingClaim: pending > 0,
    alreadyVerified: holding?.verified === true,
  });
  if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });

  const level = clampLevel(Number(form.get('level') ?? 3));

  let saved;
  try {
    saved = await saveUpload(studentId, file);
  } catch (error) {
    // The bytes contradicted the declared type. That is a bad request, not a
    // server fault, and the reason is safe to repeat back — it says nothing the
    // uploader did not put in the file themselves.
    if (error instanceof UploadRejectedError) {
      return NextResponse.json({ error: error.reason }, { status: 400 });
    }
    throw error;
  }

  // One transaction: an upload with no claim is an orphan file in the mentor's
  // queue with no stated purpose, and a claim with no upload cannot be reviewed
  // at all.
  const claim = await prisma.$transaction(async (tx) => {
    const upload = await tx.upload.create({
      data: {
        studentId,
        kind: 'CERTIFICATE_PROOF',
        title: String(form.get('title') || `${skill.name} — ${file.name}`),
        originalName: file.name,
        storedName: saved.storedName,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
        // Never anything else from this route. See the module comment.
        status: 'PENDING_REVIEW',
      },
    });

    return tx.skillClaim.create({
      data: {
        studentId,
        skillId: skill.id,
        uploadId: upload.id,
        claimedLevel: level,
        status: 'PENDING_REVIEW',
      },
    });
  });

  revalidatePath('/student/skilling');
  revalidatePath('/student/uploads');
  revalidatePath('/student/profile');
  revalidatePath('/mentor/uploads');

  return NextResponse.json({ claim }, { status: 201 });
}
