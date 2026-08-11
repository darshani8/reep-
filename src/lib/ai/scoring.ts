/**
 * ATS / completeness scoring.
 *
 * Two numbers with different jobs: `completeness` answers "how much of the
 * resume is filled in", `atsScore` answers "how well would a keyword screen
 * treat it". Both are weighted checklists rather than opaque scores so the
 * suggestions panel can name the exact check that failed.
 */

import { clamp } from '@/lib/reep';

import type { NormalisedProfile } from './profile';
import { resumePlainText } from './markdown';
import type {
  EvidenceClaim,
  ResumeContent,
  ResumeContext,
  ResumeScoring,
} from './resume-types';

type Check = { ok: boolean; weight: number; missing?: string; suggestion?: string };

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'our', 'are', 'will', 'that', 'this', 'have',
  'from', 'your', 'their', 'they', 'has', 'not', 'all', 'any', 'can', 'who',
  'about', 'into', 'within', 'across', 'able', 'work', 'working', 'role', 'team',
  'teams', 'good', 'strong', 'excellent', 'plus', 'must', 'should', 'would', 'other',
  'ability', 'years', 'year', 'including', 'etc', 'new', 'well', 'more', 'such',
  'looking', 'seeking', 'candidate', 'candidates', 'join', 'help', 'using', 'want',
  'need', 'apply', 'please', 'opportunity', 'responsibilities', 'requirements',
]);

/// Distinct meaningful words a screener is likely to grep for.
function keywords(text: string, limit = 30): string[] {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9+#.]+/)) {
    const word = raw.replace(/^[.]+|[.]+$/g, '');
    if (word.length < 4 || STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

export function scoreResume(args: {
  content: ResumeContent;
  context: ResumeContext;
  profile: NormalisedProfile;
  claims: EvidenceClaim[];
  targetRole: string;
  targetIndustry: string;
  jobDescription?: string | null;
}): ResumeScoring {
  const { content, context, profile, claims, targetRole, targetIndustry } = args;
  const { completedCerts, inProgressCerts, attendancePct, focus } = context;

  const checks: Check[] = [
    {
      ok: Boolean(content.header.email && content.header.phone),
      weight: 12,
      missing: 'Contact details incomplete — add a phone number and email on your profile',
      suggestion: 'Recruiters filter out resumes with no reachable phone number. Add one in Profile.',
    },
    {
      ok: Boolean(
        content.header.linkedinUrl || content.header.githubUrl || content.header.portfolioUrl,
      ),
      weight: 5,
      missing: 'No LinkedIn, GitHub or portfolio link',
      suggestion: 'Add a LinkedIn URL — most campus recruiters check it before the interview.',
    },
    {
      ok: content.summary.length >= 120,
      weight: 8,
      missing: 'Professional summary is thin',
      suggestion: 'Write a two-line career summary in Profile so the opening paragraph reads in your own voice.',
    },
    {
      ok: content.education.length > 0,
      weight: 12,
      missing: 'No education entries',
      suggestion: 'Add your undergraduate degree and scores in Profile — REEP only knows about the MBA.',
    },
    {
      ok: content.experience.length > 0,
      weight: 16,
      missing: 'No work experience recorded',
      suggestion: 'Add internships, part-time work or family-business roles in Profile; even short stints beat an empty section.',
    },
    {
      ok: content.projects.length > 0,
      weight: 14,
      missing: 'No projects added',
      suggestion: 'Add two projects with the tools you used — for a fresher this section usually carries the interview.',
    },
    {
      ok: completedCerts.length >= 3,
      weight: 20,
      missing:
        completedCerts.length === 0
          ? 'No certifications completed yet'
          : `Only ${completedCerts.length} certification${completedCerts.length === 1 ? '' : 's'} completed`,
      suggestion: 'Finishing three certifications gives the resume a credible skills spine.',
    },
    {
      ok: content.skills.tools.length >= 4,
      weight: 8,
      missing: 'Fewer than four declared tools or skills',
      suggestion: 'List the tools you actually use (Excel, SQL, Power BI, Tally…) in Profile — keyword screens look for exactly these.',
    },
    {
      ok: attendancePct >= 85,
      weight: 5,
      missing: `Attendance at ${attendancePct.toFixed(0)}% is below the 85% placement threshold`,
      suggestion: 'Attendance is quoted on the REEP record; bring it above 85% before applying.',
    },
  ];

  const totalWeight = checks.reduce((sum, c) => sum + c.weight, 0);
  const completeness = clamp(
    (checks.reduce((sum, c) => sum + (c.ok ? c.weight : 0), 0) / totalWeight) * 100,
  );

  // Keyword coverage: against the pasted JD when there is one, otherwise
  // against the target role and industry the student typed.
  const haystack = resumePlainText(content);
  const wanted = keywords(
    args.jobDescription && args.jobDescription.trim().length > 40
      ? args.jobDescription
      : `${targetRole} ${targetIndustry}`,
    args.jobDescription ? 30 : 8,
  );
  const matched = wanted.filter((word) => haystack.includes(word));
  const keywordCoverage = wanted.length === 0 ? 60 : (matched.length / wanted.length) * 100;

  // How much of what the resume says is actually cited. A resume full of
  // uncited prose is exactly what this feature exists to prevent.
  const citedClaims = claims.filter((c) => c.evidenceIds.length > 0).length;
  const evidenceDensity = claims.length === 0 ? 0 : (citedClaims / claims.length) * 100;

  const atsScore = Math.round(
    clamp(0.55 * completeness + 0.3 * keywordCoverage + 0.15 * evidenceDensity),
  );

  const missing = checks.filter((c) => !c.ok && c.missing).map((c) => c.missing as string);
  const suggestions = checks
    .filter((c) => !c.ok && c.suggestion)
    .map((c) => c.suggestion as string);

  if (inProgressCerts.length > 0) {
    suggestions.unshift(
      `${inProgressCerts.length} certification${inProgressCerts.length === 1 ? ' is' : 's are'} still in progress — finishing ${inProgressCerts.length === 1 ? 'it' : 'them'} adds ${inProgressCerts
        .reduce((sum, c) => sum + c.cert.requiredHours, 0)
        .toFixed(0)} certified hours to this resume.`,
    );
  }

  if (args.jobDescription && args.jobDescription.trim().length > 40) {
    const gaps = wanted.filter((word) => !haystack.includes(word)).slice(0, 6);
    if (gaps.length > 0) {
      suggestions.push(
        `The job description leans on terms this resume never uses: ${gaps.join(', ')}. Only add the ones you can honestly evidence.`,
      );
    }
  }

  if (focus.focusScore < 50 && focus.totalSessions > 0) {
    suggestions.push(
      `Lab focus score is ${focus.focusScore.toFixed(0)}/100 — logged hours are not converting into certification progress, which weakens the hours claim above.`,
    );
  }

  if (profile.careerSummary === null && content.summary.length > 0) {
    suggestions.push(
      'The summary is currently machine-composed from your REEP record. Adding a career summary in Profile makes it sound like you.',
    );
  }

  return { atsScore, completeness: Math.round(completeness), missing, suggestions };
}
