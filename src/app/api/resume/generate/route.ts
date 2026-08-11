import { NextResponse } from 'next/server';
import { z } from 'zod';

import { isAiResumeEnabled, resumeModelId } from '@/lib/ai/resume';
import { createResumeVersion } from '@/lib/ai/store';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/// Route handlers answer with status codes rather than redirects, so this does
/// not use requireStudent() — a fetch() caller wants a 401, not a login page.
const Body = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  targetRole: z.string().trim().min(2).max(120),
  targetIndustry: z.string().trim().min(2).max(120),
  jobDescription: z.string().trim().max(20_000).optional(),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || session.role !== 'STUDENT' || !session.studentId) {
    return NextResponse.json(
      { error: 'Sign in as a student to generate a resume.' },
      { status: 401 },
    );
  }

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
        error: 'Invalid request body.',
        issues: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const { targetRole, targetIndustry, jobDescription, title } = parsed.data;

  let resume: Awaited<ReturnType<typeof createResumeVersion>>;
  try {
    resume = await createResumeVersion({
      studentId: session.studentId,
      title: title || `${targetRole} Resume`,
      targetRole,
      targetIndustry,
      jobDescription: jobDescription || null,
      // Generation runs a local model for about a minute. Passing the request's
      // own signal down means closing the tab or pressing Cancel actually stops
      // it, instead of leaving the model running for a reader who has gone.
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal.aborted) {
      // Nothing to send this to — the connection is already gone. 499 is the
      // conventional "client closed request"; it exists here for the log.
      return new NextResponse(null, { status: 499 });
    }
    throw error;
  }

  if (!resume) {
    return NextResponse.json({ error: 'No student record found.' }, { status: 404 });
  }

  return NextResponse.json(
    {
      id: resume.id,
      version: resume.version,
      title: resume.title,
      targetRole: resume.targetRole,
      generatedBy: resume.generatedBy,
      model: resume.model,
      aiEnabled: isAiResumeEnabled(),
      configuredModel: resumeModelId(),
      scoring: resume.scoring,
      url: `/student/resume/${resume.id}`,
    },
    { status: 201 },
  );
}
