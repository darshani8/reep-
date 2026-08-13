import 'server-only';

/**
 * Everything the registration screens read.
 *
 * A module of its own rather than four more functions in `src/lib/queries.ts`,
 * because registration is the one feature whose reads have a different audience
 * from the rest of the product: an applicant with no session, and a director
 * looking at people who are not yet students. Nothing here narrows by
 * `mentorScope()` and nothing here should — an applicant has no mentor, so that
 * function has no answer for them, which is exactly why the review queue is
 * DIRECTOR/ADMIN rather than staff-wide. The role check lives at the page and
 * the action; this module is the shape of the data, not the gate.
 *
 * Each row is flattened into plain values before it leaves. The review screens
 * are client components in places, and handing a Prisma row across that boundary
 * would ship columns nobody asked for.
 */

import type { DegreeLevel, RegistrationStatus } from '@prisma/client';

import { prisma } from '@/lib/db';

import { bundleIndex, type QuarantineBundle } from './quarantine';
import type { RegistrationRuleFacts } from './rules';

/// One line on the queue. Everything a reviewer needs to triage without opening
/// the application.
export type RegistrationRow = {
  id: string;
  name: string;
  email: string;
  usn: string | null;
  phone: string | null;
  degreeLevel: DegreeLevel;
  status: RegistrationStatus;
  decisionReason: string | null;
  matchedRuleName: string | null;
  cohortName: string | null;
  emailVerifiedAt: Date | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  approvedStudentId: string | null;
  createdAt: Date;
  /// From the quarantine manifest — the applicant's answers the table has no
  /// column for, plus whether there is anything to look at.
  programme: string | null;
  branch: string | null;
  city: string | null;
  linkedinUrl: string | null;
  hasCv: boolean;
  hasPhoto: boolean;
};

/// The two halves of the screen. "Waiting" is what a director is there to clear;
/// "settled" is the audit trail underneath it.
export type RegistrationQueue = {
  waiting: RegistrationRow[];
  settled: RegistrationRow[];
  counts: Record<'awaitingEmail' | 'awaitingReview' | 'approved' | 'rejected', number>;
};

const ROW_SELECT = {
  id: true,
  name: true,
  email: true,
  usn: true,
  phone: true,
  degreeLevel: true,
  status: true,
  decisionReason: true,
  emailVerifiedAt: true,
  reviewedAt: true,
  reviewNote: true,
  approvedStudentId: true,
  createdAt: true,
  matchedRule: { select: { name: true } },
  cohort: { select: { name: true } },
} as const;

type RawRow = {
  id: string;
  name: string;
  email: string;
  usn: string | null;
  phone: string | null;
  degreeLevel: DegreeLevel;
  status: RegistrationStatus;
  decisionReason: string | null;
  emailVerifiedAt: Date | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  approvedStudentId: string | null;
  createdAt: Date;
  matchedRule: { name: string } | null;
  cohort: { name: string } | null;
};

function toRow(raw: RawRow, bundle: QuarantineBundle | undefined): RegistrationRow {
  return {
    id: raw.id,
    name: raw.name,
    email: raw.email,
    usn: raw.usn,
    phone: raw.phone,
    degreeLevel: raw.degreeLevel,
    status: raw.status,
    decisionReason: raw.decisionReason,
    matchedRuleName: raw.matchedRule?.name ?? null,
    cohortName: raw.cohort?.name ?? null,
    emailVerifiedAt: raw.emailVerifiedAt,
    reviewedAt: raw.reviewedAt,
    reviewNote: raw.reviewNote,
    approvedStudentId: raw.approvedStudentId,
    createdAt: raw.createdAt,
    programme: bundle?.extras?.programme ?? null,
    branch: bundle?.extras?.branch ?? null,
    city: bundle?.extras?.city ?? null,
    linkedinUrl: bundle?.extras?.linkedinUrl ?? null,
    hasCv: Boolean(bundle?.cv),
    hasPhoto: Boolean(bundle?.photo),
  };
}

