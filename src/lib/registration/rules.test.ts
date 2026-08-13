import { describe, expect, it } from 'vitest';

import { decideRegistration, type RegistrationFacts, type RegistrationRuleFacts } from './rules';

/**
 * The function that decides whether a stranger gets a STUDENT session.
 *
 * The first test is the one the whole feature turns on: an unverified address
 * that matches every rule perfectly must still not auto-approve. If that one
 * ever goes green for the wrong reason, anybody who can spell a college address
 * can read the roster.
 */

const rule = (over: Partial<RegistrationRuleFacts> = {}): RegistrationRuleFacts => ({
  id: 'rule_mba',
  name: 'BGSCET college address — MBA intake',
  enabled: true,
  emailDomain: 'bgscet.ac.in',
  usnPattern: '^1BG2[0-9]MBA[0-9]{3}$',
  degreeLevel: 'PG',
  cohortId: 'cohort_b',
  autoApprove: true,
  priority: 10,
  ...over,
});

const catchAll = (over: Partial<RegistrationRuleFacts> = {}): RegistrationRuleFacts => ({
  id: 'rule_any',
  name: 'Anything else — send it to the programme office',
  enabled: true,
  emailDomain: null,
  usnPattern: null,
  degreeLevel: null,
  cohortId: null,
  autoApprove: false,
  priority: 900,
  ...over,
});

const applicant = (over: Partial<RegistrationFacts> = {}): RegistrationFacts => ({
  email: 'sahana.bhat@bgscet.ac.in',
  emailVerified: true,
  usn: '1BG24MBA113',
  degreeLevel: 'PG',
  programme: 'MBA',
  ...over,
});

describe('decideRegistration', () => {
  it('never auto-approves an address that has not been proven', () => {
    const decision = decideRegistration(applicant({ emailVerified: false }), [rule()]);

    expect(decision.status).toBe('PENDING_REVIEW');
    expect(decision.matchedRuleId).toBeNull();
    expect(decision.reason).toMatch(/not been confirmed/i);
  });

  it('auto-approves when both halves of "domain" agree', () => {
    const decision = decideRegistration(applicant(), [rule(), catchAll()]);

    expect(decision.status).toBe('AUTO_APPROVED');
    expect(decision.matchedRuleId).toBe('rule_mba');
    expect(decision.cohortId).toBe('cohort_b');
    expect(decision.reason).toContain('bgscet.ac.in');
    expect(decision.reason).toContain('1BG24MBA113');
  });

  describe('the two conditions are an AND', () => {
    it('refuses a college address applying to the wrong intake', () => {
      const decision = decideRegistration(
        applicant({ usn: '1BG24BBA118', degreeLevel: 'UG', programme: 'BBA' }),
        [rule(), catchAll()],
      );

      expect(decision.status).toBe('PENDING_REVIEW');
      expect(decision.matchedRuleId).toBe('rule_any');
    });

    it('refuses a right-looking USN from an outside address', () => {
      const decision = decideRegistration(applicant({ email: 'someone@gmail.com' }), [
        rule(),
        catchAll(),
      ]);

      expect(decision.status).toBe('PENDING_REVIEW');
      expect(decision.matchedRuleId).toBe('rule_any');
    });

    it('says which axis failed when nothing matched at all', () => {
      const decision = decideRegistration(applicant({ email: 'someone@gmail.com' }), [rule()]);

      expect(decision.status).toBe('PENDING_REVIEW');
      expect(decision.matchedRuleId).toBeNull();
      expect(decision.reason).toContain('gmail.com is not an allowed email domain');
    });

    it('names the missing USN rather than blaming the address', () => {
      const decision = decideRegistration(applicant({ usn: null }), [rule()]);

      expect(decision.reason).toMatch(/no USN was given/i);
    });
  });

  describe('each axis is independently switchable off', () => {
    it('a rule with no emailDomain does not constrain the address', () => {
      const decision = decideRegistration(applicant({ email: 'sahana@gmail.com' }), [
        rule({ emailDomain: null }),
      ]);

      expect(decision.status).toBe('AUTO_APPROVED');
    });

    it('a rule with no programme conditions does not constrain the programme', () => {
      const decision = decideRegistration(applicant({ usn: null, programme: null }), [
        rule({ usnPattern: null, degreeLevel: null }),
      ]);

      expect(decision.status).toBe('AUTO_APPROVED');
    });
  });

  it('lets the lowest priority win so a narrow rule sits above a broad one', () => {
    const broad = rule({ id: 'rule_broad', name: 'Any BGSCET address', usnPattern: null, degreeLevel: null, priority: 5, autoApprove: false });
    const decision = decideRegistration(applicant(), [rule(), broad]);

    expect(decision.matchedRuleId).toBe('rule_broad');
    expect(decision.status).toBe('PENDING_REVIEW');
  });

  it('skips disabled rules, and says so when that leaves none', () => {
    const decision = decideRegistration(applicant(), [rule({ enabled: false })]);

    expect(decision.status).toBe('PENDING_REVIEW');
    expect(decision.reason).toMatch(/No registration rule is enabled/i);
  });

  it('sends a match to review when the rule is a routing rule', () => {
    const decision = decideRegistration(applicant(), [rule({ autoApprove: false })]);

    expect(decision.status).toBe('PENDING_REVIEW');
    expect(decision.matchedRuleId).toBe('rule_mba');
    expect(decision.cohortId).toBe('cohort_b');
    expect(decision.reason).toMatch(/routes to the programme office/i);
  });

  it('stops a rule with a broken regex from firing, rather than throwing', () => {
    const decision = decideRegistration(applicant(), [rule({ usnPattern: '^1BG2[0-9MBA' })]);

    expect(decision.status).toBe('PENDING_REVIEW');
    expect(decision.matchedRuleId).toBeNull();
  });

  it('holds back an approval when the stated programme and the USN disagree', () => {
    const decision = decideRegistration(
      applicant({ programme: 'MBA', usn: '1BG24MCA113' }),
      // The rule is loosened so the mismatch, not the pattern, is what stops it.
      [rule({ usnPattern: '^1BG2[0-9][A-Z]{3}[0-9]{3}$' })],
    );

    expect(decision.status).toBe('PENDING_REVIEW');
    expect(decision.matchedRuleId).toBe('rule_mba');
    expect(decision.reason).toContain('does not appear in the USN');
  });

  it('does not hold back an approval over a spelled-out programme name', () => {
    const decision = decideRegistration(
      applicant({ programme: 'Master of Business Administration' }),
      [rule()],
    );

    expect(decision.status).toBe('AUTO_APPROVED');
  });

  it('sends everything to review when the table is empty', () => {
    const decision = decideRegistration(applicant(), []);

    expect(decision.status).toBe('PENDING_REVIEW');
    expect(decision.matchedRuleId).toBeNull();
  });
});
