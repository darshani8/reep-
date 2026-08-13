import { describe, expect, it } from 'vitest';

import {
  RECOMMENDATION_COUNT,
  type CatalogueSkill,
  type RecommenderJob,
  demandBySlug,
  isOpenJob,
  recommendSkills,
} from './recommend';

/**
 * Every date here is built from parts and every call is given an explicit
 * `asOf`, because "open" is the one input that would otherwise be read from the
 * machine clock — and a recommender whose answers change at midnight is not the
 * deterministic one this module claims to be.
 */
const ASOF = new Date(2026, 7, 11);

const CATALOGUE: CatalogueSkill[] = [
  { slug: 'excel', name: 'Microsoft Excel', category: 'Spreadsheets & Tools' },
  { slug: 'pivot-tables', name: 'PivotTables', category: 'Spreadsheets & Tools' },
  { slug: 'sql', name: 'SQL', category: 'Data & Analytics' },
  { slug: 'power-bi', name: 'Power BI', category: 'Data & Analytics' },
  { slug: 'public-speaking', name: 'Public Speaking', category: 'Communication' },
  { slug: 'negotiation', name: 'Negotiation', category: 'Marketing & Sales' },
  { slug: 'payroll', name: 'Payroll', category: 'People & HR' },
  { slug: 'kite-flying', name: 'Kite Flying', category: 'Recreational Aerodynamics' },
];

function job(partial: Partial<RecommenderJob> & { requiredSkills: string[] }): RecommenderJob {
  return { degreeLevel: 'PG', closesOn: null, ...partial };
}

describe('RECOMMENDATION_COUNT', () => {
  it('is five', () => {
    // The panel's height is designed around this, and both the landing page and
    // /student/skilling take the default rather than passing their own.
    expect(RECOMMENDATION_COUNT).toBe(5);
  });
});

describe('isOpenJob', () => {
  it('treats a posting with no closing date as open', () => {
    expect(isOpenJob(job({ requiredSkills: [] }), ASOF)).toBe(true);
  });

  it('keeps a posting that closes today', () => {
    // Inclusive on purpose: a vacancy closing this evening is still one a
    // student can apply for this afternoon.
    expect(isOpenJob(job({ requiredSkills: [], closesOn: ASOF }), ASOF)).toBe(true);
  });

  it('drops a posting that has already closed', () => {
    const closed = job({ requiredSkills: [], closesOn: new Date(2026, 7, 10) });
    expect(isOpenJob(closed, ASOF)).toBe(false);
  });
});

describe('demandBySlug', () => {
  it('counts a slug once per posting however often the sheet repeats it', () => {
    const counts = demandBySlug(
      [job({ requiredSkills: ['excel', 'excel', 'excel'] })],
      'PG',
      ASOF,
    );
    expect(counts.get('excel')).toBe(1);
  });

  it('ignores postings at the other degree level', () => {
    const counts = demandBySlug(
      [
        job({ requiredSkills: ['sql'], degreeLevel: 'PG' }),
        job({ requiredSkills: ['sql'], degreeLevel: 'UG' }),
      ],
      'PG',
      ASOF,
    );
    expect(counts.get('sql')).toBe(1);
  });

  it('ignores postings that have closed', () => {
    const counts = demandBySlug(
      [job({ requiredSkills: ['sql'], closesOn: new Date(2026, 6, 1) })],
      'PG',
      ASOF,
    );
    expect(counts.get('sql')).toBeUndefined();
  });
});

