/**
 * What a student should learn next, decided offline.
 *
 * "Suggested skills" is the kind of feature that reaches for a model, and this
 * one deliberately does not. Two reasons, in order of weight:
 *
 *  1. A recommendation is built from the student's held skills and their
 *     cohort's degree level. That is student data, and sending it anywhere
 *     other than loopback would have to pass `studentDataEgressAllowed()` — a
 *     gate that is off by default, which means the panel would be blank on a
 *     normal install. A blank panel is not a feature.
 *  2. The honest ranking is a count. The jobs sheet already says, in numbers,
 *     which skills the market in front of this cohort is asking for; a model
 *     asked to re-derive that would only add variance to an answer we can read
 *     off the board exactly.
 *
 * So the whole thing is a sort, and it lives in a module with no `server-only`
 * import and no Prisma import — the same split as `activity-rules.ts` against
 * `activity-log.ts`. Rows in, rows out, testable from a bare Node process, and
 * callable from a Server Component, a Route Handler or a script alike.
 *
 * The ranking is: **demand first, stage second.** Frequency across the open
 * postings for the student's degree level decides the order; where two skills
 * are equally in demand — and with no jobs on the board at all, that is every
 * skill — the stage the student is currently in breaks the tie. Slug breaks
 * whatever is left, so the same inputs always produce the same five in the same
 * order regardless of the order the catalogue arrived in.
 */

import type { DegreeLevel, Stage } from '@prisma/client';

import { STAGE_LABEL } from '../reep';

/// Five. The panel is a sidebar on the landing page and a column on
/// `/student/skilling`; a list long enough to scroll there reads as a backlog
/// rather than as a suggestion, and nobody acts on a backlog.
export const RECOMMENDATION_COUNT = 5;

/// One row of the `Skill` catalogue, narrowed to the fields the ranking reads.
export type CatalogueSkill = {
  slug: string;
  name: string;
  category: string;
};

/// One `Job` row, narrowed the same way. `closesOn` is nullable because a
/// posting with no stated deadline is open until somebody says otherwise.
export type RecommenderJob = {
  degreeLevel: DegreeLevel;
  requiredSkills: string[];
  closesOn: Date | null;
};

export type SkillRecommendation = {
  slug: string;
  name: string;
  category: string;
  /// How many open postings at the student's degree level ask for this skill.
  /// Zero is a normal value, not a missing one — see the no-jobs case below.
  demandCount: number;
  /// Whether this skill's category is one the student's current stage is about.
  stageRelevant: boolean;
  /// One line the panel can print under the name. Written here rather than in
  /// the component so the reason and the ranking cannot drift apart.
  reason: string;
};

export type RecommendationInput = {
  catalogue: CatalogueSkill[];
  /// `Skill.slug` values the student already holds — a `StudentSkill` row of any
  /// kind, verified or not. A skill you have declared is not a skill to suggest,
  /// even before a mentor has looked at the evidence.
  heldSlugs: Iterable<string>;
  jobs: RecommenderJob[];
  degreeLevel: DegreeLevel;
  stage: Stage;
  /// The clock, passed in rather than read, so a test can pin "open" and so two
  /// callers rendering the same page agree on it.
  asOf: Date;
  count?: number;
};

/**
 * The categories each stage is about, most characteristic first.
 *
 * These are `Skill.category` strings, which are seed data rather than an enum —
 * so an unrecognised category is a possibility and is handled as "not
 * stage-relevant" rather than as an error. That degrades to ranking by demand
 * alone, which is still a useful answer; throwing here would take out the whole
 * panel because somebody added a category to the catalogue.
 */
const STAGE_FOCUS: Record<Stage, readonly string[]> = {
  // The 18-day bootcamp: how you turn up, think and work with people.
  REBOOT: ['Communication', 'Thinking & Problem Solving', 'Leadership & Teamwork'],
  // Year 1 is the Excel spine, with the finance vocabulary that goes with it.
  EXCEL: ['Spreadsheets & Tools', 'Business & Finance', 'Communication'],
  // The organizational study — analysis on real operational data.
  EXCEL_ADVANCED: [
    'Data & Analytics',
    'Spreadsheets & Tools',
    'Operations & Supply Chain',
    'Technology',
  ],
  // Year 2 is placement-facing, so it is the functional specialisms.
  ELEVATE: [
    'Business & Finance',
    'Marketing & Sales',
    'People & HR',
    'Data & Analytics',
    'Communication',
  ],
};

