/**
 * The five buckets and the day arithmetic, ported from src/lib/timesheet/rules.ts
 * for the client. Exactly five — the count is the whole reason the sheet gets
 * filled — and the same 30-minute step, 24-hour cap and warn-don't-block rule.
 */

export type DayActivity = 'SLEEPING' | 'LEISURE' | 'LECTURES' | 'COURSEWORK' | 'SKILLING';

export interface DayActivityDef {
  activity: DayActivity;
  label: string;
  hint: string;
}

export const MINUTES_IN_DAY = 1440;
export const STEP_MINUTES = 30;

export const DAY_ACTIVITIES: readonly DayActivityDef[] = [
  { activity: 'SLEEPING', label: 'Sleeping', hint: 'Including naps' },
  { activity: 'LEISURE', label: 'Engaged in leisure', hint: 'Meals, travel, family, phone, rest — everything that is not the four below' },
  { activity: 'LECTURES', label: 'Engaged in lectures', hint: 'Timetabled classes, seminars, guest sessions' },
  { activity: 'COURSEWORK', label: 'Engaged in coursework', hint: 'Assignments, reading, revision — work your course set you' },
  { activity: 'SKILLING', label: 'Engaged in skilling', hint: 'Excel, Power BI, certifications, mock interviews — work you chose' },
] as const;

export type DaySheet = Record<DayActivity, number>;

export function emptySheet(): DaySheet {
  return { SLEEPING: 0, LEISURE: 0, LECTURES: 0, COURSEWORK: 0, SKILLING: 0 };
}

export function sheetTotal(sheet: DaySheet): number {
  return DAY_ACTIVITIES.reduce((sum, def) => sum + (sheet[def.activity] || 0), 0);
}

export function remainingMinutes(sheet: DaySheet): number {
  return MINUTES_IN_DAY - sheetTotal(sheet);
}

/// Snaps to the 30-minute grid rather than adding blindly.
export function stepMinutes(current: number, direction: 1 | -1): number {
  const safe = Number.isFinite(current) ? Math.max(0, Math.round(current)) : 0;
  const next =
    direction === 1
      ? Math.floor(safe / STEP_MINUTES) * STEP_MINUTES + STEP_MINUTES
      : Math.ceil(safe / STEP_MINUTES) * STEP_MINUTES - STEP_MINUTES;
  return Math.min(MINUTES_IN_DAY, Math.max(0, next));
}

export function durationWords(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `${hours}h ${mins}m`;
}

export function remainingLabel(sheet: DaySheet): string {
  const remaining = remainingMinutes(sheet);
  if (remaining === 0) return 'The full 24 hours accounted for';
  if (remaining < 0) return `${durationWords(-remaining)} over 24`;
  return `${durationWords(remaining)} remaining of 24`;
}

/// The step label a bucket shows, e.g. "7h 30m".
export function hm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function todayKey(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

export function shiftKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}-${mm}-${dd}`;
}

export function isOver(sheet: DaySheet): boolean {
  return remainingMinutes(sheet) < 0;
}