describe('recommendSkills', () => {
  const base = {
    catalogue: CATALOGUE,
    heldSlugs: [] as string[],
    degreeLevel: 'PG' as const,
    stage: 'EXCEL' as const,
    asOf: ASOF,
  };

  it('returns at most RECOMMENDATION_COUNT rows', () => {
    const out = recommendSkills({ ...base, jobs: [] });
    expect(out).toHaveLength(RECOMMENDATION_COUNT);
  });

  it('never suggests a skill the student already holds, verified or not', () => {
    const out = recommendSkills({
      ...base,
      heldSlugs: ['excel', 'sql', 'power-bi'],
      jobs: [job({ requiredSkills: ['excel', 'sql', 'power-bi'] })],
    });
    expect(out.map((r) => r.slug)).not.toContain('excel');
    expect(out.map((r) => r.slug)).not.toContain('sql');
    expect(out.map((r) => r.slug)).not.toContain('power-bi');
  });

  it('ranks by how many open postings ask for the skill', () => {
    const out = recommendSkills({
      ...base,
      jobs: [
        job({ requiredSkills: ['sql', 'power-bi'] }),
        job({ requiredSkills: ['sql', 'negotiation'] }),
        job({ requiredSkills: ['sql'] }),
        job({ requiredSkills: ['power-bi'] }),
      ],
    });

    expect(out[0]).toMatchObject({ slug: 'sql', demandCount: 3 });
    expect(out[1]).toMatchObject({ slug: 'power-bi', demandCount: 2 });
    expect(out[2]).toMatchObject({ slug: 'negotiation', demandCount: 1 });
  });

  it('breaks a demand tie with the stage the student is standing in', () => {
    // Both asked for once, so the count settles nothing. EXCEL lists
    // Spreadsheets & Tools first and does not list Data & Analytics at all.
    const out = recommendSkills({
      ...base,
      stage: 'EXCEL',
      jobs: [job({ requiredSkills: ['pivot-tables'] }), job({ requiredSkills: ['sql'] })],
    });

    expect(out.map((r) => r.slug).slice(0, 2)).toEqual(['pivot-tables', 'sql']);
  });

  it('reverses that tie for a stage with the opposite focus', () => {
    const out = recommendSkills({
      ...base,
      stage: 'EXCEL_ADVANCED',
      jobs: [job({ requiredSkills: ['pivot-tables'] }), job({ requiredSkills: ['sql'] })],
    });

    expect(out.map((r) => r.slug).slice(0, 2)).toEqual(['sql', 'pivot-tables']);
  });

  describe('with no jobs on the board at all', () => {
    // The fresh-install case, and the one most likely to ship broken: every
    // demand count is zero, so the ranking has to survive on stage relevance
    // alone rather than returning nothing.
    const out = recommendSkills({ ...base, stage: 'EXCEL', jobs: [] });

    it('still returns a full list', () => {
      expect(out).toHaveLength(RECOMMENDATION_COUNT);
    });

    it('leads with the categories the current stage is about', () => {
      expect(out.slice(0, 2).map((r) => r.slug)).toEqual(['excel', 'pivot-tables']);
      expect(out.slice(0, 2).every((r) => r.stageRelevant)).toBe(true);
    });

    it('says so rather than claiming a demand it cannot see', () => {
      expect(out[0].demandCount).toBe(0);
      expect(out[0].reason).toBe('Central to the Excel stage');
    });

    it('still fills the list from off-stage categories when the stage runs out', () => {
      // EXCEL names three categories; the fixture holds fewer skills in them
      // than five, so the tail has to come from somewhere.
      expect(out).toHaveLength(RECOMMENDATION_COUNT);
      expect(out.some((r) => !r.stageRelevant)).toBe(true);
    });
  });

  it('treats a category nobody has heard of as merely off-stage', () => {
    const out = recommendSkills({
      ...base,
      jobs: [job({ requiredSkills: ['kite-flying'] })],
    });

    // Demand still wins, so it leads — but it is not claimed as stage work.
    expect(out[0]).toMatchObject({ slug: 'kite-flying', stageRelevant: false });
    expect(out[0].reason).toBe('1 open PG posting asks for it');
  });

  it('is deterministic regardless of the order the catalogue arrives in', () => {
    const jobs = [job({ requiredSkills: ['sql'] }), job({ requiredSkills: ['power-bi'] })];
    const forwards = recommendSkills({ ...base, jobs });
    const backwards = recommendSkills({
      ...base,
      catalogue: [...CATALOGUE].reverse(),
      jobs,
    });

    expect(backwards.map((r) => r.slug)).toEqual(forwards.map((r) => r.slug));
  });

  it('pluralises the reason for a single posting', () => {
    const out = recommendSkills({ ...base, jobs: [job({ requiredSkills: ['negotiation'] })] });
    const negotiation = out.find((r) => r.slug === 'negotiation');
    expect(negotiation?.reason).toBe('1 open PG posting asks for it');
  });

  it('returns nothing rather than throwing when the catalogue is empty', () => {
    // A brand-new database has no skills seeded, and the panel has to render.
    expect(recommendSkills({ ...base, catalogue: [], jobs: [] })).toEqual([]);
  });
});
