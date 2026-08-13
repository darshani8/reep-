import 'server-only';

/**
 * Everything `/student/skilling` reads, and the one write it performs on read.
 *
 * The write needs explaining, because a Server Component that mutates on load
 * is normally a smell. `syncClaimVerdicts` exists because this feature refused
 * to build a second approval mechanism. A mentor verifies the *file*, on the
 * queue at `/mentor/uploads`, using the review route that already exists — and
 * that route knows about certifications, not about skills. Rather than teach it
 * a second job (and give a future third caller a way to grant a badge without
 * going through the same rule), the claim inherits its verdict from the upload,
 * and the inheritance is applied the next time anyone looks.
 *
 * That makes the upload's status the single source of truth and the claim a
 * projection of it. The projection is idempotent — `promotionFor` refuses to
 * re-decide anything already decided — so running it on every page load, from
 * the API route, and from a future landing page is safe in any order.
 *
 * This module is the half that talks to Prisma. The rules it applies live in
 * `claim-rules.ts` and `recommend.ts`, neither of which imports `server-only`,
 * so both stay testable from a bare Node process. Same split as
 * `activity-rules.ts` against `activity-log.ts`.
 */

import type { UploadStatus } from '@prisma/client';

import type { SkillBadgeRow, SkillClaimRow } from '@/components/skill-badges';

import { prisma } from '../db';
import { relativeDay } from '../reep';
import {
  CLAIM_STATUS_LABEL,
  CLAIM_STATUS_TONE,
  clampLevel,
  levelLabel,
  promotionFor,
} from './claim-rules';
import {
  RECOMMENDATION_COUNT,
  type CatalogueSkill,
  demandBySlug,
  recommendSkills,
  type SkillRecommendation,
} from './recommend';

/// One row of the catalogue browser: a skill, whether this student has it, and
/// how much the board wants it.
export type CatalogueEntry = CatalogueSkill & {
  /// `null` when the student does not hold the skill at all.
  holding: { level: number; levelLabel: string; verified: boolean } | null;
  /// A claim in flight for this skill, if any — so the browser can say "you
  /// already asked" instead of offering the button again.
  claimStatus: UploadStatus | null;
  demandCount: number;
};

export type SkillingBoard = {
  badges: SkillBadgeRow[];
  /// Claims worth showing: still waiting, or refused and needing another file.
  /// A granted claim is already on the wall as a verified badge.
  openClaims: SkillClaimRow[];
  recommendations: SkillRecommendation[];
  catalogue: CatalogueEntry[];
  /// Skills the student may still file a claim against, for the upload form.
  claimable: { slug: string; name: string; category: string }[];
  counts: {
    verified: number;
    declared: number;
    awaiting: number;
    rejected: number;
    catalogue: number;
  };
  /// How many open postings at this cohort's degree level the demand figures
  /// were counted from — so the page can say "of 12 open PG postings" rather
  /// than leaving the numbers unexplained, and can say something honest when
  /// the board is empty.
  openJobCount: number;
};

/**
 * Apply every mentor verdict that has not reached its claim yet.
 *
 * Scoped to one student because that is the only caller shape there is so far;
 * a nightly job over the whole table would be the same query without the
 * `studentId`. Returns how many claims moved, which is only used by the tests
 * and by a `console` in development, but is worth having when the question
 * "why did this badge light up" comes back.
 */
export async function syncClaimVerdicts(studentId: string): Promise<number> {
  const stale = await prisma.skillClaim.findMany({
    where: { studentId, status: 'PENDING_REVIEW', upload: { status: { not: 'PENDING_REVIEW' } } },
    include: { upload: { select: { id: true, status: true, reviewedById: true, reviewedAt: true, reviewNote: true } } },
  });

  let moved = 0;

  for (const claim of stale) {
    const promotion = promotionFor(claim, claim.upload);
    if (promotion.kind === 'unchanged') continue;

    const stamp = {
      reviewedById: claim.upload.reviewedById,
      reviewedAt: claim.upload.reviewedAt ?? new Date(),
      reviewNote: claim.upload.reviewNote,
    };

    if (promotion.kind === 'reject') {
      await prisma.skillClaim.update({
        where: { id: claim.id },
        data: { status: 'REJECTED', ...stamp },
      });
      moved += 1;
      continue;
    }

    // The grant. Both writes go together or neither does: a claim marked
    // VERIFIED with no skill behind it shows the student a badge that is not on
    // their profile, and a skill marked verified with the claim still pending
    // is the gameable case this whole feature exists to prevent.
    await prisma.$transaction([
      prisma.skillClaim.update({
        where: { id: claim.id },
        data: { status: 'VERIFIED', ...stamp },
      }),
      prisma.studentSkill.upsert({
        where: { studentId_skillId: { studentId, skillId: claim.skillId } },
        create: {
          studentId,
          skillId: claim.skillId,
          level: promotion.level,
          verified: true,
          evidenceUploadId: claim.upload.id,
        },
        // `level` is deliberately absent here. A verified claim may *raise* a
        // level but never lower one the student already earned elsewhere — the
        // mentor granted this piece of evidence, they did not re-assess the
        // whole profile. The raise is the next statement, conditioned on the
        // stored level actually being lower.
        update: {
          verified: true,
          evidenceUploadId: claim.upload.id,
        },
      }),
      prisma.studentSkill.updateMany({
        where: { studentId, skillId: claim.skillId, level: { lt: promotion.level } },
        data: { level: promotion.level },
      }),
    ]);
    moved += 1;
  }

  return moved;
}

