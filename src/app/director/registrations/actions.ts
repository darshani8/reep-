'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { buildRejectionEmail } from '@/lib/mail/messages';
import { sendMail } from '@/lib/mail/send';
import { decideAndApply } from '@/lib/registration/intake';
import { provisionStudent } from '@/lib/registration/provision';
import { bundleForRegistration } from '@/lib/registration/quarantine';

/**
 * The three things a reviewer can do, and the role check in front of each.
 *
 * `requireRole('DIRECTOR', 'ADMIN')` is repeated in every action rather than
 * relied on from the page, because a Server Action is a public POST endpoint and
 * the page having rendered the form is not a security boundary — the Next docs
 * are explicit about this and the rest of the codebase (`placement/actions.ts`)
 * already writes it out per action.
 *
 * It is `requireRole` and not `requireMentor()`. An applicant is not a student
 * yet, so they belong to no mentor group, so `mentorScope()` has no answer about
 * them — the closed case in that module would be `{ kind: 'none' }` for a MENTOR
 * and there is no honest way to widen it. Reading and deciding on strangers'
 * applications is programme-office work.
 *
 * Nothing here trusts an id from the client for anything but *identifying* a
 * row: the email, the name and the applicant's own answers are re-read from the
 * database and the quarantine manifest inside the action, never taken from the
 * form.
 */

export type DecisionState = {
  error?: string;
  message?: string;
  /// Shown once, to the director who approved. See `provision.ts` for why a
  /// password exists at all and why it is surfaced here as well as emailed.
  temporaryPassword?: string;
};

const ApproveSchema = z.object({
  registrationId: z.string().min(1),
  cohortId: z.string().min(1, 'Choose the cohort this student joins.'),
  usn: z
    .string()
    .trim()
    .toUpperCase()
    .min(6, 'Confirm the university seat number before approving.')
    .max(20, 'A USN is at most 20 characters.')
    .refine((value) => /^[A-Z0-9]{6,20}$/.test(value), 'A USN is 6 to 20 letters and digits.'),
  note: z.string().trim().max(500).optional(),
});

export async function approveRegistrationAction(
  _prev: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  const session = await requireRole('DIRECTOR', 'ADMIN');

  const parsed = ApproveSchema.safeParse({
    registrationId: String(formData.get('registrationId') ?? ''),
    cohortId: String(formData.get('cohortId') ?? ''),
    usn: String(formData.get('usn') ?? ''),
    note: String(formData.get('note') ?? ''),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'That approval is not valid.' };
  }

  const registration = await prisma.registration.findUnique({
    where: { id: parsed.data.registrationId },
    select: { id: true, status: true, emailVerifiedAt: true },
  });
  if (!registration) return { error: 'That application no longer exists.' };
  if (registration.status === 'REJECTED') {
    return { error: 'That application was rejected. Reopen it before approving.' };
  }

  const result = await provisionStudent({
    registrationId: registration.id,
    cohortId: parsed.data.cohortId,
    usn: parsed.data.usn,
    reviewedById: session.userId,
    // APPROVED, never AUTO_APPROVED: a human read this one, and the enum keeps
    // the two apart precisely so that stays knowable afterwards.
    status: 'APPROVED',
    reviewNote: parsed.data.note || null,
    bundle: await bundleForRegistration(registration.id),
    now: new Date(),
  });

  if (!result.ok) return { error: result.error };

  revalidatePath('/director/registrations');
  revalidatePath(`/director/registrations/${registration.id}`);
  // The roster and the cohort rollups have one more student in them now.
  revalidatePath('/director');

  return {
    message: `${result.usn} is enrolled on ${result.cohortName}. A welcome email with a temporary password has been sent.`,
    temporaryPassword: result.temporaryPassword,
  };
}

const RejectSchema = z.object({
  registrationId: z.string().min(1),
  reason: z
    .string()
    .trim()
    .min(10, 'Write a reason. It is sent to the applicant, so it has to say something they can act on.')
    .max(500, 'Keep the reason under 500 characters.'),
});