/**
 * The queue.
 *
 * The two lists are separate queries rather than one query partitioned in
 * memory, because the settled half is capped: an audit trail that grows without
 * bound turns the screen a director opens every morning into a slow one. The
 * waiting half is never capped — a queue that hides its tail is a queue that
 * loses applications.
 */
export async function loadRegistrationQueue(settledLimit = 40): Promise<RegistrationQueue> {
  const [waitingRaw, settledRaw, grouped, bundles] = await Promise.all([
    prisma.registration.findMany({
      where: { status: { in: ['PENDING_VERIFICATION', 'PENDING_REVIEW', 'DRAFT'] } },
      select: ROW_SELECT,
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.registration.findMany({
      where: { status: { in: ['AUTO_APPROVED', 'APPROVED', 'REJECTED'] } },
      select: ROW_SELECT,
      orderBy: { updatedAt: 'desc' },
      take: settledLimit,
    }),
    prisma.registration.groupBy({ by: ['status'], _count: { _all: true } }),
    bundleIndex(),
  ]);

  const count = (status: RegistrationStatus) =>
    grouped.find((row) => row.status === status)?._count._all ?? 0;

  return {
    waiting: waitingRaw.map((row) => toRow(row, bundles.get(row.id))),
    settled: settledRaw.map((row) => toRow(row, bundles.get(row.id))),
    counts: {
      awaitingEmail: count('PENDING_VERIFICATION') + count('DRAFT'),
      awaitingReview: count('PENDING_REVIEW'),
      approved: count('APPROVED') + count('AUTO_APPROVED'),
      rejected: count('REJECTED'),
    },
  };
}

export type RegistrationDetail = {
  row: RegistrationRow;
  bundle: QuarantineBundle | null;
  /// Cohorts the applicant is eligible for, narrowed to their degree level —
  /// `Cohort.degreeLevel` exists precisely so a PG applicant is not offered a UG
  /// batch, and the approval form is where that would otherwise go wrong.
  cohorts: { id: string; code: string; name: string; batchLabel: string }[];
};

export async function loadRegistrationDetail(id: string): Promise<RegistrationDetail | null> {
  const raw = await prisma.registration.findUnique({ where: { id }, select: ROW_SELECT });
  if (!raw) return null;

  const [bundles, cohorts] = await Promise.all([
    bundleIndex(),
    prisma.cohort.findMany({
      where: { degreeLevel: raw.degreeLevel },
      select: { id: true, code: true, name: true, batchLabel: true },
      orderBy: { startDate: 'desc' },
    }),
  ]);

  return { row: toRow(raw, bundles.get(raw.id)), bundle: bundles.get(raw.id) ?? null, cohorts };
}

/**
 * The rules, as the pure decision function wants them.
 *
 * Every row, not only the enabled ones: `decideRegistration` filters on
 * `enabled` itself, and it also has to be able to say "no rule is enabled" —
 * which it cannot do if the query has already hidden that fact.
 */
export async function loadRuleFacts(): Promise<RegistrationRuleFacts[]> {
  return prisma.registrationRule.findMany({
    select: {
      id: true,
      name: true,
      enabled: true,
      emailDomain: true,
      usnPattern: true,
      degreeLevel: true,
      cohortId: true,
      autoApprove: true,
      priority: true,
    },
    orderBy: [{ priority: 'asc' }, { name: 'asc' }],
  });
}

/// The same rows with their cohort names, for the panel that shows a director
/// what is currently deciding.
export type RuleRow = RegistrationRuleFacts & { cohortName: string | null };

export async function loadRules(): Promise<RuleRow[]> {
  const rules = await prisma.registrationRule.findMany({
    select: {
      id: true,
      name: true,
      enabled: true,
      emailDomain: true,
      usnPattern: true,
      degreeLevel: true,
      cohortId: true,
      autoApprove: true,
      priority: true,
      cohort: { select: { name: true } },
    },
    orderBy: [{ priority: 'asc' }, { name: 'asc' }],
  });

  return rules.map(({ cohort, ...rule }) => ({ ...rule, cohortName: cohort?.name ?? null }));
}
