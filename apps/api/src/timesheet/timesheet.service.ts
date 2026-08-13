/**
 * The five-bucket day sheet, server-side. Ports the read and the write from
 * src/lib/timesheet (queries.ts + save.ts).
 *
 * Re-saving a day replaces that day's five rows atomically — the sheet is the
 * source of truth for the day, and a partial write would leave a bucket from a
 * previous save behind. TimeSheetEntry is a separate table from the 15-value
 * ActivityType log; nothing here touches pace or focus quality.
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import type { DayActivity } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { dayFromKey, dayKey, emptySheet, parseSubmission, sheetFromEntries, validateSheet, type DaySheet } from './rules';

export interface DaySheetView {
  day: string;
  minutes: DaySheet;
}

@Injectable()
export class TimesheetService {
  constructor(private readonly prisma: PrismaService) {}

  /// The saved sheet for a day, or an empty one. Defaults to today.
  async getDay(studentId: string, key?: string): Promise<DaySheetView> {
    const day = key ? dayFromKey(key) : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    if (!day) throw new BadRequestException('Expected a day as YYYY-MM-DD.');

    const entries = await this.prisma.timeSheetEntry.findMany({
      where: { studentId, day },
      select: { activity: true, minutes: true },
    });

    return { day: dayKey(day), minutes: entries.length ? sheetFromEntries(entries) : emptySheet() };
  }

  /// Replace a day's five rows atomically. Blocks only a day that does not fit
  /// in a day (>24h); an under-filled day saves with a warning shown client-side.
  async saveDay(studentId: string, body: unknown): Promise<{ ok: true; day: string }> {
    const parsed = parseSubmission(body);
    if (!parsed.ok) throw new BadRequestException(parsed.error);

    const verdict = validateSheet(parsed.sheet);
    if (!verdict.ok) throw new BadRequestException(verdict.error ?? 'That sheet cannot be saved.');

    const day = dayFromKey(parsed.dayKey);
    if (!day) throw new BadRequestException('Expected a day as YYYY-MM-DD.');

    const rows = (Object.entries(parsed.sheet) as [DayActivity, number][])
      .filter(([, minutes]) => minutes > 0)
      .map(([activity, minutes]) => ({ studentId, day, activity, minutes }));

    await this.prisma.$transaction([
      this.prisma.timeSheetEntry.deleteMany({ where: { studentId, day } }),
      ...(rows.length ? [this.prisma.timeSheetEntry.createMany({ data: rows })] : []),
    ]);

    return { ok: true, day: parsed.dayKey };
  }
}
