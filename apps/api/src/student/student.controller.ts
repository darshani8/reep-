import { Controller, Get, UseGuards } from '@nestjs/common';

import { BadRequestException } from '@nestjs/common';

import { Roles, Session, SessionGuard } from '../auth/session.guard';
import type { SessionPayload } from '../auth/session.types';
import { StudentService, type StudentMeta } from './student.service';
import { CertificationsService, type CertificationsView } from './certifications.service';

/**
 * Everything under /api/student is a signed-in STUDENT reading their OWN record.
 * The guard proves the session and the role; the studentId comes off the token,
 * never the request — the port of `requireStudent()`, which redirected a
 * STUDENT with no studentId rather than trusting one from the URL.
 */
@Controller('student')
@UseGuards(SessionGuard)
@Roles('STUDENT')
export class StudentController {
  constructor(
    private readonly student: StudentService,
    private readonly certifications: CertificationsService,
  ) {}

  private studentId(session: SessionPayload): string {
    if (!session.studentId) throw new BadRequestException('This account has no student record.');
    return session.studentId;
  }

  @Get('meta')
  async meta(@Session() session: SessionPayload): Promise<StudentMeta | { error: string }> {
    if (!session.studentId) return { error: 'This account has no student record.' };
    return this.student.meta(session.studentId);
  }

  @Get('certifications')
  certificationsList(@Session() session: SessionPayload): Promise<CertificationsView> {
    return this.certifications.list(this.studentId(session));
  }
}
