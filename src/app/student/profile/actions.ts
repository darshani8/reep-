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

export type LeaderboardVisibilityState = {
  ok?: boolean;
  error?: string;
  /// The value now stored. Undefined before the student has touched the
  /// control in this session and the page has not told the form what it is.
  optOut?: boolean;
};

/**
 * The one control on this page that changes what *other* students see.
 *
 * It is a separate action from `saveProfileAction`, and that is a decision
 * rather than tidiness. Folded into the big form, the checkbox's value would
 * ride along with every "Save profile" — so a form rendered without knowing the
 * stored flag would post `false` for it and quietly put an opted-out student
 * back on every board, on a save they made about their phone number. Here the
 * column is written only when this form is submitted, and only to a value the
 * student stated explicitly: the intent arrives as the string `true` or
 * `false`, and anything else is rejected rather than coerced. An absent
 * checkbox posts nothing at all, which `Boolean(formData.get(…))` would have
 * read as "opt me back in".
 *
 * Upsert, not update: a student who has never opened this page has no
 * `StudentProfile` row, and opting out must not require them to fill in a
 * career summary first.
 */
export async function setLeaderboardOptOutAction(
  _prev: LeaderboardVisibilityState,
  formData: FormData,
): Promise<LeaderboardVisibilityState> {
  const { studentId } = await requireStudent();

  const intent = String(formData.get('optOut') ?? '');
  if (intent !== 'true' && intent !== 'false') {
    return { error: 'Choose whether you appear on the leaderboards.' };
  }
  const leaderboardOptOut = intent === 'true';

  await prisma.studentProfile.upsert({
    where: { studentId },
    update: { leaderboardOptOut },
    create: { studentId, leaderboardOptOut },
  });

  revalidatePath('/student/profile');
  // The boards read this flag for every student in the cohort, so a stale
  // render would keep showing a name that has just been withdrawn.
  revalidatePath('/student/leaderboards');

  return { ok: true, optOut: leaderboardOptOut };
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
