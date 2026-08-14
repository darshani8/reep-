/**
 * A student's academic history — the 10th → PG chain, backlogs and gaps that the
 * eligibility engine reads (roadmap Phase B). The model decoded from pod.ai's
 * /academics page.
 *
 * The student edits the qualifications they own (school marks, prior degrees)
 * and their gap months. Per-semester CGPA and backlogs are staff-imported truth
 * (`SemesterResult`) and returned read-only, so a student cannot mark their own
 * backlogs cleared to slip past an eligibility gate.
 */

import { Injectable } from '@nestjs/common';
import type { QualificationLevel } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

const LEVELS: QualificationLevel[] = ['TENTH', 'TWELFTH', 'DIPLOMA', 'UNDERGRAD', 'POSTGRAD'];

export interface QualificationInput {
  level: QualificationLevel;
  institution: string;
  board?: string | null;
  year: number;
  marks: number;
  maxMarks?: number;
  medium?: string | null;
  location?: string | null;
  subjects?: string | null;
}

export interface AcademicsView {
  qualifications: (QualificationInput & { id: string })[];
  gap: { twelfthToGradMo: number; diplomaToGradMo: number; gradToPgMo: number; otherMo: number };
  /// Staff-imported, read-only to the student.
  semesters: { semester: number; cgpa: number | null; closedBacklogs: number; liveBacklogs: number }[];
}

@Injectable()
export class AcademicsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(studentId: string): Promise<AcademicsView> {
    const [quals, gap, results] = await Promise.all([
      this.prisma.academicQualification.findMany({
        where: { studentId },
        orderBy: { year: 'asc' },
      }),
      this.prisma.academicGap.findUnique({ where: { studentId } }),
      this.prisma.semesterResult.findMany({
        where: { studentId },
        select: { semester: true, cgpa: true, closedBacklogs: true, liveBacklogs: true },
        orderBy: { semester: 'asc' },
      }),
    ]);

    return {
      qualifications: quals.map((q) => ({
        id: q.id,
        level: q.level,
        institution: q.institution,
        board: q.board,
        year: q.year,
        marks: q.marks,
        maxMarks: q.maxMarks,
        medium: q.medium,
        location: q.location,
        subjects: q.subjects,
      })),
      gap: {
        twelfthToGradMo: gap?.twelfthToGradMo ?? 0,
        diplomaToGradMo: gap?.diplomaToGradMo ?? 0,
        gradToPgMo: gap?.gradToPgMo ?? 0,
        otherMo: gap?.otherMo ?? 0,
      },
      semesters: results,
    };
  }

  /// Replace the student's qualifications and upsert their gap in one
  /// transaction — the form saves the whole history at once, so a partial write
  /// that left a stale row behind would misreport the chain.
  async save(
    studentId: string,
    dto: { qualifications: QualificationInput[]; gap: AcademicsView['gap'] },
  ): Promise<AcademicsView> {
    const clean = (dto.qualifications ?? [])
      .filter((q) => LEVELS.includes(q.level) && q.institution?.trim() && Number.isFinite(q.year))
      .map((q) => ({
        studentId,
        level: q.level,
        institution: q.institution.trim(),
        board: q.board?.trim() || null,
        year: Math.round(q.year),
        marks: Number.isFinite(q.marks) ? q.marks : 0,
        maxMarks: q.maxMarks && q.maxMarks > 0 ? q.maxMarks : 100,
        medium: q.medium?.trim() || null,
        location: q.location?.trim() || null,
        subjects: q.subjects?.trim() || null,
      }));

    const nn = (v: number) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
    const gap = {
      twelfthToGradMo: nn(dto.gap?.twelfthToGradMo),
      diplomaToGradMo: nn(dto.gap?.diplomaToGradMo),
      gradToPgMo: nn(dto.gap?.gradToPgMo),
      otherMo: nn(dto.gap?.otherMo),
    };

    await this.prisma.$transaction([
      this.prisma.academicQualification.deleteMany({ where: { studentId } }),
      ...(clean.length ? [this.prisma.academicQualification.createMany({ data: clean })] : []),
      this.prisma.academicGap.upsert({
        where: { studentId },
        create: { studentId, ...gap },
        update: gap,
      }),
    ]);

    return this.get(studentId);
  }
}
