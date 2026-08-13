import 'server-only';

/**
 * Everything the jobs board reads and the two things it writes.
 *
 * It lives here rather than in `queries.ts` for the reason the match module
 * lives apart from the page: the board asks four unrelated questions — which
 * vacancies exist, which degree level the student is on, which skills they can
 * prove, and what they have said about each posting — and the answer to all
 * four has to arrive in one round trip or the board renders in four.
 *
 * The skill catalogue comes back whole (eighty rows) rather than filtered to
 * the student's own skills, because `matchJob` needs it to find a skill the
 * *description* asks for and the student does not hold. Filtering it to what
 * they already have would make every gap invisible, which is the half of the
 * match a student actually needs.
 */

import type { DegreeLevel } from '@prisma/client';

import { prisma } from '@/lib/db';

import { OPENED_NOTE } from './application';
import type { CatalogueSkill, HeldSkill } from './match';

/// A posting as the board renders it. Narrower than the `Job` row on purpose —
/// `importRunId` and the timestamps are staff provenance, not student-facing.
export type BoardJob = {
  id: string;
  title: string;
  company: string;
  degreeLevel: DegreeLevel;
  location: string | null;
  applyUrl: string | null;
  description: string;
  requiredSkills: string[];
  postedOn: Date;
  closesOn: Date | null;
};

export type BoardData = {
  /// The student's own level, from their cohort. The default tab.
  ownLevel: DegreeLevel;
  jobs: BoardJob[];
  catalogue: CatalogueSkill[];
  held: HeldSkill[];
  /// jobId → the note on their application row, absent when there is none.
  /// `applicationState()` turns it into a state; the board never reads it raw.
  applications: Map<string, { notes: string | null; appliedAt: Date }>;
};

const BOARD_JOB_FIELDS = {
  id: true,
  title: true,
  company: true,
  degreeLevel: true,
  location: true,
  applyUrl: true,
  description: true,
  requiredSkills: true,
  postedOn: true,
  closesOn: true,
} as const;

/// Null when the id resolves to no student — the caller turns that into a 404
/// rather than rendering an empty board that looks like "no vacancies".
export async function getJobsBoard(studentId: string): Promise<BoardData | null> {
  const [student, jobs, catalogue, held, applications] = await Promise.all([
    prisma.student.findUnique({
      where: { id: studentId },
      select: { cohort: { select: { degreeLevel: true } } },
    }),
    prisma.job.findMany({
      // Both levels, always. The tabs are a filter over this, and a student is
      // entitled to look at the other one — a PG student wanting to see what
      // the UG board carries is not doing anything wrong.
      orderBy: [{ postedOn: 'desc' }, { company: 'asc' }],
      select: BOARD_JOB_FIELDS,
    }),
    prisma.skill.findMany({ select: { slug: true, name: true, aliases: true } }),
    prisma.studentSkill.findMany({
      where: { studentId },
      select: { level: true, verified: true, skill: { select: { slug: true } } },
    }),
    prisma.jobApplication.findMany({
      where: { studentId },
      select: { jobId: true, notes: true, appliedAt: true },
    }),
  ]);

  if (!student) return null;

  return {
    ownLevel: student.cohort.degreeLevel,
    jobs,
    catalogue,
    held: held.map((row) => ({
      slug: row.skill.slug,
      level: row.level,
      verified: row.verified,
    })),
    applications: new Map(
      applications.map((row) => [row.jobId, { notes: row.notes, appliedAt: row.appliedAt }]),
    ),
  };
}

/// Canonical slug → display name, for the slugs one posting names. Used to
/// write the job brief in words rather than in slugs.
export async function skillNamesFor(slugs: string[]): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();
  const skills = await prisma.skill.findMany({
    where: { slug: { in: slugs } },
    select: { slug: true, name: true },
  });
  return new Map(skills.map((skill) => [skill.slug, skill.name]));
}

/// One posting plus the same skill context, for the per-job CV screen.
export async function getJobForStudent(studentId: string, jobId: string) {
  const [job, catalogue, held, application, lastResume] = await Promise.all([
    prisma.job.findUnique({ where: { id: jobId }, select: BOARD_JOB_FIELDS }),
    prisma.skill.findMany({ select: { slug: true, name: true, aliases: true } }),
    prisma.studentSkill.findMany({
      where: { studentId },
      select: { level: true, verified: true, skill: { select: { slug: true } } },
    }),
    prisma.jobApplication.findUnique({
      where: { studentId_jobId: { studentId, jobId } },
      select: { notes: true, appliedAt: true },
    }),
    // Only for prefilling the industry field. `Job` carries no industry column,
    // and asking a student to retype "IT services" for every posting is the
    // kind of friction that stops them using the builder at all.
    prisma.resume.findFirst({
      where: { studentId, targetIndustry: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { targetIndustry: true },
    }),
  ]);

  if (!job) return null;

  return {
    job,
    catalogue,
    held: held.map((row) => ({ slug: row.skill.slug, level: row.level, verified: row.verified })),
    application,
    lastIndustry: lastResume?.targetIndustry ?? null,
    /// Every version this student has already tailored to this posting.
    resumes: await prisma.resume.findMany({
      where: { studentId, jobId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, version: true, title: true, createdAt: true, generatedBy: true },
    }),
  };
}

// ---------------------------------------------------------------------------
// The two writes
// ---------------------------------------------------------------------------

/**
 * The student followed the employer's link.
 *
 * Recorded as a row marked with `OPENED_NOTE` — see `application.ts` for why
 * the marker is a note rather than a column. `createMany` with
 * `skipDuplicates` rather than an upsert is the point: opening a posting a
 * second time must not touch a row that has since become an attestation, and a
 * plain create would throw on the unique index.
 */
export async function recordApplyIntent(studentId: string, jobId: string): Promise<void> {
  await prisma.jobApplication.createMany({
    data: [{ studentId, jobId, selfReported: true, notes: OPENED_NOTE }],
    skipDuplicates: true,
  });
}

/**
 * The student's own answer to "have you applied?".
 *
 * `selfReported` is hard-coded true and has no way of being set otherwise from
 * this path: REEP cannot see the employer's portal, and a row that claimed
 * otherwise would let a placement report count a tick as a confirmed
 * submission. Clearing the box deletes the row rather than downgrading it —
 * nothing distinguishes "opened but did not apply" from "ticked by mistake",
 * and the honest reading of an unticked box is that REEP should hold nothing.
 */
export async function setApplied(
  studentId: string,
  jobId: string,
  applied: boolean,
): Promise<void> {
  if (!applied) {
    await prisma.jobApplication.deleteMany({ where: { studentId, jobId } });
    return;
  }

  await prisma.jobApplication.upsert({
    where: { studentId_jobId: { studentId, jobId } },
    create: { studentId, jobId, selfReported: true, notes: null, appliedAt: new Date() },
    // The note is cleared, which is what turns a recorded intent into a claim.
    update: { selfReported: true, notes: null, appliedAt: new Date() },
  });
}

/// Does this posting exist? Used by the write paths, which must not create an
/// application against an id a crafted POST invented.
export async function jobExists(jobId: string): Promise<boolean> {
  return (await prisma.job.count({ where: { id: jobId } })) > 0;
}
