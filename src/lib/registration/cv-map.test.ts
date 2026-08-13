import { describe, expect, it } from 'vitest';

import { mapCvText } from './cv-map';

/**
 * CV layouts, as they actually arrive.
 *
 * Each fixture below is a shape a real CV takes, written out rather than kept as
 * a sample PDF, which is the payoff for `cv-map.ts` being pure: the awkward
 * layouts accumulate here instead of in a folder someone has to open by hand.
 */

const TIDY = `
SAHANA BHAT
Bengaluru, Karnataka 560059
sahana.bhat@bgscet.ac.in | +91 98860 41125
linkedin.com/in/sahana-bhat

EDUCATION
MBA (Finance & Marketing), BGS College of Engineering and Technology, 2026, 8.4 CGPA
B.Com, Christ University, 2024, 78%

SKILLS
Advanced Excel, Financial Modelling, Power BI, SQL

EXPERIENCE
Intern, Wipro Finance — reconciled ledgers
`;

const LABELLED = `
Curriculum Vitae

Name: Imran Shaikh
Mobile: 9008477310
Email ID: imran.shaikh@gmail.com
Address: #14, 3rd Cross, Jayanagar, Bengaluru, Karnataka 560041
Specialisation: Operations

ACADEMICS
PGDM, Symbiosis, 2025, 7.9 CGPA
`;

describe('mapCvText', () => {
  it('reads a conventionally laid out CV', () => {
    const result = mapCvText(TIDY);

    expect(result.fields.name).toBe('Sahana Bhat');
    expect(result.fields.email).toBe('sahana.bhat@bgscet.ac.in');
    expect(result.fields.phone).toBe('+919886041125');
    expect(result.fields.linkedinUrl).toBe('https://www.linkedin.com/in/sahana-bhat');
    expect(result.fields.city).toBe('Bengaluru');
    expect(result.fields.degreeLevel).toBe('PG');
    expect(result.fields.programme).toBe('MBA');
    expect(result.fields.branch).toBe('Finance & Marketing');
  });

  it('reads a CV written as labelled lines', () => {
    const result = mapCvText(LABELLED);

    expect(result.fields.name).toBe('Imran Shaikh');
    expect(result.fields.email).toBe('imran.shaikh@gmail.com');
    expect(result.fields.phone).toBe('9008477310');
    expect(result.fields.branch).toBe('Operations');
    expect(result.fields.city).toBe('Bengaluru');
  });

  it('turns a name written in block capitals into something addressable', () => {
    expect(mapCvText('RAKESH IYER\nrakesh@example.com').fields.name).toBe('Rakesh Iyer');
  });

  it('does not read the word RESUME at the top as somebody called Resume', () => {
    const result = mapCvText('RESUME\nAditi Kulkarni\naditi@example.com');
    expect(result.fields.name).toBe('Aditi Kulkarni');
  });

  it('prefers the USN over a degree token, because the CV lists the previous degree', () => {
    // The commonest single failure: an MBA applicant's CV whose Education
    // section is entirely about their BBA.
    const result = mapCvText(`
      Priya N
      USN: 1BG24MBA002

      EDUCATION
      BBA, Jain University, 2024, 74%
    `);

    expect(result.fields.usn).toBe('1BG24MBA002');
    expect(result.fields.programme).toBe('MBA');
    expect(result.fields.degreeLevel).toBe('PG');
  });

  it('stops a section at the next heading rather than swallowing the page', () => {
    const result = mapCvText(TIDY);
    expect(result.skills).toContain('Power BI');
    expect(result.skills.some((skill) => /reconciled ledgers/i.test(skill))).toBe(false);
  });

  it('names every field it could not fill', () => {
    const result = mapCvText('Some scanned nonsense with no structure at all.');

    expect(result.fields.email).toBeUndefined();
    expect(result.missing).toContain('email');
    expect(result.missing).toContain('phone');
    expect(result.missing).toContain('usn');
  });

  it('survives an empty document', () => {
    const result = mapCvText('');
    expect(result.fields).toEqual({});
    expect(result.education).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.missing.length).toBe(9);
  });

  it('does not read a pincode as a phone number', () => {
    const result = mapCvText('Meera S\nBengaluru 560059\nmeera@example.com');
    expect(result.fields.phone).toBeUndefined();
  });

  it('keeps education rows that name a qualification or an institution, and drops the rest', () => {
    const result = mapCvText(TIDY);

    expect(result.education.length).toBe(2);
    expect(result.education[0].degree).toBe('MBA');
    expect(result.education[0].institution).toMatch(/BGS College/);
    expect(result.education[0].year).toBe('2026');
    expect(result.education[0].score).toBe('8.4CGPA');
  });
});
