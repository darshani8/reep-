import 'server-only';

import { prisma } from './db';
import { getSession, type SessionPayload } from './auth';

/**
 * Who may see or act on an upload.
 *
 * A student sees only their own files. A mentor sees files belonging to their
 * own mentees — not the whole programme. A director sees everything. Getting
 * this wrong would expose one student's ID scan to another, so it lives in one
 * function that every upload route calls.
 */

export type UploadAccess = {
  session: SessionPayload;
  canView: boolean;
  canDelete: boolean;
  canReview: boolean;
};

export async function accessForStudent(studentId: string): Promise<UploadAccess | null> {
  const session = await getSession();
  if (!session) return null;

  if (session.role === 'STUDENT') {
    const own = session.studentId === studentId;
    return { session, canView: own, canDelete: own, canReview: false };
  }

  if (session.role === 'DIRECTOR' || session.role === 'ADMIN') {
    return { session, canView: true, canDelete: true, canReview: true };
  }

  if (session.role === 'MENTOR' && session.mentorId) {
    const isMentee =
      (await prisma.student.count({
        where: { id: studentId, mentorId: session.mentorId },
      })) > 0;
    return { session, canView: isMentee, canDelete: false, canReview: isMentee };
  }

  return { session, canView: false, canDelete: false, canReview: false };
}