/**
 * The whole page in one call.
 *
 * Written as a single function rather than six exported queries because every
 * figure on the screen has to be counted from the same snapshot: a badge wall
 * that disagrees with the "verified" statistic above it, or a catalogue that
 * offers a claim button for a skill the student just claimed, is worse than a
 * slower page.
 */
export async function loadSkillingBoard(
  studentId: string,
  asOf: Date = new Date(),
): Promise<SkillingBoard | null> {
  await syncClaimVerdicts(studentId);

  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: { currentStage: true, cohort: { select: { degreeLevel: true } } },
  });
  if (!student) return null;

  const degreeLevel = student.cohort.degreeLevel;

  const [catalogue, holdings, claims, jobs] = await Promise.all([
    prisma.skill.findMany({
      select: { id: true, slug: true, name: true, category: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    }),
    prisma.studentSkill.findMany({
      where: { studentId },
      select: {
        level: true,
        verified: true,
        evidenceUploadId: true,
        skill: { select: { slug: true, name: true, category: true } },
      },
    }),
    prisma.skillClaim.findMany({
      where: { studentId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        claimedLevel: true,
        status: true,
        reviewNote: true,
        createdAt: true,
        uploadId: true,
        skill: { select: { slug: true, name: true } },
      },
    }),
    // Only what the ranking is allowed to count. `closesOn: null` is an open
    // posting with no stated deadline, and Prisma will not fold that into the
    // `gte` comparison, so it has to be spelt out as an alternative.
    prisma.job.findMany({
      where: {
        degreeLevel,
        OR: [{ closesOn: null }, { closesOn: { gte: asOf } }],
      },
      select: { degreeLevel: true, requiredSkills: true, closesOn: true },
    }),
  ]);

  const badges: SkillBadgeRow[] = holdings
    .map((row) => ({
      slug: row.skill.slug,
      name: row.skill.name,
      category: row.skill.category,
      level: clampLevel(row.level),
      levelLabel: levelLabel(row.level),
      verified: row.verified,
      evidenceHref: row.evidenceUploadId ? `/api/uploads/${row.evidenceUploadId}` : null,
    }))
    .sort(
      (a, b) =>
        Number(b.verified) - Number(a.verified) ||
        b.level - a.level ||
        a.name.localeCompare(b.name),
    );

  const claimRows: SkillClaimRow[] = claims.map((claim) => ({
    id: claim.id,
    slug: claim.skill.slug,
    name: claim.skill.name,
    claimedLevel: clampLevel(claim.claimedLevel),
    levelLabel: levelLabel(claim.claimedLevel),
    status: claim.status,
    statusLabel: CLAIM_STATUS_LABEL[claim.status],
    statusTone: CLAIM_STATUS_TONE[claim.status],
    filedLabel: `filed ${relativeDay(claim.createdAt, asOf)}`,
    reviewNote: claim.reviewNote,
    evidenceHref: `/api/uploads/${claim.uploadId}`,
  }));

  const openClaims = claimRows.filter((row) => row.status !== 'VERIFIED');
  const heldSlugs = new Set(holdings.map((row) => row.skill.slug));
  const pendingBySlug = new Map(
    claims.filter((c) => c.status === 'PENDING_REVIEW').map((c) => [c.skill.slug, c.status]),
  );
  const demand = demandBySlug(jobs, degreeLevel, asOf);

  const catalogueRows: CatalogueEntry[] = catalogue.map((skill) => {
    const holding = holdings.find((row) => row.skill.slug === skill.slug);
    return {
      slug: skill.slug,
      name: skill.name,
      category: skill.category,
      holding: holding
        ? {
            level: clampLevel(holding.level),
            levelLabel: levelLabel(holding.level),
            verified: holding.verified,
          }
        : null,
      claimStatus: pendingBySlug.get(skill.slug) ?? null,
      demandCount: demand.get(skill.slug) ?? 0,
    };
  });

  return {
    badges,
    openClaims,
    recommendations: recommendSkills({
      catalogue,
      heldSlugs,
      jobs,
      degreeLevel,
      stage: student.currentStage,
      asOf,
      count: RECOMMENDATION_COUNT,
    }),
    catalogue: catalogueRows,
    // A skill is claimable unless it is already verified or already queued.
    // Self-declared skills stay claimable: filing a certificate against one is
    // exactly how a student turns their own word into a mentor's.
    claimable: catalogueRows
      .filter((row) => !row.holding?.verified && row.claimStatus === null)
      .map(({ slug, name, category }) => ({ slug, name, category })),
    counts: {
      verified: badges.filter((row) => row.verified).length,
      declared: badges.filter((row) => !row.verified).length,
      awaiting: claimRows.filter((row) => row.status === 'PENDING_REVIEW').length,
      rejected: claimRows.filter((row) => row.status === 'REJECTED').length,
      catalogue: catalogue.length,
    },
    openJobCount: jobs.length,
  };
}