export async function rejectRegistrationAction(
  _prev: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  const session = await requireRole('DIRECTOR', 'ADMIN');

  const parsed = RejectSchema.safeParse({
    registrationId: String(formData.get('registrationId') ?? ''),
    reason: String(formData.get('reason') ?? ''),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'That rejection is not valid.' };
  }

  const registration = await prisma.registration.findUnique({
    where: { id: parsed.data.registrationId },
    select: { id: true, name: true, email: true, approvedStudentId: true },
  });
  if (!registration) return { error: 'That application no longer exists.' };
  if (registration.approvedStudentId) {
    return {
      error: 'That application has already been approved and a student record created. Rejecting it now would leave the account behind.',
    };
  }

  const now = new Date();
  await prisma.registration.update({
    where: { id: registration.id },
    data: {
      status: 'REJECTED',
      reviewedById: session.userId,
      reviewedAt: now,
      reviewNote: parsed.data.reason,
    },
  });

  // The applicant is told, with the reviewer's own words. `dedupeKey` is keyed on
  // the registration rather than on the moment, so re-rejecting a row does not
  // send a second copy of the same bad news.
  const mail = await sendMail({
    kind: 'registration-rejected',
    dedupeKey: `registration-rejected:${registration.id}`,
    message: buildRejectionEmail({
      to: registration.email,
      name: registration.name,
      reason: parsed.data.reason,
    }),
  });

  revalidatePath('/director/registrations');
  revalidatePath(`/director/registrations/${registration.id}`);

  return {
    message:
      mail.status === 'SENT'
        ? 'Rejected, and the applicant has been emailed the reason.'
        : 'Rejected. The email did not go out — tell them another way.',
  };
}

/**
 * Re-run the rules against an application that has already confirmed its address.
 *
 * The reason a director needs this: the rules are data, so the answer to "why was
 * this not auto-approved?" is often "the rule was disabled at the time". Fixing
 * the rule should not mean asking the applicant for another confirmation link,
 * and `decideAndApply` is the same function the link itself calls — including the
 * provisioning transaction when the answer comes back AUTO_APPROVED.
 */
export async function reevaluateRegistrationAction(
  _prev: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  await requireRole('DIRECTOR', 'ADMIN');

  const id = String(formData.get('registrationId') ?? '');
  if (!id) return { error: 'No application named.' };

  const registration = await prisma.registration.findUnique({
    where: { id },
    select: { emailVerifiedAt: true, approvedStudentId: true },
  });
  if (!registration) return { error: 'That application no longer exists.' };
  if (registration.approvedStudentId) {
    return { error: 'That application has already produced a student record.' };
  }
  if (!registration.emailVerifiedAt) {
    return {
      error: 'That address has not been confirmed yet, so no rule can be applied to it. Approve it by hand or wait for the link.',
    };
  }

  const outcome = await decideAndApply(id, new Date());

  revalidatePath('/director/registrations');
  revalidatePath(`/director/registrations/${id}`);

  return { message: outcome.message };
}

/**
 * A director editing the rules, in the two ways that are safe from a form.
 *
 * `enabled` and `autoApprove` are the switches the admissions office actually
 * turns between intakes — "stop auto-admitting for now", "route this domain to a
 * human". The regex and the domain string are deliberately *not* editable here:
 * a mistyped `usnPattern` silently stops matching, and the place to change one is
 * with the migration or the seed that explains what it means, not a text box on a
 * queue screen. The values themselves live in `RegistrationRule` either way —
 * never in a component and never in an env var.
 */
export async function toggleRuleAction(
  _prev: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  await requireRole('DIRECTOR', 'ADMIN');

  const id = String(formData.get('ruleId') ?? '');
  const field = String(formData.get('field') ?? '');
  if (!id || (field !== 'enabled' && field !== 'autoApprove')) {
    return { error: 'That is not a switch on a registration rule.' };
  }

  const rule = await prisma.registrationRule.findUnique({
    where: { id },
    select: { id: true, name: true, enabled: true, autoApprove: true },
  });
  if (!rule) return { error: 'That rule no longer exists.' };

  const next = !rule[field];
  await prisma.registrationRule.update({ where: { id: rule.id }, data: { [field]: next } });

  revalidatePath('/director/registrations');

  return {
    message:
      field === 'enabled'
        ? `“${rule.name}” is now ${next ? 'in use' : 'switched off'}. Applications already decided are unaffected.`
        : `“${rule.name}” now ${next ? 'approves matches automatically' : 'sends matches to this queue'}.`,
  };
}
