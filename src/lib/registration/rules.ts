/**
 * Whether an application may be waved through, and the sentence that says why.
 *
 * "Auto-approve if the applicant is within the specified domains" reads like one
 * condition and is two, because "domain" means two different things to the two
 * people who say it. The admissions office means *the email domain* — an
 * address at bgscet.ac.in belongs to somebody the college already issued an
 * account to. The programme office means *the academic domain* — an MBA intake
 * does not auto-admit a BBA applicant, whatever their address. Implementing
 * either one alone produces a defensible-looking rule with a hole in it: the
 * first waves through a college address applying to the wrong programme, the
 * second waves through a stranger with a plausible-looking USN.
 *
 * So both are required, as an AND, and each is independently switchable off by
 * leaving its column null on a rule. That is `RegistrationRule`'s existing
 * shape, and the two axes map onto it like this:
 *
 *  - **Address**: `emailDomain`. Null means the rule does not constrain it.
 *  - **Programme**: `degreeLevel` *and* `usnPattern`. The UG/PG half is a column;
 *    the branch half lives inside the USN, because a BGSCET number spells it —
 *    `1BG24`**`MBA`**`001` — and the table has no separate branch column. A
 *    director narrowing a rule to the MBA intake edits the pattern. Both null
 *    means the rule does not constrain the programme.
 *
 * Nothing here is hard-coded, and that is the point of the table: the intake
 * changes every August, and a domain list compiled into a component or read from
 * an env var is a deploy each time it does. This module is handed the rows and
 * has no opinion about which ones exist.
 *
 * The whole thing is a pure function of (facts, rules) — no clock, no database,
 * no `server-only` — so the decision that hands a stranger a student account can
 * be tested exhaustively rather than exercised through a signup form.
 */

import type { DegreeLevel } from '@prisma/client';

import { emailDomain } from './schema';

/// What the decision is allowed to know about the applicant. Deliberately not a
/// `Registration` row: this function must be callable with a form's contents
/// before anything has been written, and with a row afterwards.
export type RegistrationFacts = {
  email: string;
  /**
   * Whether the address has been *proven*, not merely typed.
   *
   * The ordering this enforces is the security property of the whole feature.
   * "Within specified domains" is a claim until the link in that mailbox has
   * been clicked; auto-approving on an unverified address means anyone who can
   * spell `something@bgscet.ac.in` gets a STUDENT session, and a STUDENT session
   * reads the leaderboards. So this is checked before any rule is consulted, and
   * a false here can only ever produce PENDING_REVIEW.
   */
  emailVerified: boolean;
  usn: string | null;
  degreeLevel: DegreeLevel;
  /// The programme the applicant said they were joining, e.g. `MBA`. Null when
  /// they left it blank on an older application.
  programme: string | null;
};

/// The columns of `RegistrationRule` this reads, as a plain object so a test
/// does not need a database row.
export type RegistrationRuleFacts = {
  id: string;
  name: string;
  enabled: boolean;
  emailDomain: string | null;
  usnPattern: string | null;
  degreeLevel: DegreeLevel | null;
  cohortId: string | null;
  autoApprove: boolean;
  priority: number;
};

/// The two outcomes this function may reach. APPROVED and REJECTED are a
/// human's to write, and DRAFT/PENDING_VERIFICATION belong to the stage before
/// this one, so none of them appear here.
export type RegistrationOutcome = 'AUTO_APPROVED' | 'PENDING_REVIEW';

export type RegistrationDecision = {
  status: RegistrationOutcome;
  /// The rule that decided, when one did. Written to `Registration.matchedRuleId`.
  matchedRuleId: string | null;
  /// The cohort the matched rule places this applicant in, when it names one.
  /// Null leaves the choice to the reviewer, which is what the approval form asks.
  cohortId: string | null;
  /// Written to `Registration.decisionReason` and shown verbatim on the queue.
  /// A reviewer should never have to open this file to find out what happened.
  reason: string;
};

/**
 * Does this rule's address axis admit the applicant?
 *
 * Null is "this rule does not care", not "no domain is acceptable" — the
 * catch-all row in the seed relies on exactly that to route everything else to a
 * human without naming a domain.
 */
function addressMatches(rule: RegistrationRuleFacts, facts: RegistrationFacts): boolean {
  if (rule.emailDomain === null) return true;
  return emailDomain(facts.email) === rule.emailDomain.trim().toLowerCase();
}

/**
 * Does this rule's programme axis admit the applicant?
 *
 * A rule that names a `usnPattern` and an applicant with no USN is a
 * non-match rather than a pass: the pattern is the only evidence the programme
 * axis has, and treating "nothing to test" as "test passed" is how the second
 * hole in the docblock above gets reopened.
 *
 * An unparseable pattern is also a non-match. A director typing a broken regex
 * should see their rule stop firing — which is visible on the queue as
 * applications piling up for review — rather than have it throw inside a request
 * or, worse, be skipped and let the address axis approve on its own.
 */
function programmeMatches(rule: RegistrationRuleFacts, facts: RegistrationFacts): boolean {
  if (rule.degreeLevel !== null && rule.degreeLevel !== facts.degreeLevel) return false;
  if (rule.usnPattern === null) return true;
  if (facts.usn === null || facts.usn.trim() === '') return false;

  const pattern = compile(rule.usnPattern);
  if (pattern === null) return false;
  return pattern.test(facts.usn.trim().toUpperCase());
}

