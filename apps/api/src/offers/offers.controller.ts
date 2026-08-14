import { BadRequestException, Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';

import { Roles, Session, SessionGuard } from '../auth/session.guard';
import type { SessionPayload } from '../auth/session.types';
import { OffersService, type OfferInput } from './offers.service';

/**
 * A student's own placement offers. STUDENT-only, scoped to their studentId off
 * the token — never a client-supplied id. Submitting locks the record; the
 * director-side approval endpoint lives with the director surface when it lands.
 */
@Controller('student/offers')
@UseGuards(SessionGuard)
@Roles('STUDENT')
export class OffersController {
  constructor(private readonly offers: OffersService) {}

  private studentId(session: SessionPayload): string {
    if (!session.studentId) throw new BadRequestException('This account has no student record.');
    return session.studentId;
  }

  @Get()
  list(@Session() session: SessionPayload) {
    return this.offers.listMine(this.studentId(session));
  }

  @Post()
  create(@Session() session: SessionPayload, @Body() body: OfferInput) {
    return this.offers.create(this.studentId(session), body);
  }

  @Put(':id')
  update(@Session() session: SessionPayload, @Param('id') id: string, @Body() body: OfferInput) {
    return this.offers.update(this.studentId(session), id, body);
  }

  @Post(':id/submit')
  submit(@Session() session: SessionPayload, @Param('id') id: string) {
    return this.offers.submit(this.studentId(session), id);
  }
}
