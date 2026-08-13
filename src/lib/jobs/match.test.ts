import { describe, expect, it } from 'vitest';

import {
  jobDemand,
  matchBand,
  matchJob,
  matchSummary,
  tokenStream,
  type CatalogueSkill,
  type HeldSkill,
} from './match';

const CATALOGUE: CatalogueSkill[] = [
  { slug: 'excel', name: 'Microsoft Excel', aliases: ['ms excel', 'advanced excel'] },
  { slug: 'sql', name: 'SQL', aliases: ['structured query language'] },
  { slug: 'power-bi', name: 'Power BI', aliases: ['powerbi', 'microsoft power bi'] },
  { slug: 'business-writing', name: 'Business Writing', aliases: ['report writing'] },
  { slug: 'teamwork', name: 'Teamwork', aliases: ['collaboration'] },
];

const held = (
  slug: string,
  level: number,
  verified: boolean,
): HeldSkill => ({ slug, level, verified });

describe('tokenStream', () => {
  it('pads the stream so a phrase cannot match inside a word', () => {
    expect(tokenStream('Human Resources')).toBe(' human resources ');
  });

  it('keeps + and # so c++ and c# survive normalisation', () => {
    expect(tokenStream('C++ and C#')).toBe(' c++ and c# ');
  });

  it('returns a single space for text with nothing matchable in it', () => {
    expect(tokenStream('   ---  ')).toBe(' ');
  });
});

describe('jobDemand', () => {
  it('takes the required list literally, in order, without duplicates', () => {
    const demands = jobDemand(
      { requiredSkills: ['excel', 'sql', 'excel'], description: '' },
      CATALOGUE,
    );
    expect(demands.map((d) => d.slug)).toEqual(['excel', 'sql']);
    expect(demands.every((d) => d.source === 'required')).toBe(true);
  });

  it('names a required slug the catalogue does not carry, rather than printing the slug', () => {
    const [demand] = jobDemand({ requiredSkills: ['loan-origination'], description: '' }, CATALOGUE);
    expect(demand.name).toBe('Loan Origination');
  });

  it('finds a skill named only in the prose, by alias, and weights it lower', () => {
    const demands = jobDemand(
      { requiredSkills: ['excel'], description: 'Dashboards are built in PowerBI each week.' },
      CATALOGUE,
    );
    expect(demands.map((d) => d.slug)).toEqual(['excel', 'power-bi']);
    expect(demands[1].source).toBe('description');
    expect(demands[1].weight).toBeLessThan(demands[0].weight);
  });

  it('does not count a skill twice when the prose repeats the required list', () => {
    const demands = jobDemand(
      { requiredSkills: ['excel'], description: 'Advanced Excel, every day.' },
      CATALOGUE,
    );
    expect(demands).toHaveLength(1);
    expect(demands[0].source).toBe('required');
  });

  it('does not match a skill name buried inside another word', () => {
    const demands = jobDemand(
      { requiredSkills: [], description: 'The role involves MySQLite tinkering.' },
      CATALOGUE,
    );
    expect(demands).toEqual([]);
  });
});

describe('matchJob — the cases where a percentage would be a lie', () => {
  it('reports no-skills for a student who has recorded none, rather than 0%', () => {
    const match = matchJob({ requiredSkills: ['excel'], description: '' }, CATALOGUE, []);
    expect(match.kind).toBe('no-skills');
    expect(matchSummary(match).label).toBe('Add skills to see your match');
    expect(matchSummary(match).band).toBeNull();
  });

  it('reports nothing-verified when the student holds matching skills but none are verified', () => {
    const match = matchJob(
      { requiredSkills: ['excel', 'sql'], description: '' },
      CATALOGUE,
      [held('excel', 4, false), held('sql', 3, false)],
    );
    expect(match.kind).toBe('nothing-verified');
    if (match.kind !== 'nothing-verified') return;
    expect(match.wouldMatch.map((s) => s.slug)).toEqual(['excel', 'sql']);
    expect(match.potentialPct).toBeGreaterThan(0);
    expect(matchSummary(match).label).toBe('Awaiting verification');
  });

  it('reports no-requirements for a posting that lists and mentions nothing', () => {
    const match = matchJob(
      { requiredSkills: [], description: 'A great opportunity for a bright graduate.' },
      CATALOGUE,
      [held('excel', 5, true)],
    );
    expect(match.kind).toBe('no-requirements');
  });
});

