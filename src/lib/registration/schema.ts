/**
 * What an applicant is allowed to say about themselves.
 *
 * This is the app's first *unauthenticated* write surface. Everywhere else a
 * session cookie has already answered "who is this?" before a form is parsed,
 * so a stray field in a payload is at worst a signed-in user editing their own
 * row. Here there is no session, and the shape of this object is the entire
 * boundary between a stranger and the `registrations` table.
 *
 * Three fields are therefore *absent by design*, not merely unhandled:
 * `role`, `cohortId` and `status`. `z.object` strips keys it does not name, so
 * a POST that carries `role=ADMIN` or `status=AUTO_APPROVED` loses them here
 * rather than being caught downstream — which is the difference between a rule
 * and a habit. A cohort is assigned by a matched rule or by a reviewer; a status
 * is decided by `rules.ts` after the address has been proven; a role is not an
 * applicant's to propose. If a field ever needs adding, add it to the object,
 * never to the caller's spread.
 *
 * No `server-only` and no imports beyond zod, because the same validation has to
 * run in three places: the Server Action behind `/register`, the CV mapper that
 * proposes values for these fields from an uploaded document, and the tests. A
 * mapper that could produce a value the form would reject is a mapper that
 * fills a box the applicant then cannot submit.
 */

import { z } from 'zod';

import type { DegreeLevel } from '@prisma/client';

/// The two values `Registration.degreeLevel` accepts. Kept as a literal tuple
/// because zod needs them at runtime and a Prisma enum is a type at compile
/// time only; `DEGREE_LEVEL_CHECK` below is what keeps the two from drifting.
export const DEGREE_LEVELS = ['UG', 'PG'] as const;

/// Compile-time only. If a migration ever adds a third degree level, this line
/// stops typechecking and the tuple above has to be updated with it.
const DEGREE_LEVEL_CHECK: readonly DegreeLevel[] = DEGREE_LEVELS;
void DEGREE_LEVEL_CHECK;

/**
 * The trailing part of a LinkedIn profile URL we are willing to store.
 *
 * Deliberately narrow. `StudentProfile.linkedinUrl` is rendered as a link on a
 * resume and on the mentor's view of a student, so an applicant-supplied string
 * that reaches an `href` has to be a URL we chose the shape of — `javascript:`,
 * a data URI and a link to an unrelated site are all refused by construction
 * rather than by a blocklist. Handles allow the dash and the dot that LinkedIn
 * itself permits, plus the numeric suffix it appends to duplicates.
 */
const LINKEDIN_HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,98}[A-Za-z0-9])?$/;

/**
 * Normalise whatever the applicant pasted into one canonical profile URL.
 *
 * People paste four things: the bare handle, `linkedin.com/in/handle`,
 * `https://www.linkedin.com/in/handle/` and the same with a tracking query. All
 * four mean the same profile, so all four normalise to the same stored string —
 * otherwise the same person registering twice looks like two people, and a
 * reviewer comparing an application against a CV sees a difference that is only
 * punctuation. Returns `null` when it is not a LinkedIn profile at all.
 */
