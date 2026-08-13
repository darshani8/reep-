import { describe, expect, it } from 'vitest';

import {
  compositeKey,
  flattenCell,
  jobKey,
  normaliseHeader,
  parseApplyUrl,
  parseDegreeLevel,
  parseDelimited,
  parseJobSheet,
  parseSheetDate,
  parseSkills,
  type RawRow,
} from './parse';

const TODAY = new Date(Date.UTC(2026, 7, 11));

const HEADERS = [
  'Ref',
  'Job Title',
  'Company',
  'Degree Level',
  'Location',
  'Apply Link',
  'Description',
  'Skills',
  'Posted On',
  'Closing Date',
];

function sheet(...rows: RawRow[]): RawRow[] {
  return [HEADERS, ...rows];
}

const GOOD: RawRow = [
  'REEP-2026-W32-001',
  'Business Analyst',
  'Wipro',
  'PG',
  'Bengaluru',
  'https://careers.wipro.com/ba',
  'SQL and dashboards.',
  'SQL, MS Excel',
  '2026-08-05',
  '2026-08-30',
];

describe('normaliseHeader', () => {
  it('flattens punctuation and case so header spellings converge', () => {
    expect(normaliseHeader('  Apply_URL ')).toBe('apply url');
    expect(normaliseHeader('UG/PG')).toBe('ug pg');
  });
});

describe('parseDegreeLevel', () => {
  it('reads the plain codes', () => {
    expect(parseDegreeLevel('UG')).toBe('UG');
    expect(parseDegreeLevel('pg')).toBe('PG');
  });

  it('reads "Post Graduate" as PG rather than being caught by the word "graduate"', () => {
    expect(parseDegreeLevel('Post Graduate')).toBe('PG');
    expect(parseDegreeLevel('postgraduate')).toBe('PG');
    expect(parseDegreeLevel('Under Graduate')).toBe('UG');
  });

  it('reads the degree names the sheet uses instead of a level', () => {
    expect(parseDegreeLevel('MBA')).toBe('PG');
    expect(parseDegreeLevel('BBA / BCom')).toBe('UG');
  });

  it('puts a row open to both in front of the wider audience', () => {
    expect(parseDegreeLevel('UG/PG')).toBe('UG');
  });

  it('refuses a blank or a word it does not know', () => {
    expect(parseDegreeLevel('')).toBeNull();
    expect(parseDegreeLevel(null)).toBeNull();
    expect(parseDegreeLevel('Any')).toBeNull();
  });
});

describe('parseSheetDate', () => {
  it('separates "nothing there" from "not a date"', () => {
    expect(parseSheetDate(null)).toBeNull();
    expect(parseSheetDate('')).toBeNull();
    expect(parseSheetDate('ASAP')).toBe(false);
  });

  it('takes an ISO date', () => {
    expect(parseSheetDate('2026-08-30')?.toString()).toBe(
      new Date(Date.UTC(2026, 7, 30)).toString(),
    );
  });

  it('reads a slashed date day-first, the way the sender types it', () => {
    const parsed = parseSheetDate('03/04/2026');
    expect(parsed).not.toBe(false);
    if (!parsed) return;
    expect(parsed.getUTCMonth()).toBe(3);
    expect(parsed.getUTCDate()).toBe(3);
  });

  it('reads a worded date', () => {
    const parsed = parseSheetDate('14-Aug-2026');
    expect(parsed).not.toBe(false);
    if (!parsed) return;
    expect(parsed.getUTCMonth()).toBe(7);
    expect(parsed.getUTCDate()).toBe(14);
  });

  it('converts an unformatted Excel serial instead of reading it as a year', () => {
    // 46_000 days after 1899-12-30.
    const parsed = parseSheetDate(46_000);
    expect(parsed).not.toBe(false);
    if (!parsed) return;
    expect(parsed.getUTCFullYear()).toBe(2025);
  });

  it('rejects a day that does not exist rather than rolling it into next month', () => {
    expect(parseSheetDate('31/02/2026')).toBe(false);
  });

  it('passes a real Date through and refuses an invalid one', () => {
    const date = new Date(Date.UTC(2026, 0, 2));
    expect(parseSheetDate(date)).toBe(date);
    expect(parseSheetDate(new Date('nonsense'))).toBe(false);
  });
});

