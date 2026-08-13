import { describe, expect, it } from 'vitest';

import {
  emailDomain,
  normaliseLinkedinUrl,
  normalisePhone,
  parseRegistrationInput,
} from './schema';

/**
 * The boundary between a stranger and the `registrations` table.
 *
 * The stripping tests are the ones that matter most: they are the difference
 * between "we do not read `role` from the form" as a fact and as an intention.
 */

const VALID = {
  name: 'Sahana Bhat',
  email: 'Sahana.Bhat@BGSCET.ac.in',
  phone: '+91 98860 41125',
  degreeLevel: 'PG',
  programme: 'mba',
  branch: 'Finance & Marketing',
  usn: '1bg24mba113',
  linkedinUrl: 'linkedin.com/in/sahana-bhat',
  city: 'Bengaluru',
};

describe('parseRegistrationInput', () => {
  it('normalises everything it accepts', () => {
    const result = parseRegistrationInput(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.email).toBe('sahana.bhat@bgscet.ac.in');
    expect(result.value.phone).toBe('+919886041125');
    expect(result.value.usn).toBe('1BG24MBA113');
    expect(result.value.programme).toBe('MBA');
    expect(result.value.linkedinUrl).toBe('https://www.linkedin.com/in/sahana-bhat');
  });

  it('drops role, cohortId and status rather than passing them through', () => {
    const result = parseRegistrationInput({
      ...VALID,
      role: 'ADMIN',
      cohortId: 'cohort_someone_elses',
      status: 'AUTO_APPROVED',
      approvedStudentId: 'stu_1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value).sort()).toEqual([
      'branch',
      'city',
      'degreeLevel',
      'email',
      'linkedinUrl',
      'name',
      'phone',
      'programme',
      'usn',
    ]);
  });

  it('treats a blank USN as absent rather than as an empty string', () => {
    const result = parseRegistrationInput({ ...VALID, usn: '   ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.usn).toBeUndefined();
  });

  it('reports one message per bad field, not one for the whole form', () => {
    const result = parseRegistrationInput({
      ...VALID,
      name: 'A',
      email: 'not-an-address',
      phone: '12',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(['email', 'name', 'phone']);
    expect(result.errors.email).toMatch(/email address/i);
  });

  it('refuses a degree level it has never heard of', () => {
    const result = parseRegistrationInput({ ...VALID, degreeLevel: 'PHD' });
    expect(result.ok).toBe(false);
  });
});

describe('normaliseLinkedinUrl', () => {
  it('reduces the four ways people paste a profile to one string', () => {
    const canonical = 'https://www.linkedin.com/in/sahana-bhat';
    expect(normaliseLinkedinUrl('sahana-bhat')).toBe(canonical);
    expect(normaliseLinkedinUrl('linkedin.com/in/sahana-bhat')).toBe(canonical);
    expect(normaliseLinkedinUrl('https://www.linkedin.com/in/sahana-bhat/')).toBe(canonical);
    expect(normaliseLinkedinUrl('https://in.linkedin.com/in/sahana-bhat?trk=nav')).toBe(canonical);
  });

  it('refuses anything that would put a chosen scheme or host in an href', () => {
    expect(normaliseLinkedinUrl('javascript:alert(1)')).toBeNull();
    expect(normaliseLinkedinUrl('https://evil.example.com/in/someone')).toBeNull();
    expect(normaliseLinkedinUrl('data:text/html,<script>')).toBeNull();
    expect(normaliseLinkedinUrl('example.com/me')).toBeNull();
  });

  it('is empty-safe', () => {
    expect(normaliseLinkedinUrl('   ')).toBeNull();
  });
});

describe('normalisePhone', () => {
  it('makes two spellings of one number compare equal', () => {
    expect(normalisePhone('98860 41125')).toBe('9886041125');
    expect(normalisePhone('098860-41125')).toBe('09886041125');
    expect(normalisePhone('+91 (988) 604-1125')).toBe('+919886041125');
  });

  it('refuses runs of digits that cannot be a phone number', () => {
    expect(normalisePhone('560059')).toBeNull();
    expect(normalisePhone('1234567890123456')).toBeNull();
  });
});

describe('emailDomain', () => {
  it('takes everything after the last @, lowercased', () => {
    expect(emailDomain('Sahana.Bhat@BGSCET.ac.in')).toBe('bgscet.ac.in');
    expect(emailDomain('weird@name@gmail.com')).toBe('gmail.com');
    expect(emailDomain('nonsense')).toBe('');
  });
});