export function normaliseLinkedinUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip a scheme and host if present, then everything after the handle. The
  // regional hosts (`in.linkedin.com`, `www.linkedin.com`) are the same site.
  const withoutScheme = trimmed.replace(/^https?:\/\//i, '');
  const match = withoutScheme.match(
    /^(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/(?:in|pub)\/([^/?#\s]+)/i,
  );

  const handle = match ? decodeURIComponent(match[1]) : withoutScheme;

  // A bare handle is accepted, but only once it is certain it is not a half-typed
  // URL for somewhere else — `example.com/me` must not become a LinkedIn link.
  if (!match && /[/\s]|\.[a-z]{2,}$/i.test(handle)) return null;
  if (!LINKEDIN_HANDLE.test(handle)) return null;

  return `https://www.linkedin.com/in/${handle}`;
}

/**
 * Phone numbers, kept in one shape.
 *
 * Applicants type `+91 98860 41125`, `098860-41125` and `9886041125` for the
 * same number. The programme office rings it, so what matters is that the digits
 * survive and that two spellings of one number compare equal; the pretty
 * spacing does not. A leading `+` is kept because it is the only part of the
 * formatting that carries information.
 */
export function normalisePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const plus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  // 8 is the shortest national number in use anywhere; 15 is the E.164 ceiling.
  if (digits.length < 8 || digits.length > 15) return null;
  return plus ? `+${digits}` : digits;
}

const name = z
  .string()
  .trim()
  .min(2, 'Give your full name as it appears on your admission record.')
  .max(80, 'That name is longer than the 80 characters we can store.')
  .refine((value) => /\p{L}/u.test(value), 'A name has to contain at least one letter.');

const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'We need an email address to confirm this application.')
  .max(160, 'That address is longer than the 160 characters we can store.')
  .pipe(z.email('That does not look like an email address.'));

const phone = z
  .string()
  .trim()
  .min(1, 'Give a phone number the programme office can reach you on.')
  .transform(normalisePhone)
  .refine(
    (value): value is string => value !== null,
    'That does not look like a phone number. Include the country code if it is not Indian.',
  );

/**
 * The USN, when there is one.
 *
 * Optional and it must stay optional: an applicant holding an admission offer
 * has not been issued a number yet, and requiring one would mean either turning
 * them away or teaching them to invent one. Its absence is a fact `rules.ts`
 * reads — no USN means no programme evidence, which means a human looks.
 */
const usn = z
  .string()
  .trim()
  .toUpperCase()
  .max(20, 'A USN is at most 20 characters.')
  .refine(
    (value) => value === '' || /^[A-Z0-9]{6,20}$/.test(value),
    'A USN is 6 to 20 letters and digits, e.g. 1BG24MBA001.',
  )
  .transform((value) => (value === '' ? undefined : value))
  .optional();

const linkedinUrl = z
  .string()
  .trim()
  .max(300)
  .transform((value) => (value === '' ? undefined : normaliseLinkedinUrl(value)))
  .refine(
    (value) => value !== null,
    'Paste your LinkedIn profile link, e.g. linkedin.com/in/your-handle.',
  )
  .transform((value) => value ?? undefined)
  .optional();

/**
 * The applicant's own account of which programme they are joining.
 *
 * Held separately from `degreeLevel` because UG/PG is the only part of it the
 * `registrations` table has a column for. The pair is what a reviewer reads on
 * the queue, and what `rules.ts` cross-checks against the USN — an applicant who
 * writes "MBA" but holds a BBA number has made a mistake worth a human's
 * attention rather than an auto-approval.
 */
const programme = z
  .string()
  .trim()
  .toUpperCase()
  .min(2, 'Which programme are you joining? For example, MBA.')
  .max(40, 'Use the short form of the programme name, e.g. MBA.');

const branch = z
  .string()
  .trim()
  .min(2, 'Which specialisation or branch?')
  .max(60, 'That branch name is longer than the 60 characters we can store.');

const city = z
  .string()
  .trim()
  .min(2, 'Which city are you in?')
  .max(60, 'That city name is longer than the 60 characters we can store.');

/**
 * The self-filed application form.
 *
 * Every key here is something the applicant is entitled to assert about
 * themselves. Nothing here decides anything: the address is a *claim* until the
 * verification link is clicked, and only then does `rules.ts` get to read it.
 */
export const registrationInputSchema = z.object({
  name,
  email,
  phone,
  degreeLevel: z.enum(DEGREE_LEVELS, 'Choose whether this is an undergraduate or postgraduate programme.'),
  programme,
  branch,
  usn,
  linkedinUrl,
  city,
});

/// A validated application, straight from the form or proposed by the CV mapper.
export type RegistrationInput = z.infer<typeof registrationInputSchema>;

/// The keys the form and the CV mapper agree on, so neither can invent a field
/// the other has never heard of.
export const REGISTRATION_FIELDS = [
  'name',
  'email',
  'phone',
  'degreeLevel',
  'programme',
  'branch',
  'usn',
  'linkedinUrl',
  'city',
] as const satisfies readonly (keyof RegistrationInput)[];

export type RegistrationField = (typeof REGISTRATION_FIELDS)[number];

/// Human labels, used both by the form and by the "we could not fill these"
/// list the CV upload hands back.
export const REGISTRATION_FIELD_LABEL: Record<RegistrationField, string> = {
  name: 'Full name',
  email: 'Email address',
  phone: 'Phone',
  degreeLevel: 'Degree level',
  programme: 'Programme',
  branch: 'Branch or specialisation',
  usn: 'USN',
  linkedinUrl: 'LinkedIn',
  city: 'City',
};

/**
 * Parse a form payload, returning the first message per field.
 *
 * The form is long enough that "one error at a time" would be a bad experience,
 * so every field's complaint comes back at once, keyed by field name — the
 * client puts each one under its own box. `FormData` values are read as strings
 * by the caller; anything absent becomes `''` and fails the field's own rule
 * rather than disappearing.
 */
export type RegistrationParseResult =
  | { ok: true; value: RegistrationInput }
  | { ok: false; errors: Partial<Record<RegistrationField, string>> };

export function parseRegistrationInput(raw: unknown): RegistrationParseResult {
  const parsed = registrationInputSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };

  const errors: Partial<Record<RegistrationField, string>> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if (typeof key !== 'string') continue;
    const field = key as RegistrationField;
    if (!REGISTRATION_FIELDS.includes(field)) continue;
    // First message wins: later issues on the same field are refinements of the
    // same mistake and repeating them under one box reads as noise.
    errors[field] ??= issue.message;
  }

  return { ok: false, errors };
}

/// Everything after the "@", lowercased — the value `RegistrationRule.emailDomain`
/// is compared against. Exported because the review queue shows it too.
export function emailDomain(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).trim().toLowerCase();
}
