'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { retryAfterSeconds } from '@/lib/rate-limit';
import { submitApplication } from '@/lib/registration/intake';
import { clientKey, registrationSubmitLimiter } from '@/lib/registration/limits';
import { isQuarantineToken } from '@/lib/registration/quarantine';
import {
  REGISTRATION_FIELDS,
  parseRegistrationInput,
  type RegistrationField,
} from '@/lib/registration/schema';

/**
 * The self-filed application, submitted.
 *
 * A Server Action is a public POST endpoint — the Next docs are explicit that
 * rendering a form on a page is not a security boundary — and this one has no
 * session behind it at all, so every line of the guard is here rather than in
 * the component:
 *
 *  1. A ceiling per IP, checked first, because everything after it costs.
 *  2. `parseRegistrationInput`, which is the *only* thing that decides what the
 *     payload contains. It names nine fields and `z.object` strips the rest, so
 *     a POST carrying `role`, `cohortId` or `status` loses them here — see the
 *     docblock in `schema.ts`.
 *  3. The upload token is checked for shape and never used as a path. An
 *     applicant who edits it points at nothing; they do not point at somewhere
 *     else on disk.
 *
 * The action returns field-keyed errors rather than throwing, and the form is
 * controlled client-side, for the reason `profile-form.tsx` records: React
 * resets uncontrolled inputs when an action returns, so a returned error would
 * otherwise wipe eleven boxes to complain about one of them.
 */
export type RegisterState = {
  /// Keyed by field, rendered under the box it belongs to.
  errors?: Partial<Record<RegistrationField, string>>;
  /// Everything that is not about one field: a duplicate address, a rate limit.
  error?: string;
};

export async function submitRegistrationAction(
  _prev: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const now = new Date();

  const requestHeaders = await headers();
  const verdict = registrationSubmitLimiter.check(clientKey(requestHeaders, 'reg-submit'), now.getTime());
  if (!verdict.allowed) {
    const minutes = Math.ceil(retryAfterSeconds(verdict, now.getTime()) / 60);
    return {
      error: `Several applications have already been sent from this connection. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, or ring the programme office.`,
    };
  }

  const raw = Object.fromEntries(
    REGISTRATION_FIELDS.map((field) => [field, String(formData.get(field) ?? '')]),
  );

  const parsed = parseRegistrationInput(raw);
  if (!parsed.ok) return { errors: parsed.errors };

  const tokenField = String(formData.get('uploadToken') ?? '').trim();
  const uploadToken = isQuarantineToken(tokenField) ? tokenField : null;

  const result = await submitApplication({ input: parsed.value, uploadToken, now });
  if (!result.ok) return { error: result.error };

  // `redirect` throws, so nothing below it runs. The address travels in the
  // query string because the confirmation page has no session to read it from;
  // it is the applicant's own address and the page re-validates it before
  // showing it back.
  redirect(
    `/register/submitted?to=${encodeURIComponent(result.email)}${result.mailSent ? '' : '&mail=failed'}`,
  );
}
