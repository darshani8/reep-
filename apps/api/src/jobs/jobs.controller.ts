import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { Roles, Session, SessionGuard } from '../auth/session.guard';
import type { SessionPayload } from '../auth/session.types';
import { JobsService, type JobsBoardView } from './jobs.service';

/**
 * The student jobs board and its two writes — the port of
 * src/app/student/jobs/page.tsx plus the apply/open server actions. Scoped to
 * the signed-in student's own record; the jobId is validated to exist before
 * any row is written, so a crafted POST cannot invent an application.
 */
@Controller('student/jobs')
@UseGuards(SessionGuard)
@Roles('STUDENT')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  private studentId(session: SessionPayload): string {
    if (!session.studentId) throw new BadRequestException('This account has no student record.');
    return session.studentId;
  }

  @Get()
  board(@Session() session: SessionPayload): Promise<JobsBoardView> {
    return this.jobs.board(this.studentId(session));
  }

  @Post(':id/apply')
  apply(
    @Session() session: SessionPayload,
    @Param('id') id: string,
    @Body() body: { applied?: boolean },
  ): Promise<{ ok: true }> {
    return this.jobs.setApplied(this.studentId(session), id, body.applied === true);
  }

  @Post(':id/open')
  open(@Session() session: SessionPayload, @Param('id') id: string): Promise<{ ok: true }> {
    return this.jobs.recordOpen(this.studentId(session), id);
  }
}
