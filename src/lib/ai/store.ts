import 'server-only';

/**
 * Persistence for generated resumes.
 *
 * Lives beside the generator rather than in a route or a page so the Server
 * Action and the JSON endpoint share one code path — versioning included.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { getResumeContext } from '@/lib/queries';

import { generateResume } from './resume';

/**
 * One resume, scoped to its owner. The studentId in the where-clause is the
 * authorisation check: another student's id simply finds nothing.
 *
 * getResumeContext() only carries the ten most recent resumes for the list
 * screen, so the detail screen reads through here instead and stays correct for
 * students who have generated more than that.
 */
export async function getStudentResume(studentId: string, resumeId: string) {
  return prisma.resume.findFirst({ where: { id: resumeId, studentId } });
}

export type CreateResumeInput = {
  studentId: string;
  title: string;
  targetRole: string;
  targetIndustry: string;
  jobDescription?: string | null;
  /// Cancellation from the caller. `generateResume` rethrows aborts rather than
  /// falling back, so an abort unwinds out of here *before* the create below —
  /// a cancelled run leaves no row.
  signal?: AbortSignal;
};

/// Returns null when the student id does not resolve — callers turn that into a
/// 404 rather than a 500.
export async function createResumeVersion(input: CreateResumeInput) {
  const context = await getResumeContext(input.studentId);
  if (!context) return null;

  const generated = await generateResume({
    context,
    title: input.title,
    targetRole: input.targetRole,
    targetIndustry: input.targetIndustry,
    jobDescription: input.jobDescription ?? null,
    signal: input.signal,
  });

  // The model can finish just as the reader gives up; without this the row is
  // written for a request nobody is listening to any more.
  if (input.signal?.aborted) {
    const error = new Error('The request was cancelled.');
    error.name = 'AbortError';
    throw error;
  }

  // Versions are per student and monotonic, so a student can point a recruiter
  // at "v3" and have that mean something.
  const latest = await prisma.resume.findFirst({
    where: { studentId: input.studentId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });

  return prisma.resume.create({
    data: {
      studentId: input.studentId,
      version: (latest?.version ?? 0) + 1,
      title: input.title,
      targetRole: input.targetRole,
      targetIndustry: input.targetIndustry,
      jobDescription: input.jobDescription ?? null,
      status: 'GENERATED',
      content: generated.content as unknown as Prisma.InputJsonValue,
      markdown: generated.markdown,
      evidence: generated.evidence as unknown as Prisma.InputJsonValue,
      scoring: generated.scoring as unknown as Prisma.InputJsonValue,
      model: generated.model,
      generatedBy: generated.generatedBy,
    },
  });
}
