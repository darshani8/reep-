/**
 * Student-facing reads. Begins with the header meta the shell shows — the port
 * of the query in src/app/student/layout.tsx — and grows one screen's data at a
 * time as the migration proceeds. Every method is scoped to a studentId the
 * caller has already proven belongs to the session, never a client-supplied id.
 */

import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { STAGE_LABEL } from '../reep/stage';

export interface StudentMeta {
  usn: string;
  currentStage: string;
  stageLabel: string;
  currentSemester: number;
}

@Injectable()
export class StudentService {
  constructor(private readonly prisma: PrismaService) {}

  async meta(studentId: string): Promise<StudentMeta> {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: { usn: true, currentStage: true, currentSemester: true },
    });
    if (!student) throw new NotFoundException('Student record not found.');

    return {
      usn: student.usn,
      currentStage: student.currentStage,
      stageLabel: STAGE_LABEL[student.currentStage],
      currentSemester: student.currentSemester,
    };
  }
}
