/**
 * The jobs board, server-side.
 *
 * Ports getJobsBoard() from src/lib/jobs/board.ts and the per-row shaping the
 * React page did in toRow()/describeClosing(). Everything the table needs is
 * computed here — match percentage, closing label, application state — so the
 * Angular side renders ready rows rather than re-deriving them. The match uses
 * the verbatim-ported match.ts: no LLM, no egress, same number every load.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import type { DegreeLevel } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { OPENED_NOTE, applicationState } from './application';
import {
  matchJob,
  matchSummary,
  type CatalogueSkill,
  type HeldSkill,
  type MatchBand,
} from './match';
import { relativeDay } from './relative-day';
import { eligibleFor, type EligibilityCriteria, type StudentEligibilityFacts } from '../placement/eligibility';

type Tone = 'good' | 'warning' | 'critical' | 'info' | 'neutral' | 'accent';

/// A match is never coloured as a warning — a 30% fit is information, not a
/// problem with the student. Ported from the React page's BAND_TONE.
const BAND_TONE: Record<MatchBand, Tone> = { strong: 'good', fair: 'info', weak: 'neutral' };

export interface JobRow {
  id: string;
  title: string;
  company: string;
  location: string;
  degreeLevel: DegreeLevel;
  postedLabel: string;
  closesLabel: string;
  closesTone: Tone;
  closesSort: number;
  isClosed: boolean;
  matchPct: number | null;
  matchSort: number;
  matchLabel: string;
  matchHint: string;
  matchTone: Tone;
  applyUrl: string | null;
  applied: boolean;
  openedLabel: string | null;
  /// Whether the student may apply to THIS posting (its cut-offs, or the active
  /// default). `eligibilityReasons` is empty when eligible, else the exact
  /// blockers, so the board can tell them what to fix.
  eligible: boolean;
  eligibilityReasons: string[];
}

export interface JobsBoardView {
  ownLevel: DegreeLevel;
  counts: Record<DegreeLevel, number>;
  heldCount: number;
  verifiedSkills: number;
  /// The student's own baseline: are they cleared to apply at all, and their
  /// figures, so the board can show a one-line eligibility summary.
  eligibility: {
    placementEligible: boolean;
    latestCgpa: number | null;
    liveBacklogs: number;
    totalGapMonths: number;
  };
  rows: JobRow[];
}

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
  minCgpa: true,
  maxLiveBacklogs: true,
} as const;

const DEFAULT_CRITERIA: EligibilityCriteria = { minCgpa: 6.0, maxLiveBacklogs: 0, maxGapMonths: 24 };

@Injectable()
export class JobsService {
  constructor(private readonly prisma: PrismaService) {}

  async board(studentId: string): Promise<JobsBoardView> {
    const [student, jobs, catalogue, held, applications, profile, results, gap, criteriaRow] =
      await Promise.all([
        this.prisma.student.findUnique({
          where: { id: studentId },
          select: { cohort: { select: { degreeLevel: true } } },
        }),
        this.prisma.job.findMany({
          orderBy: [{ postedOn: 'desc' }, { company: 'asc' }],
          select: BOARD_JOB_FIELDS,
        }),
        this.prisma.skill.findMany({ select: { slug: true, name: true, aliases: true } }),
        this.prisma.studentSkill.findMany({
          where: { studentId },
          select: { level: true, verified: true, skill: { select: { slug: true } } },
        }),
        this.prisma.jobApplication.findMany({
          where: { studentId },
          select: { jobId: true, notes: true, appliedAt: true },
        }),
        this.prisma.studentProfile.findUnique({
          where: { studentId },
          select: { placementEligible: true, interestedInJobs: true, interestedInInternships: true },
        }),
        this.prisma.semesterResult.findMany({
          where: { studentId },
          select: { semester: true, cgpa: true, liveBacklogs: true },
          orderBy: { semester: 'desc' },
        }),
        this.prisma.academicGap.findUnique({ where: { studentId } }),
        this.prisma.placementCriteria.findFirst({ where: { active: true } }),
      ]);

    if (!student) throw new NotFoundException('Student record not found.');

    const heldSkills: HeldSkill[] = held.map((row) => ({
      slug: row.skill.slug,
      level: row.level,
      verified: row.verified,
    }));
    const catalogueSkills: CatalogueSkill[] = catalogue;
    const apps = new Map(applications.map((a) => [a.jobId, { notes: a.notes, appliedAt: a.appliedAt }]));
    const now = new Date();

    // The student's placement facts, gathered once and read against each posting.
    const latestCgpa = results.find((r) => r.cgpa != null)?.cgpa ?? null;
    const liveBacklogs = results.reduce((sum, r) => sum + r.liveBacklogs, 0);
    const totalGapMonths = gap
      ? gap.twelfthToGradMo + gap.diplomaToGradMo + gap.gradToPgMo + gap.otherMo
      : 0;
    const facts: StudentEligibilityFacts = {
      placementEligible: profile?.placementEligible ?? true,
      latestCgpa,
      liveBacklogs,
      totalGapMonths,
      interestedInJobs: profile?.interestedInJobs ?? true,
      interestedInInternships: profile?.interestedInInternships ?? true,
    };
    const defaultCriteria: EligibilityCriteria = criteriaRow
      ? {
          minCgpa: criteriaRow.minCgpa,
          maxLiveBacklogs: criteriaRow.maxLiveBacklogs,
          maxGapMonths: criteriaRow.maxGapMonths,
        }
      : DEFAULT_CRITERIA;

    const rows = jobs.map((job) => this.toRow(job, catalogueSkills, heldSkills, apps, now, facts, defaultCriteria));

    const counts = {
      UG: jobs.filter((j) => j.degreeLevel === 'UG').length,
      PG: jobs.filter((j) => j.degreeLevel === 'PG').length,
    } as Record<DegreeLevel, number>;

    return {
      ownLevel: student.cohort.degreeLevel,
      counts,
      heldCount: heldSkills.length,
      verifiedSkills: heldSkills.filter((s) => s.verified).length,
      eligibility: { placementEligible: facts.placementEligible, latestCgpa, liveBacklogs, totalGapMonths },
      rows,
    };
  }

  private toRow(
    job: {
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
      minCgpa: number | null;
      maxLiveBacklogs: number | null;
    },
    catalogue: CatalogueSkill[],
    held: HeldSkill[],
    apps: Map<string, { notes: string | null; appliedAt: Date }>,
    now: Date,
    facts: StudentEligibilityFacts,
    defaultCriteria: EligibilityCriteria,
  ): JobRow {
    const match = matchJob(job, catalogue, held);
    const summary = matchSummary(match);
    const closes = describeClosing(job.closesOn, now);
    const application = apps.get(job.id);
    const state = applicationState(application);

    // This posting's own cut-offs override the active default where set.
    const verdict = eligibleFor(facts, {
      minCgpa: job.minCgpa ?? defaultCriteria.minCgpa,
      maxLiveBacklogs: job.maxLiveBacklogs ?? defaultCriteria.maxLiveBacklogs,
      maxGapMonths: defaultCriteria.maxGapMonths,
    }, { roleType: 'FULL_TIME' });

    return {
      id: job.id,
      title: job.title,
      company: job.company,
      location: job.location ?? '',
      degreeLevel: job.degreeLevel,
      postedLabel: `posted ${relativeDay(job.postedOn, now).toLowerCase()}`,
      closesLabel: closes.label,
      closesTone: closes.tone,
      closesSort: closes.sort,
      isClosed: closes.closed,
      matchPct: match.kind === 'scored' ? match.pct : null,
      matchSort: match.kind === 'scored' ? match.pct : -1,
      matchLabel: summary.label,
      matchHint: summary.hint,
      matchTone: summary.band ? BAND_TONE[summary.band] : 'neutral',
      applyUrl: job.applyUrl,
      applied: state === 'applied',
      openedLabel:
        state === 'opened' && application
          ? `Opened ${relativeDay(application.appliedAt, now).toLowerCase()}`
          : null,
      eligible: verdict.eligible,
      eligibilityReasons: verdict.reasons,
    };
  }

  /// The student's own "have you applied?" tick. selfReported is hard-coded true
  /// and clearing it deletes the row — ported from setApplied() in board.ts.
  async setApplied(studentId: string, jobId: string, applied: boolean): Promise<{ ok: true }> {
    if (!(await this.jobExists(jobId))) throw new NotFoundException('No such vacancy.');

    if (!applied) {
      await this.prisma.jobApplication.deleteMany({ where: { studentId, jobId } });
      return { ok: true };
    }
    await this.prisma.jobApplication.upsert({
      where: { studentId_jobId: { studentId, jobId } },
      create: { studentId, jobId, selfReported: true, notes: null, appliedAt: new Date() },
      update: { selfReported: true, notes: null, appliedAt: new Date() },
    });
    return { ok: true };
  }

  /// The student followed the employer link — recorded as an intent, never as a
  /// claim. Ported from recordApplyIntent() in board.ts.
  async recordOpen(studentId: string, jobId: string): Promise<{ ok: true }> {
    if (!(await this.jobExists(jobId))) throw new NotFoundException('No such vacancy.');
    await this.prisma.jobApplication.createMany({
      data: [{ studentId, jobId, selfReported: true, notes: OPENED_NOTE }],
      skipDuplicates: true,
    });
    return { ok: true };
  }

  private async jobExists(jobId: string): Promise<boolean> {
    return (await this.prisma.job.count({ where: { id: jobId } })) > 0;
  }
}

/// Plain words rather than a date to subtract, plus a day `sort`. Ported from
/// describeClosing() in the React jobs page.
function describeClosing(
  closesOn: Date | null,
  now: Date,
): { label: string; tone: Tone; sort: number; closed: boolean } {
  if (!closesOn) return { label: 'No closing date', tone: 'neutral', sort: 9_999, closed: false };

  const startOf = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(closesOn) - startOf(now)) / 86_400_000);

  if (days < 0) return { label: 'Closed', tone: 'neutral', sort: 10_000, closed: true };
  if (days === 0) return { label: 'Closes today', tone: 'critical', sort: 0, closed: false };
  return {
    label: days === 1 ? '1 day left' : `${days} days left`,
    tone: days <= 3 ? 'critical' : days <= 7 ? 'warning' : 'neutral',
    sort: days,
    closed: false,
  };
}
