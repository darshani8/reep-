'use server';

import { revalidatePath } from 'next/cache';

import { requireStudent } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { LIST_FIELDS, parseList, type ListField } from './json-lists';
import type { Prisma } from '@prisma/client';

export type ProfileState = { ok?: boolean; error?: string; savedAt?: number };

/// Blank strings become NULL rather than '' so "not supplied yet" is one value,
/// not two, by the time the resume generator reads the row.
function text(form: FormData, key: string): string | null {
  const value = String(form.get(key) ?? '').trim();
  return value.length > 0 ? value : null;
}

/// Students paste "linkedin.com/in/…" far more often than a full URL, and a
/// resume with a dead link is worse than one with no link.
function url(form: FormData, key: string): string | null {
  const value = text(form, key);
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

export async function saveProfileAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  // Server Actions are reachable by direct POST, not only through this form, so
  // the guard belongs here as well as on the page.
  const { studentId } = await requireStudent();

  const email = text(formData, 'email');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: 'That contact email does not look like a valid address.' };
  }

  const lists = Object.fromEntries(
    LIST_FIELDS.map((field) => [
      field,
      parseList(field, String(formData.get(field) ?? '')) as Prisma.InputJsonValue,
    ]),
  ) as Record<ListField, Prisma.InputJsonValue>;

  const data = {
    phone: text(formData, 'phone'),
    email,
    linkedinUrl: url(formData, 'linkedinUrl'),
    githubUrl: url(formData, 'githubUrl'),
    portfolioUrl: url(formData, 'portfolioUrl'),
    city: text(formData, 'city'),
    careerSummary: text(formData, 'careerSummary'),
    ...lists,
  };

  await prisma.studentProfile.upsert({
    where: { studentId },
    update: data,
    create: { studentId, ...data },
  });

  revalidatePath('/student/profile');
  // The resume builder reads this exact row; a stale draft screen would quietly
  // generate from the previous version.
  revalidatePath('/student/resume');

  return { ok: true, savedAt: Date.now() };
}

export type TargetState = { ok?: boolean; error?: string; hours?: number };

export async function saveWeeklyTargetAction(
  _prev: TargetState,
  formData: FormData,
): Promise<TargetState> {
  const { studentId } = await requireStudent();

  const raw = Number(formData.get('weeklyHourTarget'));
  // Zero would divide by zero in the "vs. target" charts, and anything past 60
  // is a data-entry slip rather than a plan — so say so instead of silently
  // clamping a number the student did not choose.
  if (!Number.isFinite(raw) || raw < 1 || raw > 60) {
    return { error: 'Choose a target between 1 and 60 hours a week.' };
  }
  const target = Math.round(raw * 2) / 2;

  await prisma.student.update({
    where: { id: studentId },
    data: { weeklyHourTarget: target },
  });

  revalidatePath('/student/profile');
  revalidatePath('/student/time-log');

  return { ok: true, hours: target };
}