describe('parseApplyUrl', () => {
  it('keeps an http(s) address as it stands', () => {
    expect(parseApplyUrl('https://careers.example.com/a')).toBe('https://careers.example.com/a');
  });

  it('gives a bare domain a scheme', () => {
    expect(parseApplyUrl('careers.example.com/a')).toBe('https://careers.example.com/a');
  });

  it('refuses a javascript: pseudo-link outright', () => {
    expect(parseApplyUrl('javascript:alert(1)')).toBe(false);
  });

  it('refuses free text that is not an address', () => {
    expect(parseApplyUrl('email the placement cell')).toBe(false);
  });

  it('reads a blank as absent, not as broken', () => {
    expect(parseApplyUrl('')).toBeNull();
  });
});

describe('parseSkills', () => {
  const catalogue = new Map([
    ['ms excel', 'excel'],
    ['excel', 'excel'],
    ['sql', 'sql'],
  ]);

  it('resolves a sheet spelling to the catalogue slug the match scores on', () => {
    expect(parseSkills('MS Excel; SQL', catalogue).slugs).toEqual(['excel', 'sql']);
  });

  it('keeps a skill the catalogue does not know, and names it as unresolved', () => {
    const parsed = parseSkills('SQL, Loan Origination', catalogue);
    expect(parsed.slugs).toEqual(['sql', 'loan-origination']);
    expect(parsed.unresolved).toEqual(['Loan Origination']);
  });

  it('does not repeat a slug two spellings resolve to', () => {
    expect(parseSkills('Excel, MS Excel', catalogue).slugs).toEqual(['excel']);
  });
});

describe('flattenCell', () => {
  it('joins exceljs rich text into the string a reader would see', () => {
    expect(flattenCell({ richText: [{ text: 'Business ' }, { text: 'Analyst' }] })).toBe(
      'Business Analyst',
    );
  });

  it('prefers the target of a hyperlink cell over its label', () => {
    expect(flattenCell({ text: 'Apply', hyperlink: 'https://example.com/a' })).toBe(
      'https://example.com/a',
    );
  });

  it('takes the cached result of a formula', () => {
    expect(flattenCell({ formula: 'A1&B1', result: 'Wipro' })).toBe('Wipro');
  });

  it('turns an error cell into nothing rather than "#REF!"', () => {
    expect(flattenCell({ error: '#REF!' })).toBeNull();
  });
});

describe('jobKey', () => {
  it('uses the sheet reference when there is one', () => {
    expect(jobKey({ sourceRef: 'R-1', company: 'Wipro', title: 'BA' })).toBe('ref:R-1');
  });

  it('falls back to company, title and link together', () => {
    const key = jobKey({ sourceRef: null, company: 'Wipro', title: 'BA', applyUrl: 'x.com/1' });
    expect(key).toBe(`fp:${compositeKey({ company: 'Wipro', title: 'BA', applyUrl: 'x.com/1' })}`);
  });

  it('separates two drives at the same firm for the same role by their link', () => {
    const first = jobKey({ company: 'Wipro', title: 'BA', applyUrl: 'https://x.com/1' });
    const second = jobKey({ company: 'Wipro', title: 'BA', applyUrl: 'https://x.com/2' });
    expect(first).not.toBe(second);
  });

  it('ignores case and spacing, so a retyped sheet lands on the same row', () => {
    expect(jobKey({ company: ' WIPRO ', title: 'Business  Analyst' })).toBe(
      jobKey({ company: 'wipro', title: 'business analyst' }),
    );
  });
});

