/**
 * A posting, written out as the job description the resume generator reads.
 *
 * `Resume.jobDescription` already exists and `generateResume` already tailors a
 * draft to one — the CV-per-job column is therefore not a second generator but
 * a prefill, and this is the prefill. Forking the generator to teach it about
 * `Job` rows would give the product two resume writers to keep honest, which is
 * exactly one more than it can afford.
 *
 * The text is composed rather than passing `Job.description` straight through
 * because the description alone drops the two things a tailored draft leans on
 * hardest: the role and company it is aimed at, and the skill list the importer
 * resolved against the catalogue. A student pasting the posting by hand would
 * have included both.
 *
 * A job posting is public — it is on the employer's careers page — so nothing
 * here is subject to `studentDataEgressAllowed()`. The student's own record,
 * which is, is added by the generator on the other side of that gate.
 */

export type BriefJob = {
  title: string;
  company: string;
  location?: string | null;
  description: string;
  requiredSkills: string[];
};

/// Canonical slugs read as slugs. The catalogue is passed in so the brief says
/// "Microsoft Excel" where the row says `excel`; an unknown slug is titleised
/// rather than dropped, because a requirement nobody has catalogued is still a
/// requirement.
export function jobBrief(job: BriefJob, skillNames: Map<string, string> = new Map()): string {
  const heading = [
    job.title,
    job.company ? `at ${job.company}` : null,
    job.location ? `— ${job.location}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  const skills = job.requiredSkills
    .map((slug) => skillNames.get(slug) ?? titleise(slug))
    .filter(Boolean);

  return [
    heading,
    job.description.trim() || null,
    skills.length > 0 ? `Skills the posting asks for: ${skills.join(', ')}.` : null,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/// What the resume version is called when the student does not name it. Reads
/// as a filename a recruiter would understand, which is the point.
export function defaultResumeTitle(job: { title: string; company: string }): string {
  return `${job.title} — ${job.company}`;
}

function titleise(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