describe('matchJob — the percentage', () => {
  it('is 100 only when every demand is verified at the top of the ladder', () => {
    const match = matchJob(
      { requiredSkills: ['excel', 'sql'], description: '' },
      CATALOGUE,
      [held('excel', 5, true), held('sql', 5, true)],
    );
    expect(match.kind).toBe('scored');
    if (match.kind !== 'scored') return;
    expect(match.pct).toBe(100);
    expect(match.band).toBe('strong');
    expect(match.missing).toEqual([]);
  });

  it('discounts a shallower level rather than treating "held" as binary', () => {
    const deep = matchJob({ requiredSkills: ['excel'], description: '' }, CATALOGUE, [
      held('excel', 5, true),
    ]);
    const shallow = matchJob({ requiredSkills: ['excel'], description: '' }, CATALOGUE, [
      held('excel', 1, true),
    ]);
    expect(deep.kind === 'scored' && deep.pct).toBe(100);
    expect(shallow.kind === 'scored' && shallow.pct).toBe(35);
  });

  it('ignores an unverified skill in the score but reports the headroom it would give', () => {
    const match = matchJob(
      { requiredSkills: ['excel', 'sql'], description: '' },
      CATALOGUE,
      [held('excel', 5, true), held('sql', 5, false)],
    );
    expect(match.kind).toBe('scored');
    if (match.kind !== 'scored') return;
    expect(match.pct).toBe(50);
    expect(match.potentialPct).toBe(100);
    expect(match.unverified.map((s) => s.slug)).toEqual(['sql']);
  });

  it('does not credit a verified skill the posting never asked for', () => {
    const match = matchJob({ requiredSkills: ['excel'], description: '' }, CATALOGUE, [
      held('excel', 3, true),
      held('teamwork', 5, true),
    ]);
    expect(match.kind === 'scored' && match.pct).toBe(80);
  });

  it('lists the gaps required-first, so the worst one reads first', () => {
    const match = matchJob(
      {
        requiredSkills: ['excel', 'sql'],
        description: 'Some report writing is involved.',
      },
      CATALOGUE,
      [held('teamwork', 3, true)],
    );
    expect(match.kind).toBe('scored');
    if (match.kind !== 'scored') return;
    expect(match.missing.map((d) => d.slug)).toEqual(['excel', 'sql', 'business-writing']);
    expect(match.pct).toBe(0);
    expect(match.band).toBe('weak');
  });

  it('lets a prose-only mention move the number less than a listed requirement', () => {
    const listed = matchJob(
      { requiredSkills: ['excel', 'power-bi'], description: '' },
      CATALOGUE,
      [held('excel', 5, true)],
    );
    const mentioned = matchJob(
      { requiredSkills: ['excel'], description: 'Some Power BI exposure helps.' },
      CATALOGUE,
      [held('excel', 5, true)],
    );
    expect(listed.kind === 'scored' && listed.pct).toBe(50);
    expect(mentioned.kind === 'scored' && mentioned.pct).toBe(71);
  });

  it('clamps a level outside the 1-5 ladder instead of trusting the column', () => {
    const match = matchJob({ requiredSkills: ['excel'], description: '' }, CATALOGUE, [
      held('excel', 99, true),
    ]);
    expect(match.kind === 'scored' && match.pct).toBe(100);
  });
});

describe('matchBand', () => {
  it('splits at the two thresholds the screens colour by', () => {
    expect(matchBand(100)).toBe('strong');
    expect(matchBand(70)).toBe('strong');
    expect(matchBand(69)).toBe('fair');
    expect(matchBand(40)).toBe('fair');
    expect(matchBand(39)).toBe('weak');
    expect(matchBand(0)).toBe('weak');
  });
});