/// Rank inside `STAGE_FOCUS`, or a sentinel that sorts after every listed
/// category. `Infinity` rather than a large number so adding categories can
/// never accidentally overtake it.
function stageRank(stage: Stage, category: string): number {
  const index = STAGE_FOCUS[stage].indexOf(category);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

/// Whether a posting is still worth counting. A closed vacancy describes a
/// market that has already moved on, and counting it would keep recommending
/// last term's skills all year.
export function isOpenJob(job: RecommenderJob, asOf: Date): boolean {
  return job.closesOn === null || job.closesOn.getTime() >= asOf.getTime();
}

/**
 * How many open postings at this degree level ask for each skill slug.
 *
 * Exported because the catalogue browser prints the same figure beside every
 * skill, and computing it twice from two different definitions of "open" is how
 * a screen ends up contradicting itself.
 *
 * A slug is counted once per posting even if the sheet repeats it, so a
 * duplicated cell in an imported row cannot inflate a skill up the list.
 */
export function demandBySlug(
  jobs: RecommenderJob[],
  degreeLevel: DegreeLevel,
  asOf: Date,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    if (job.degreeLevel !== degreeLevel) continue;
    if (!isOpenJob(job, asOf)) continue;
    for (const slug of new Set(job.requiredSkills)) {
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The top five skills this student does not have yet.
 *
 * The no-jobs case is the one to keep working: a fresh install, a cohort at a
 * degree level the sheet has not covered yet, or a week where everything on the
 * board has closed. Every `demandCount` is then 0, the comparison falls
 * straight through to stage relevance, and the student still gets five sensible
 * suggestions for the stage they are standing in — rather than an empty panel
 * that reads as a broken feature.
 */
export function recommendSkills(input: RecommendationInput): SkillRecommendation[] {
  const { catalogue, degreeLevel, stage, asOf } = input;
  const count = input.count ?? RECOMMENDATION_COUNT;

  const held = new Set(input.heldSlugs);
  const demand = demandBySlug(input.jobs, degreeLevel, asOf);

  const scored = catalogue
    .filter((skill) => !held.has(skill.slug))
    .map((skill) => {
      const demandCount = demand.get(skill.slug) ?? 0;
      const rank = stageRank(stage, skill.category);
      return {
        skill,
        demandCount,
        rank,
        recommendation: {
          slug: skill.slug,
          name: skill.name,
          category: skill.category,
          demandCount,
          stageRelevant: Number.isFinite(rank),
          reason: reasonFor(demandCount, rank, degreeLevel, stage),
        } satisfies SkillRecommendation,
      };
    });

  scored.sort((a, b) => {
    if (a.demandCount !== b.demandCount) return b.demandCount - a.demandCount;
    if (a.rank !== b.rank) return a.rank - b.rank;
    // Last resort, and the reason the output does not depend on the order the
    // catalogue came back from the database in.
    return a.skill.slug.localeCompare(b.skill.slug);
  });

  return scored.slice(0, Math.max(0, count)).map((row) => row.recommendation);
}

const DEGREE_LABEL: Record<DegreeLevel, string> = {
  UG: 'UG',
  PG: 'PG',
};

/**
 * The sentence under the skill name.
 *
 * Demand is quoted as a count rather than a percentage on purpose. "4 open PG
 * postings ask for it" is checkable against the jobs board in a way that "high
 * demand" is not, and a student who can check a claim is a student who trusts
 * the next one.
 */
function reasonFor(
  demandCount: number,
  rank: number,
  degreeLevel: DegreeLevel,
  stage: Stage,
): string {
  if (demandCount > 0) {
    const postings = demandCount === 1 ? 'posting asks' : 'postings ask';
    return `${demandCount} open ${DEGREE_LABEL[degreeLevel]} ${postings} for it`;
  }
  if (Number.isFinite(rank)) {
    return `Central to the ${STAGE_LABEL[stage]} stage`;
  }
  return 'Widens your profile beyond what the board is asking for today';
}
