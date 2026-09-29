/**
 * Two things the register form says in words that it used to leave to a
 * status code (2026-09-29).
 *
 * `collegeEmailProblem` mirrors `_college_email_problem` in
 * `apps/api-py/app/routers/registration.py`: the college box autofilled with
 * the student's Gmail, so the office saw only that address and could never
 * approve it. The server refuses the same two cases; asking here first saves
 * the student uploading both files to be told.
 *
 * `describeValidationError` reads FastAPI's 422 list (`[{loc, msg}]`), which the
 * form used to print as "some details are not valid (422)" without saying
 * which box.
 */

/** Keep in step with PUBLIC_MAIL_DOMAINS on the server. */
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com',
  'me.com', 'rediffmail.com', 'proton.me', 'protonmail.com', 'aol.com',
]);

export function collegeEmailProblem(collegeEmail: string, personalEmail: string): string | null {
  const college = collegeEmail.trim().toLowerCase();
  const personal = personalEmail.trim().toLowerCase();
  if (!college) return null;
  if (college === personal) {
    return (
      'Your college email and personal email are the same. Enter the address your ' +
      'college gave you in the college email box.'
    );
  }
  const at = college.lastIndexOf('@');
  const domain = at === -1 ? '' : college.slice(at + 1);
  if (PUBLIC_MAIL_DOMAINS.has(domain)) {
    return (
      `${college} is a personal address. Enter the email your college gave you in ` +
      'the college email box, and your personal address in the personal email box.'
    );
  }
  return null;
}

/** The form's own name for each field the API can refuse. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: 'Full name',
  email: 'College email',
  usn: 'USN',
  phone: 'Phone',
  personal_email: 'Personal email',
  linkedin_url: 'LinkedIn profile',
  degree_level: 'Degree level',
  college_id: 'College',
  department_id: 'Department',
  course_id: 'Course',
  specialization_id: 'Specialization',
  specialization_ids: 'Specialization',
  requested_cohort_id: 'Batch',
  cv: 'CV',
  photo: 'Photo',
};

/** "LinkedIn profile: enter your LinkedIn profile link, …", one line per
 *  refused field, or null when `detail` is not FastAPI's list shape. */
export function describeValidationError(detail: unknown): string | null {
  if (!Array.isArray(detail) || detail.length === 0) return null;
  const lines: string[] = [];
  for (const item of detail) {
    if (!item || typeof item !== 'object') continue;
    const { loc, msg } = item as { loc?: unknown; msg?: unknown };
    if (typeof msg !== 'string') continue;
    // Pydantic prefixes a validator's own sentence with "Value error, ".
    const text = msg.replace(/^Value error,\s*/i, '');
    const path = Array.isArray(loc) ? loc.filter((p): p is string => typeof p === 'string') : [];
    const field = [...path].reverse().find((p) => p in FIELD_LABELS);
    const line = field ? `${FIELD_LABELS[field]}: ${text}` : text;
    if (!lines.includes(line)) lines.push(line);
  }
  return lines.length ? lines.join(' ') : null;
}
