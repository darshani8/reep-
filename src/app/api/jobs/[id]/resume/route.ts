import { NextResponse } from 'next/server';
import { z } from 'zod';

import { createResumeVersion } from '@/lib/ai/store';
import { getSession } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { defaultResumeTitle, jobBrief } from '@/lib/jobs/brief';
import { skillNamesFor } from '@/lib/jobs/board';

export const dynamic = 'force-dynamic';

/**
 * "Clickable CV builder to build CV for each job."
 *
 * A route handler rather than a Server Action for the reason
 * `/api/resume/generate` is one: generation runs a local model for about a
 * minute, an action cannot be cancelled, and a Cancel button that only hides
 * the spinner while the GPU keeps working is not a Cancel. The request's own
 * signal is passed down, so closing the tab stops the model and writes nothing.
 *
 * It calls the same `createResumeVersion` the resume screen calls. The one
 * thing it does afterwards is stamp `Resume.jobId`, which that function has no
 * parameter for — a create-then-update rather than a fork of the generator,
 * because two resume writers that agree today would not agree in a month. The
 * window between the two writes is one statement wide and the row is already
 * complete and readable throughout it; the only thing missing is the link back
 * to the posting.
 */
const Body = z.object({
  targetRole: z.string().trim().min(2).max(120),
  targetIndustry: z.string().trim().min(2).max(120),
  title: z.string().trim().min(1).max(120).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== 'STUDENT' || !session.studentId) {
    return NextResponse.json(
      { error: 'Sign in as a student to build a CV.' },
      { status: 401 },
    );
  }

  const { id } = await params;
  const job = await prisma.job.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      description: true,
      requiredSkills: true,
    },
  });
  if (!job) return NextResponse.json({ error: 'No such posting.' }, { status: 404 });

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const parsed = Body.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'Tell us the role and the industry you are aiming at.',
        issues: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  // The posting is public data, so composing the brief needs no egress check.
  // What the generator adds to it — name, USN, marks, attendance — is student
  // data, and `generateResume` runs that past `studentDataEgressAllowed()`
  // itself. Nothing on this path goes round it.
  const jobDescription = jobBrief(job, await skillNamesFor(job.requiredSkills));

  let resume: Awaited<ReturnType<typeof createResumeVersion>>;
  try {
    resume = await createResumeVersion({
      studentId: session.studentId,
      title: parsed.data.title || defaultResumeTitle(job),
      targetRole: parsed.data.targetRole,
      targetIndustry: parsed.data.targetIndustry,
      jobDescription,
      signal: request.signal,
    });
  } catch (error) {
    // Nothing to answer — the connection is gone. 499 is the conventional
    // "client closed request" and exists here for the log.
    if (request.signal.aborted) return new NextResponse(null, { status: 499 });
    throw error;
  }

  if (!resume) {
    return NextResponse.json({ error: 'No student record found.' }, { status: 404 });
  }

  const linked = await prisma.resume.update({
    where: { id: resume.id },
    data: { jobId: job.id },
    select: { id: true, version: true, generatedBy: true, model: true },
  });

  return NextResponse.json(
    {
      id: linked.id,
      version: linked.version,
      generatedBy: linked.generatedBy,
      model: linked.model,
      url: `/student/resume/${linked.id}`,
    },
    { status: 201 },
  );
}
