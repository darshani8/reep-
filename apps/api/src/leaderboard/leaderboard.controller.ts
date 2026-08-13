import { Controller, Get, UseGuards } from '@nestjs/common';

import { Roles, Session, SessionGuard } from '../auth/session.guard';
import type { SessionPayload } from '../auth/session.types';
import { LeaderboardService, type LeaderboardsResponse } from './leaderboard.service';

/**
 * The five student leaderboards. STUDENT-only, and the service caps every read
 * to the viewer's own cohort and projects peer rows to a name/rank/band — the
 * one screen where a student reads anything about another, fenced in scope.ts.
 */
@Controller('student/leaderboards')
@UseGuards(SessionGuard)
@Roles('STUDENT')
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Get()
  view(@Session() session: SessionPayload): Promise<LeaderboardsResponse> {
    return this.leaderboard.view(session);
  }
}