function compile(source: string): RegExp | null {
  try {
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
}

/**
 * Does the applicant's own account of their programme agree with their number?
 *
 * Not an allowlist — a consistency check, and a separate one because it can fail
 * while every rule matches. Someone who writes "MBA" under a USN reading
 * `1BG24BBA118` has either mistyped the number or applied to the wrong intake,
 * and both are worth thirty seconds of a human's time. Returns true when there
 * is nothing to compare, because absence is handled by the axes above.
 */
function declarationAgreesWithUsn(facts: RegistrationFacts): boolean {
  if (!facts.programme || !facts.usn) return true;
  const programme = facts.programme.trim().toUpperCase();
  // Only a code-shaped programme is checkable this way. "Master of Business
  // Administration" is not expected to appear inside a USN, so it is not held
  // against the applicant.
  if (!/^[A-Z]{2,6}$/.test(programme)) return true;
  return facts.usn.trim().toUpperCase().includes(programme);
}

/**
 * The decision, and the sentence a reviewer reads.
 *
 * Rules are consulted in `priority` order, lowest first, so a narrow rule sits
 * above a broad one without either being rewritten — the ordering
 * `RegistrationRule`'s own docblock describes. Ties break on name so the
 * decision is stable rather than dependent on row order.
 */
export function decideRegistration(
  facts: RegistrationFacts,
  rules: readonly RegistrationRuleFacts[],
): RegistrationDecision {
  if (!facts.emailVerified) {
    return {
      status: 'PENDING_REVIEW',
      matchedRuleId: null,
      cohortId: null,
      reason:
        'Email address has not been confirmed, so no rule was applied. Confirming the address re-runs this decision.',
    };
  }

  const enabled = [...rules].filter((rule) => rule.enabled);
  if (enabled.length === 0) {
    return {
      status: 'PENDING_REVIEW',
      matchedRuleId: null,
      cohortId: null,
      reason: 'No registration rule is enabled, so every application is read by a human.',
    };
  }

  const matches = enabled
    .filter((rule) => addressMatches(rule, facts) && programmeMatches(rule, facts))
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

  const winner = matches[0];
  if (!winner) {
    return {
      status: 'PENDING_REVIEW',
      matchedRuleId: null,
      cohortId: null,
      reason: `No registration rule matched: ${whyNothingMatched(facts, enabled)}.`,
    };
  }

  const cohortId = winner.cohortId;

  if (!winner.autoApprove) {
    return {
      status: 'PENDING_REVIEW',
      matchedRuleId: winner.id,
      cohortId,
      reason: `Matched “${winner.name}”, which routes to the programme office rather than approving.`,
    };
  }

  if (!declarationAgreesWithUsn(facts)) {
    return {
      status: 'PENDING_REVIEW',
      matchedRuleId: winner.id,
      cohortId,
      reason: `Matched “${winner.name}”, but the stated programme (${facts.programme}) does not appear in the USN (${facts.usn}). Confirm which is right before approving.`,
    };
  }

  return {
    status: 'AUTO_APPROVED',
    matchedRuleId: winner.id,
    cohortId,
    reason: `Matched “${winner.name}”: ${describeAxes(winner, facts)}, on a confirmed address.`,
  };
}

/**
 * Which axis turned everything away.
 *
 * Written per axis rather than per rule because a reviewer wants to know what to
 * fix, and "none of four rules matched" is not that. The two clauses are joined
 * with "and" precisely because the two conditions are an AND.
 */
function whyNothingMatched(
  facts: RegistrationFacts,
  enabled: readonly RegistrationRuleFacts[],
): string {
  const addressFailed = !enabled.some((rule) => addressMatches(rule, facts));
  const programmeFailed = !enabled.some((rule) => programmeMatches(rule, facts));

  const clauses: string[] = [];
  if (addressFailed) {
    clauses.push(`${emailDomain(facts.email) || 'that address'} is not an allowed email domain`);
  }
  if (programmeFailed) {
    clauses.push(
      facts.usn && facts.usn.trim() !== ''
        ? `USN ${facts.usn} does not match any ${facts.degreeLevel} intake pattern`
        : `no USN was given, so there is nothing to check the ${facts.degreeLevel} intake against`,
    );
  }
  if (clauses.length === 0) {
    // Both axes pass somewhere, but never on the same rule — a genuine gap in the
    // table rather than a fault of the application, and worth saying so.
    clauses.push('the address and the programme are each allowed, but not by the same rule');
  }

  return clauses.join(', and ');
}

/// The conditions the winning rule actually applied, so the reason names the
/// evidence rather than only the rule.
function describeAxes(rule: RegistrationRuleFacts, facts: RegistrationFacts): string {
  const parts: string[] = [];
  if (rule.emailDomain) parts.push(`email domain ${rule.emailDomain}`);
  if (rule.degreeLevel) parts.push(`${rule.degreeLevel} intake`);
  if (rule.usnPattern && facts.usn) parts.push(`USN ${facts.usn}`);
  return parts.length > 0 ? parts.join(' and ') : 'no conditions set';
}
