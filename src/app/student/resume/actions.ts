'use server';

import { redirect } from 'next/navigation';

import { createResumeVersion, getStudentResume } from '@/lib/ai/store';
import { requireStudent } from '@/lib/auth';

/**
 * First-draft generation is **not** here.
 *
 * It moved to `/api/resume/generate`, called over `fetch` by the form, because
 * a Server Action cannot be cancelled: React owns the request and exposes no
 * signal. Generation runs a local model for around a minute, which is long
 * enough that a reader will want to stop it — and a cancel that only hides the
 * spinner while the GPU keeps working is not a cancel. Regeneration below stays
 * an action because it is a one-click re-run with nothing to abandon mid-way.
 */

/// Re-runs the generator against today's REEP data using the same brief, and
/// files the result as a new version rather than overwriting the old one.
export async function regenerateResumeAction(formData: FormData): Promise<void> {
  const { studentId } = await requireStudent();
  const sourceId = String(formData.get('resumeId') ?? '');

  const source = await getStudentResume(studentId, sourceId);
  if (!source) redirect('/student/resume');

  const created = await createResumeVersion({
    studentId,
    title: source.title,
    targetRole: source.targetRole ?? 'Management Trainee',
    targetIndustry: source.targetIndustry ?? 'General Management',
    jobDescription: source.jobDescription,
  });

  redirect(created ? `/student/resume/${created.id}` : '/student/resume');
}
