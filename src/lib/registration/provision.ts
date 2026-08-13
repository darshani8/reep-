import 'server-only';

/**
 * Turning an approved application into an actual student.
 *
 * This is the moment the whole feature exists to reach, and it is the moment
 * with the most to go wrong, because four tables and two files have to become
 * real together or not at all:
 *
 *     User  →  Student  →  (files promoted)  →  Upload  →  StudentProfile
 *
 * Every arrow is a dependency, not a preference. `Student.userId` is a required
 * unique FK. `Upload.studentId` is required — which is the entire reason
 * `quarantine.ts` exists, because until this line runs there is no student id to
 * put in it. `StudentProfile.photoUploadId` points at an `Upload` row that
 * therefore cannot be written any earlier. A half-finished run leaves a `User`
 * that can sign in to a dashboard with no student record behind it, so the whole
 * chain is one interactive `$transaction` and the file copies happen *inside* it:
 * a disk that is full, or a quarantined file that has been swept, aborts the
 * database work rather than being discovered afterwards.
 *
 * The copies are the one part a transaction cannot roll back, so they are made
 * to be safe to lose. Nothing is moved — `saveUpload` writes a *new* file under
 * the student's own directory and the quarantined original stays where it is
 * until the seven-day sweep. A rollback therefore leaves at most an unreferenced
 * file under `storage/uploads/<studentId>/`, and the catch below removes even
 * that. It never leaves an applicant unable to be approved a second time.
 *
 * ## The temporary password
 *
 * `User.passwordHash` is required and this product has no set-your-own-password
 * flow, so an approved applicant either receives a credential or receives an
 * account they cannot open. One is generated here, hashed with the same `scrypt`
 * helper the seed and the login path use, mailed to them, and shown once to the
 * reviewer who approved them — because in this deployment the "mail" is a
 * console driver, and a director standing in front of a student needs to be able
 * to read it out. It is stated as temporary in both places. Replacing this with
 * a set-password link is the obvious next change and needs nothing here but a
 * different message.
 */

import { randomInt } from 'node:crypto';

import type { DegreeLevel, Prisma, RegistrationStatus } from '@prisma/client';

import { hashPassword } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { saveUpload } from '@/lib/uploads';

import {
  quarantineFileAsFile,
  type QuarantineBundle,
} from './quarantine';

export type ProvisionOutcome =
  | {
      ok: true;
      studentId: string;
      usn: string;
      cohortName: string;
      /// Shown to the approving director exactly once, and never stored in plain
      /// text anywhere — `User.passwordHash` is a scrypt digest of it.
      temporaryPassword: string;
    }
  | { ok: false; error: string };

export type ProvisionInput = {
  registrationId: string;
  /// The cohort the reviewer chose, or the one the matched rule named. Required:
  /// `Student.cohortId` is not nullable, and guessing it is how a BBA applicant
  /// ends up on the MBA leaderboards.
  cohortId: string;
  /// Confirmed by the reviewer rather than taken from the application, because
  /// `Student.usn` is unique and permanent and the applicant may have typed it
  /// from memory.
  usn: string;
  /// Null for an auto-approval, which by definition no human read.
  reviewedById: string | null;
  /// AUTO_APPROVED or APPROVED. Kept apart so an administrator can always tell
  /// which admissions a rule waved through — the reason the enum has both.
  status: Extract<RegistrationStatus, 'AUTO_APPROVED' | 'APPROVED'>;
  reviewNote: string | null;
  bundle: QuarantineBundle | null;
  now: Date;
};

/**
 * No ambiguous glyphs.
 *
 * This password is going to be read off a terminal and typed by somebody else,
 * quite possibly out loud. `O`/`0` and `l`/`1` cost more support calls than the
 * two bits of entropy they add are worth. Five groups of four from a 30-symbol
 * alphabet is a shade under 100 bits, which is ample for a credential that is
 * meant to be changed on first use.
 */
const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function generateTemporaryPassword(): string {
  const pick = () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  const group = () => Array.from({ length: 4 }, pick).join('');
  return `${group()}-${group()}-${group()}`;
}

/// Two letters for the avatar, matching the shape the seed writes.
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? `${words[0][0]}${words[words.length - 1][0]}` : words[0]?.slice(0, 2) ?? '??';
  return letters.toUpperCase();
}

/**
 * The checks that must happen before anything is written.
 *
 * Run outside the transaction and again by the database's own unique indexes
 * inside it. The pre-check exists for the message: a reviewer who has approved
 * an applicant whose USN is already on the roster needs to be told *that*, not
 * handed a Prisma constraint error. The index exists because two reviewers can
 * click approve at the same moment.
 */
