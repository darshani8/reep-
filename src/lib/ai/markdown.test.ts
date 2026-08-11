import { describe, expect, it } from 'vitest';

import { makeResumeContent } from '../../../test/fixtures';
import { renderResumeMarkdown, resumePlainText } from './markdown';

describe('renderResumeMarkdown', () => {
  it('always leads with the name as an H1', () => {
    const md = renderResumeMarkdown(makeResumeContent());

    expect(md.startsWith('# Asha Nair')).toBe(true);
  });

  it('ends with exactly one trailing newline', () => {
    const md = renderResumeMarkdown(makeResumeContent());

    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  it('never leaves a run of blank lines, whatever is omitted', () => {
    const md = renderResumeMarkdown(
      makeResumeContent({
        summary: 'A summary.',
        skills: { technical: ['SQL'], professional: [], tools: [] },
      }),
    );

    expect(md).not.toMatch(/\n{3,}/);
  });

  it('omits a section entirely rather than printing an empty heading', () => {
    const md = renderResumeMarkdown(makeResumeContent());

    for (const heading of [
      '## Professional Summary',
      '## Education',
      '## Experience',
      '## Projects',
      '## Certifications',
      '## REEP Programme Record',
      '## Skills',
    ]) {
      expect(md).not.toContain(heading);
    }
  });

  it('joins only the contact details that exist', () => {
    const md = renderResumeMarkdown(
      makeResumeContent({
        header: {
          name: 'Asha Nair',
          usn: '1BG23MBA01',
          headline: '',
          email: 'asha@example.com',
          phone: null,
          city: 'Bengaluru',
          linkedinUrl: null,
          githubUrl: null,
          portfolioUrl: null,
        },
      }),
    );

    expect(md).toContain('Bengaluru · asha@example.com · USN 1BG23MBA01');
    expect(md).not.toContain('null');
  });

  it('always states the USN even when every other contact field is missing', () => {
    expect(renderResumeMarkdown(makeResumeContent())).toContain('USN 1BG23MBA01');
  });

  it('renders education with and without a year or score', () => {
    const md = renderResumeMarkdown(
      makeResumeContent({
        education: [
          { degree: 'MBA', institution: 'BGSCET', year: '2026', score: '8.4 CGPA', evidenceIds: [] },
          { degree: 'BBA', institution: 'Bangalore University', year: '', score: '', evidenceIds: [] },
        ],
      }),
    );

    expect(md).toContain('- **MBA** — BGSCET (2026 · 8.4 CGPA)');
    expect(md).toContain('- **BBA** — Bangalore University');
    expect(md).not.toContain('Bangalore University ()');
  });

  it('renders each experience bullet as its own list item', () => {
    const md = renderResumeMarkdown(
      makeResumeContent({
        experience: [
          {
            title: 'Intern',
            org: 'Acme',
            period: 'Jun–Aug 2026',
            bullets: [
              { text: 'Did a thing.', evidenceIds: [] },
              { text: 'Did another thing.', evidenceIds: [] },
            ],
          },
        ],
      }),
    );

    expect(md).toContain('### Intern — Acme');
    expect(md).toContain('*Jun–Aug 2026*');
    expect(md).toContain('- Did a thing.');
    expect(md).toContain('- Did another thing.');
  });

  it('omits the dash when an experience entry has no organisation', () => {
    const md = renderResumeMarkdown(
      makeResumeContent({
        experience: [{ title: 'Freelance', org: '', period: '', bullets: [] }],
      }),
    );

    expect(md).toContain('### Freelance');
    expect(md).not.toContain('### Freelance —');
  });

  it('lists only the skill groups that have entries', () => {
    const md = renderResumeMarkdown(
      makeResumeContent({
        skills: { technical: ['SQL', 'Excel'], professional: [], tools: ['Tableau'] },
      }),
    );

    expect(md).toContain('**Technical & analytical:** SQL, Excel');
    expect(md).toContain('**Tools:** Tableau');
    expect(md).not.toContain('Professional & behavioural');
  });

  it('renders a certification with all its metadata', () => {
    const md = renderResumeMarkdown(
      makeResumeContent({
        certifications: [
          {
            name: 'Interpersonal Communication',
            provider: 'Coursera',
            hours: 20,
            completedOn: 'Mar 2026',
            courseCode: 'REE101',
            dimension: 'PROFESSIONAL',
            evidenceIds: [],
          },
        ],
      }),
    );

    expect(md).toContain('- **Interpersonal Communication** — Coursera · 20h · Mar 2026 · REE101');
  });

  it('never emits the literal text "undefined" or "null"', () => {
    const md = renderResumeMarkdown(
      makeResumeContent({
        summary: 'A summary.',
        projects: [
          { name: 'Dashboard', description: '', tech: [], link: null, evidenceIds: [] },
        ],
        reepHighlights: [{ label: 'Stage', detail: 'EXCEL', evidenceIds: [] }],
      }),
    );

    expect(md).not.toMatch(/\bundefined\b/);
    expect(md).not.toMatch(/\bnull\b/);
  });
});

describe('resumePlainText', () => {
  it('strips markdown markers so the keyword check sees words', () => {
    const text = resumePlainText(
      makeResumeContent({ summary: 'Led a **cross-functional** team.' }),
    );

    expect(text).not.toContain('**');
    expect(text).not.toContain('#');
    expect(text).toContain('cross');
  });

  it('lower-cases everything', () => {
    expect(resumePlainText(makeResumeContent())).toBe(
      resumePlainText(makeResumeContent()).toLowerCase(),
    );
  });

  it('collapses whitespace to single spaces', () => {
    const text = resumePlainText(makeResumeContent({ summary: 'One.\n\nTwo.' }));

    expect(text).not.toMatch(/\s{2,}/);
    expect(text).not.toContain('\n');
  });

  it('keeps the words a keyword check is looking for', () => {
    const text = resumePlainText(
      makeResumeContent({
        skills: { technical: ['SQL'], professional: [], tools: ['Tableau'] },
      }),
    );

    expect(text).toContain('sql');
    expect(text).toContain('tableau');
  });
});
