import { BadRequestException, Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';

import { Roles, Session, SessionGuard } from '../auth/session.guard';
import type { SessionPayload } from '../auth/session.types';
import { TimesheetService, type DaySheetView } from './timesheet.service';

@Controller('student/timesheet')
@UseGuards(SessionGuard)
@Roles('STUDENT')
export class TimesheetController {
  constructor(private readonly timesheet: TimesheetService) {}

  private studentId(session: SessionPayload): string {
    if (!session.studentId) throw new BadRequestException('This account has no student record.');
    return session.studentId;
  }

  @Get()
  getDay(@Session() session: SessionPayload, @Query('day') day?: string): Promise<DaySheetView> {
    return this.timesheet.getDay(this.studentId(session), day);
  }

  @Put()
  saveDay(@Session() session: SessionPayload, @Body() body: unknown): Promise<{ ok: true; day: string }> {
    return this.timesheet.saveDay(this.studentId(session), body);
  }
}