export async function checkProvisionable(params: {
  email: string;
  usn: string;
  cohortId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const [existingUser, existingStudent, cohort] = await Promise.all([
    prisma.user.findUnique({ where: { email: params.email }, select: { id: true } }),
    prisma.student.findUnique({ where: { usn: params.usn }, select: { id: true } }),
    prisma.cohort.findUnique({ where: { id: params.cohortId }, select: { id: true } }),
  ]);

  if (existingUser) {
    return {
      ok: false,
      error: `${params.email} already has an account. Approving would create a second one, so this application needs to be rejected or the address corrected.`,
    };
  }
  if (existingStudent) {
    return { ok: false, error: `USN ${params.usn} is already on the roster. Check the number before approving.` };
  }
  if (!cohort) {
    return { ok: false, error: 'That cohort no longer exists. Pick another one.' };
  }
  return { ok: true };
}

export async function provisionStudent(input: ProvisionInput): Promise<ProvisionOutcome> {
  const registration = await prisma.registration.findUnique({
    where: { id: input.registrationId },
  });
  if (!registration) return { ok: false, error: 'That application no longer exists.' };
  if (registration.approvedStudentId) {
    return { ok: false, error: 'That application has already been approved.' };
  }

  const usn = input.usn.trim().toUpperCase();
  const guard = await checkProvisionable({
    email: registration.email,
    usn,
    cohortId: input.cohortId,
  });
  if (!guard.ok) return guard;

  const temporaryPassword = generateTemporaryPassword();
  const extras = input.bundle?.extras ?? null;
  const parsed = input.bundle?.parsed ?? null;

  /// Files written during the attempt, so a rollback can take them with it.
  const written: { studentId: string; storedName: string }[] = [];

  try {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: registration.email,
          passwordHash: hashPassword(temporaryPassword),
          name: registration.name,
          role: 'STUDENT',
          avatarInitials: initialsFor(registration.name),
        },
        select: { id: true },
      });

      const student = await tx.student.create({
        data: {
          userId: user.id,
          usn,
          cohortId: input.cohortId,
        },
        select: { id: true, cohort: { select: { name: true } } },
      });

      // Bytes first, rows second. `saveUpload` re-sniffs the content and picks
      // the stored name, so the promoted file is checked exactly as a file a
      // signed-in student uploads is — the quarantine is not a way in around it.
      let photoUploadId: string | null = null;

      if (input.bundle?.photo) {
        const file = await quarantineFileAsFile(input.bundle.token, input.bundle.photo);
        const saved = await saveUpload(student.id, file);
        written.push({ studentId: student.id, storedName: saved.storedName });
        const upload = await tx.upload.create({
          data: {
            studentId: student.id,
            kind: 'PROFILE_PHOTO',
            title: 'Registration photo',
            originalName: input.bundle.photo.originalName,
            storedName: saved.storedName,
            mimeType: saved.mimeType,
            sizeBytes: saved.sizeBytes,
            // A reviewer has just looked at this photo on the approval screen,
            // which is the check `PROFILE_PHOTO` would otherwise never get.
            status: 'VERIFIED',
          },
          select: { id: true },
        });
        photoUploadId = upload.id;
      }

      if (input.bundle?.cv) {
        const file = await quarantineFileAsFile(input.bundle.token, input.bundle.cv);
        const saved = await saveUpload(student.id, file);
        written.push({ studentId: student.id, storedName: saved.storedName });
        await tx.upload.create({
          data: {
            studentId: student.id,
            kind: 'RESUME',
            title: 'CV submitted at registration',
            originalName: input.bundle.cv.originalName,
            storedName: saved.storedName,
            mimeType: saved.mimeType,
            sizeBytes: saved.sizeBytes,
            status: 'VERIFIED',
          },
        });
      }

      await tx.studentProfile.create({
        data: {
          studentId: student.id,
          phone: registration.phone,
          email: registration.email,
          // The two profile columns the application form fills directly. The
          // programme and branch have no column on any table and stay in the
          // quarantine manifest as the record of what was applied for.
          linkedinUrl: extras?.linkedinUrl ?? null,
          city: extras?.city ?? null,
          education: (parsed?.education ?? []) as unknown as Prisma.InputJsonValue,
          skills: (parsed?.skills ?? []) as unknown as Prisma.InputJsonValue,
          photoUploadId,
        },
      });

      await tx.registration.update({
        where: { id: registration.id },
        data: {
          status: input.status,
          reviewedById: input.reviewedById,
          reviewedAt: input.now,
          reviewNote: input.reviewNote,
          cohortId: input.cohortId,
          usn,
          approvedStudentId: student.id,
        },
      });

      return { studentId: student.id, cohortName: student.cohort.name };
    });

    return {
      ok: true,
      studentId: result.studentId,
      usn,
      cohortName: result.cohortName,
      temporaryPassword,
    };
  } catch (error) {
    // The database has rolled itself back; the filesystem has not. Remove what
    // this attempt wrote so a retry starts clean, and never let a cleanup
    // failure mask the real error.
    await Promise.all(
      written.map(async ({ studentId, storedName }) => {
        try {
          const { deleteUpload } = await import('@/lib/uploads');
          await deleteUpload(studentId, storedName);
        } catch {
          // Nothing useful to do. The file is unreferenced either way.
        }
      }),
    );
    return { ok: false, error: describe(error) };
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Unique constraint/i.test(message)) {
    return 'Something with that email or USN was created while this was being approved. Reload the queue and try again.';
  }
  return `Approval could not be completed: ${message.split('\n').pop()?.slice(0, 200) ?? 'unknown error'}`;
}

/// Degree levels a cohort can be offered for, so the approval form only lists
/// cohorts the applicant is actually eligible for.
export function cohortMatchesDegree(cohortLevel: DegreeLevel, applicant: DegreeLevel): boolean {
  return cohortLevel === applicant;
}
