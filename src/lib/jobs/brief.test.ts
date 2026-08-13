import { describe, expect, it } from 'vitest';

import { defaultResumeTitle, jobBrief } from './brief';

const NAMES = new Map([
  ['excel', 'Microsoft Excel'],
  ['sql', 'SQL'],
]);

const JOB = {
  title: 'Business Analyst',
  company: 'Wipro',
  location: 'Bengaluru',
  description: 'Building dashboards for the operations desk.',
  requiredSkills: ['sql', 'excel'],
};

describe('jobBrief', () => {
  it('leads with the role, company and place, which the description alone drops', () => {
    expect(jobBrief(JOB, NAMES).split('\n\n')[0]).toBe('Business Analyst at Wipro — Bengaluru');
  });

  it('names the skills instead of handing the generator slugs', () => {
    expect(jobBrief(JOB, NAMES)).toContain('Skills the posting asks for: SQL, Microsoft Excel.');
  });

  it('titleises a slug the catalogue does not carry rather than dropping the requirement', () => {
    expect(jobBrief({ ...JOB, requiredSkills: ['loan-origination'] }, NAMES)).toContain(
      'Loan Origination',
    );
  });

  it('composes a usable brief for a posting with no description at all', () => {
    const brief = jobBrief({ ...JOB, description: '' }, NAMES);
    expect(brief).toBe('Business Analyst at Wipro — Bengaluru\n\nSkills the posting asks for: SQL, Microsoft Excel.');
  });

  it('leaves out the skills line entirely when the posting lists none', () => {
    expect(jobBrief({ ...JOB, requiredSkills: [] }, NAMES)).not.toContain('Skills the posting');
  });

  it('works with no catalogue at all', () => {
    expect(jobBrief(JOB)).toContain('Sql, Excel');
  });

  it('omits a missing location rather than leaving a dangling dash', () => {
    expect(jobBrief({ ...JOB, location: null }, NAMES).split('\n\n')[0]).toBe(
      'Business Analyst at Wipro',
    );
  });
});

describe('defaultResumeTitle', () => {
  it('names the version after the posting it was written for', () => {
    expect(defaultResumeTitle(JOB)).toBe('Business Analyst — Wipro');
  });
});
