/**
 * How well a student's skills fit a posting, decided arithmetically.
 *
 * The spec asks for "match percentage based on match between skills and JD",
 * and the tempting way to get one is to hand both to a model. This module is
 * the argument against that. A percentage a student is judged by has to be
 * explainable — "you match 62% because you hold four of the six skills this
 * posting names, and your Excel is at Working rather than Proficient" — and a
 * model gives a number nobody can reproduce, changes it between two loads of
 * the same page, and would carry the student's skill record off the machine to
 * produce it. Nothing here calls an LLM, so `studentDataEgressAllowed()` has no
 * question to answer on this path.
 *
 * Only **verified** skills score. A self-declared skill is the student's word,
 * and a percentage that counts it is telling a student they are ready for a
 * vacancy on the strength of a claim nobody has checked. They are not thrown
 * away — they are returned separately as the headroom the student gets back by
 * taking evidence to their mentor, which is a more useful thing to show than a
 * number quietly inflated by them.
 *
 * No database, no `server-only`: plain values in, plain values out, so the page
 * and the tests read the same function.
 */

/// One entry from the `Skill` catalogue. `aliases` is why the match works at
/// all — a sheet says "MS Excel" where the catalogue says `excel`.
export type CatalogueSkill = {
  slug: string;
  name: string;
  aliases: string[];
};

/// A skill the student holds, as `StudentSkill` records it.
export type HeldSkill = {
  slug: string;
  /// 1 Aware · 2 Beginner · 3 Working · 4 Proficient · 5 Expert.
  level: number;
  verified: boolean;
};

/// The two fields of a posting the match reads. Deliberately narrow, so a
/// caller cannot accidentally feed the whole `Job` row — including nothing the
/// arithmetic should depend on — into the score.
export type MatchableJob = {
  requiredSkills: string[];
  description: string;
};

/// Where the posting asked for a skill. The required list is an explicit demand;
/// a mention in the prose is a weaker signal and is weighted as one.
export type DemandSource = 'required' | 'description';

/// One skill the posting wants, and how much of the score it carries.
export type SkillDemand = {
  slug: string;
  name: string;
  source: DemandSource;
  weight: number;
};

/// A demand the student meets, with the level they meet it at.
export type MatchedSkill = SkillDemand & { level: number };

/// A coarse reading of the percentage, so every screen colours it the same way.
export type MatchBand = 'strong' | 'fair' | 'weak';

/**
 * The outcome, as a union rather than a number.
 *
 * A bare 0% is a lie in three different situations — the student has recorded
 * no skills, has recorded some but had none verified, or the posting listed no
 * requirements at all — and each of those needs the reader told something
 * different. Forcing the caller to branch is what stops the board rendering
 * "0% match" at a student who has simply not filled their profile in yet.
 */
export type JobMatch =
  | { kind: 'no-skills' }
  | { kind: 'nothing-verified'; wouldMatch: MatchedSkill[]; potentialPct: number }
  | { kind: 'no-requirements' }
  | {
      kind: 'scored';
      pct: number;
      band: MatchBand;
      matched: MatchedSkill[];
      /// Demands nothing verified covers — the gap list, worst first.
      missing: SkillDemand[];
      /// Held but unverified skills this posting asks for.
      unverified: MatchedSkill[];
      /// What the percentage would read if every one of those were verified.
      potentialPct: number;
    };

/// A named requirement counts for more than a passing mention in the prose:
/// "you will use Excel daily" and "familiarity with Tableau is a plus" are not
/// the same demand, and the required list is the only one the employer typed
/// deliberately.
const REQUIRED_WEIGHT = 1;
const MENTION_WEIGHT = 0.4;

/**
 * What each rung of the ladder is worth against a demand.
 *
 * Not linear. The gap between Aware and Working is what decides whether a
 * student can do the job at all; the gap between Proficient and Expert rarely
 * decides a campus shortlist, so the curve flattens at the top. Index 0 is
 * unused — levels are 1–5 — and out-of-range values are clamped rather than
 * trusted, because the column is a plain integer.
 */
const LEVEL_CREDIT = [0, 0.35, 0.55, 0.8, 0.95, 1] as const;

/// Above this the board says "strong"; below `FAIR_AT` it says "weak".
const STRONG_AT = 70;
const FAIR_AT = 40;

/// Anything shorter is matched by accident — "hr" inside "through" is caught by
/// the whole-token search, but a single letter is still not worth scanning for.
const MIN_PHRASE_LENGTH = 2;

export function matchBand(pct: number): MatchBand {
  if (pct >= STRONG_AT) return 'strong';
  if (pct >= FAIR_AT) return 'fair';
  return 'weak';
}

/**
 * Text reduced to a padded stream of tokens, so a phrase can be found without
 * matching the inside of a word.
 *
 * `+` and `#` survive because "c++" and "c#" are skill names; everything else
 * non-alphanumeric becomes a gap, which is what makes `power-bi`, "Power BI"
 * and "power bi" the same three characters apart.
 */
export function tokenStream(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim();
  return words ? ` ${words} ` : ' ';
}

/// The same normalisation for something being looked *for*, without the padding.
function phrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim();
}

function mentions(stream: string, needle: string): boolean {
  const target = phrase(needle);
  if (target.length < MIN_PHRASE_LENGTH) return false;
  return stream.includes(` ${target} `);
}

