import { Controller, Get, UseGuards } from '@nestjs/common';

import { BadRequestException, Body, Put } from '@nestjs/common';

import { Roles, Session, SessionGuard } from '../auth/session.guard';
import type { SessionPayload } from '../auth/session.types';
import { StudentService, type StudentMeta } from './student.service';
import { CertificationsService, type CertificationsView } from './certifications.service';
import { ProfileService, type ProfileView } from './profile.service';
import { AcademicsService, type AcademicsView, type QualificationInput } from './academics.service';

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
    private readonly profile: ProfileService,
    private readonly academics: AcademicsService,
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

  @Get('profile')
  getProfile(@Session() session: SessionPayload): Promise<ProfileView> {
    return this.profile.get(this.studentId(session));
  }

  @Put('profile/contact')
  saveContact(
    @Session() session: SessionPayload,
    @Body() body: Record<string, string>,
  ): Promise<{ ok: true }> {
    return this.profile.saveContact(this.studentId(session), body);
  }

  @Put('profile/leaderboard')
  setOptOut(
    @Session() session: SessionPayload,
    @Body() body: { optOut?: boolean },
  ): Promise<{ ok: true }> {
    return this.profile.setOptOut(this.studentId(session), body.optOut === true);
  }

  @Put('profile/target')
  setTarget(
    @Session() session: SessionPayload,
    @Body() body: { weeklyHourTarget?: number },
  ): Promise<{ ok: true }> {
    return this.profile.setTarget(this.studentId(session), Number(body.weeklyHourTarget));
  }

  @Get('academics')
  getAcademics(@Session() session: SessionPayload): Promise<AcademicsView> {
    return this.academics.get(this.studentId(session));
  }

  @Put('academics')
  saveAcademics(
    @Session() session: SessionPayload,
    @Body() body: { qualifications: QualificationInput[]; gap: AcademicsView['gap'] },
  ): Promise<AcademicsView> {
    return this.academics.save(this.studentId(session), body);
  }
}