describe('parseJobSheet', () => {
  it('reads a good row into a job', () => {
    const parsed = parseJobSheet(sheet(GOOD), { today: TODAY });
    expect(parsed.errors).toEqual([]);
    expect(parsed.jobs).toHaveLength(1);
    const [job] = parsed.jobs;
    expect(job.title).toBe('Business Analyst');
    expect(job.company).toBe('Wipro');
    expect(job.degreeLevel).toBe('PG');
    expect(job.requiredSkills).toEqual(['sql', 'ms-excel']);
    expect(job.key).toBe('ref:REEP-2026-W32-001');
    expect(job.rowNumber).toBe(2);
  });

  it('finds the header under a title banner instead of insisting it is row 1', () => {
    const parsed = parseJobSheet(
      [['REEP weekly jobs sheet — W32'], [], HEADERS, GOOD],
      { today: TODAY },
    );
    expect(parsed.headerRow).toBe(3);
    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.jobs[0].rowNumber).toBe(4);
  });

  it('skips one bad row and keeps the rest, naming the row and the column', () => {
    const closesBadly = [...GOOD];
    closesBadly[0] = 'REEP-2026-W32-002';
    closesBadly[9] = 'ASAP';
    const noLevel = [...GOOD];
    noLevel[0] = 'REEP-2026-W32-003';
    noLevel[3] = '';

    const parsed = parseJobSheet(sheet(GOOD, closesBadly, noLevel), { today: TODAY });

    expect(parsed.jobs.map((job) => job.sourceRef)).toEqual(['REEP-2026-W32-001']);
    expect(parsed.errors).toEqual([
      { row: 3, column: 'closesOn', message: 'Unparseable date "ASAP" — row skipped' },
      { row: 4, column: 'degreeLevel', message: 'Blank degree level — row skipped' },
    ]);
  });

  it('ignores blank spacer rows without reporting them', () => {
    const parsed = parseJobSheet(sheet(GOOD, [], ['', '', '']), { today: TODAY });
    expect(parsed.errors).toEqual([]);
    expect(parsed.jobs).toHaveLength(1);
  });

  it('keeps a posting whose apply link is unusable, and says so', () => {
    const noLink = [...GOOD];
    noLink[5] = 'ask the placement cell';
    const parsed = parseJobSheet(sheet(noLink), { today: TODAY });
    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.jobs[0].applyUrl).toBeNull();
    expect(parsed.warnings[0].column).toBe('applyUrl');
  });

  it('dates an undated row by the import rather than leaving the board unsorted', () => {
    const undated = [...GOOD];
    undated[8] = '';
    const parsed = parseJobSheet(sheet(undated), { today: TODAY });
    expect(parsed.jobs[0].postedOn).toEqual(TODAY);
    expect(parsed.jobs[0].closesOn).toEqual(new Date(Date.UTC(2026, 7, 30)));
  });

  it('lets a later row correct an earlier one with the same reference', () => {
    const corrected = [...GOOD];
    corrected[1] = 'Business Analyst (Corrected)';
    const parsed = parseJobSheet(sheet(GOOD, corrected), { today: TODAY });
    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.jobs[0].title).toBe('Business Analyst (Corrected)');
    expect(parsed.warnings[0].message).toContain('row 2');
  });

  it('parses the same sheet twice into the same keys, which is what makes a re-import idempotent', () => {
    const first = parseJobSheet(sheet(GOOD), { today: TODAY });
    const second = parseJobSheet(sheet(GOOD), { today: TODAY });
    expect(first.jobs.map((job) => job.key)).toEqual(second.jobs.map((job) => job.key));
  });

  it('refuses a sheet with no recognisable header, without throwing', () => {
    const parsed = parseJobSheet([['who'], ['knows']], { today: TODAY });
    expect(parsed.jobs).toEqual([]);
    expect(parsed.errors[0].column).toBe('header');
  });

  it('refuses a sheet whose header names no degree level, and says which column is missing', () => {
    const parsed = parseJobSheet([['Job Title', 'Company'], ['BA', 'Wipro']], { today: TODAY });
    expect(parsed.jobs).toEqual([]);
    expect(parsed.errors[0].column).toBe('degreeLevel');
  });

  it('reads an empty sheet as an empty import, not a crash', () => {
    expect(parseJobSheet([]).jobs).toEqual([]);
    expect(parseJobSheet([]).errors[0].column).toBe('header');
  });
});

describe('parseDelimited', () => {
  it('reads a quoted field containing the delimiter and a newline', () => {
    const rows = parseDelimited('a,"b,1",c\r\n"line\nbreak",e,f\r\n');
    expect(rows).toEqual([
      ['a', 'b,1', 'c'],
      ['line\nbreak', 'e', 'f'],
    ]);
  });

  it('unescapes a doubled quote', () => {
    expect(parseDelimited('"say ""hi""",b')).toEqual([['say "hi"', 'b']]);
  });

  it('strips the BOM the exporter writes for Excel', () => {
    expect(parseDelimited('﻿Title,Company')).toEqual([['Title', 'Company']]);
  });

  it('round-trips a CSV the director exported and edited', () => {
    const csv = [
      'Job Title,Company,Degree Level',
      'Business Analyst,Wipro,PG',
      '"Analyst, Credit",HDFC Bank,PG',
    ].join('\r\n');
    const parsed = parseJobSheet(parseDelimited(csv), { today: TODAY });
    expect(parsed.errors).toEqual([]);
    expect(parsed.jobs.map((job) => job.title)).toEqual(['Business Analyst', 'Analyst, Credit']);
  });
});