/// `power-bi` with no catalogue row behind it still has to print as something —
/// "Power Bi" beats showing the reader a slug.
function titleise(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Everything the posting asks for, weighted.
 *
 * The required list is taken literally — those slugs are what the importer
 * resolved against the catalogue. The description is then scanned for any
 * *other* catalogue skill, by name, alias or slug, which is what catches the
 * posting whose skills column is thin but whose prose names four tools. A skill
 * already in the required list is never counted twice.
 */
export function jobDemand(job: MatchableJob, catalogue: CatalogueSkill[]): SkillDemand[] {
  const bySlug = new Map(catalogue.map((skill) => [skill.slug, skill]));
  const demands: SkillDemand[] = [];
  const seen = new Set<string>();

  for (const raw of job.requiredSkills) {
    const slug = raw.trim().toLowerCase();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    demands.push({
      slug,
      name: bySlug.get(slug)?.name ?? titleise(slug),
      source: 'required',
      weight: REQUIRED_WEIGHT,
    });
  }

  const stream = tokenStream(job.description);
  for (const skill of catalogue) {
    if (seen.has(skill.slug)) continue;
    const spellings = [skill.name, skill.slug, ...skill.aliases];
    if (!spellings.some((spelling) => mentions(stream, spelling))) continue;
    seen.add(skill.slug);
    demands.push({
      slug: skill.slug,
      name: skill.name,
      source: 'description',
      weight: MENTION_WEIGHT,
    });
  }

  return demands;
}

function credit(level: number): number {
  const rung = Math.max(1, Math.min(LEVEL_CREDIT.length - 1, Math.round(level)));
  return LEVEL_CREDIT[rung];
}

function score(demands: SkillDemand[], held: Map<string, HeldSkill>): number {
  const total = demands.reduce((sum, demand) => sum + demand.weight, 0);
  if (total === 0) return 0;
  const earned = demands.reduce((sum, demand) => {
    const skill = held.get(demand.slug);
    return skill ? sum + demand.weight * credit(skill.level) : sum;
  }, 0);
  return Math.round((earned / total) * 100);
}

/**
 * The percentage, or the reason there is not one.
 *
 * `held` is every `StudentSkill` row, verified or not: the function needs the
 * unverified ones to be able to say what verification would buy, and taking
 * only the verified ones as input would make the empty case indistinguishable
 * from the never-filled-in case.
 */
export function matchJob(
  job: MatchableJob,
  catalogue: CatalogueSkill[],
  held: HeldSkill[],
): JobMatch {
  if (held.length === 0) return { kind: 'no-skills' };

  const demands = jobDemand(job, catalogue);
  if (demands.length === 0) return { kind: 'no-requirements' };

  const verified = new Map(held.filter((skill) => skill.verified).map((s) => [s.slug, s]));
  const everything = new Map(held.map((skill) => [skill.slug, skill]));

  const asMatched = (demand: SkillDemand, source: Map<string, HeldSkill>): MatchedSkill => ({
    ...demand,
    level: source.get(demand.slug)?.level ?? 0,
  });

  const potentialPct = score(demands, everything);

  if (verified.size === 0) {
    return {
      kind: 'nothing-verified',
      wouldMatch: demands
        .filter((demand) => everything.has(demand.slug))
        .map((demand) => asMatched(demand, everything)),
      potentialPct,
    };
  }

  const matched = demands
    .filter((demand) => verified.has(demand.slug))
    .map((demand) => asMatched(demand, verified));

  const unverified = demands
    .filter((demand) => !verified.has(demand.slug) && everything.has(demand.slug))
    .map((demand) => asMatched(demand, everything));

  // Worst gap first: a required skill the student cannot show outranks a tool
  // the prose mentioned in passing.
  const missing = demands
    .filter((demand) => !everything.has(demand.slug))
    .sort((a, b) => b.weight - a.weight);

  const pct = score(demands, verified);

  return { kind: 'scored', pct, band: matchBand(pct), matched, missing, unverified, potentialPct };
}

/// The one line each screen prints beside the meter, and the sentence under it.
/// Both live here so the board and the CV screen cannot describe the same
/// outcome differently.
export type MatchSummary = { label: string; hint: string; band: MatchBand | null };

export function matchSummary(match: JobMatch): MatchSummary {
  switch (match.kind) {
    case 'no-skills':
      return {
        label: 'Add skills to see your match',
        hint: 'Your match is worked out from the skills on your profile. You have not added any yet.',
        band: null,
      };
    case 'nothing-verified':
      return {
        label: 'Awaiting verification',
        hint:
          match.wouldMatch.length > 0
            ? `${match.wouldMatch.length} of your skills fit this posting, but none are verified yet. Upload evidence and this would read about ${match.potentialPct}%.`
            : 'None of your skills have been verified yet, so nothing counts towards a match. Upload evidence for your mentor to check.',
        band: null,
      };
    case 'no-requirements':
      return {
        label: 'No skills listed',
        hint: 'This posting names no skills, so there is nothing to match against. Read the description and judge it yourself.',
        band: null,
      };
    case 'scored':
      return {
        label: `${match.pct}%`,
        hint:
          match.unverified.length > 0
            ? `${match.matched.length} verified skills match. ${match.unverified.length} more would take you to about ${match.potentialPct}% once verified.`
            : match.missing.length > 0
              ? `${match.matched.length} verified skills match; ${match.missing.length} are missing.`
              : 'Every skill this posting asks for is on your record and verified.',
        band: match.band,
      };
  }
}
