/**
 * The certification pace engine, ported from src/lib/progress.ts.
 *
 * "Overdue" is a pace judgement, not a calendar one: a certification is flagged
 * once actual completion falls below the expected curve for today, so it can
 * read Overdue days before its due date. Pure — same inputs, same status.
 */

import type { CertificationProgress, PaceStatus, ProgressStatus } from '@prisma/client';

export const DEFAULT_PACE_THRESHOLDS = {
  behindDeviationPct: 10,
  atRiskDeviationPct: 25,
} as const;

export type PaceThresholds = typeof DEFAULT_PACE_THRESHOLDS;

const clamp = (value: number): number => Math.max(0, Math.min(100, value));

export function expectedPct(startedAt: Date, dueDate: Date, now = new Date()): number {
  const total = dueDate.getTime() - startedAt.getTime();
  if (total <= 0) return 100;
  const elapsed = now.getTime() - startedAt.getTime();
  return clamp((elapsed / total) * 100);
}

export interface PaceEvaluation {
  actualPct: number;
  expectedPct: number;
  deviationPct: number;
  status: PaceStatus;
}

export function evaluatePace(
  actual: number,
  expected: number,
  thresholds: PaceThresholds = DEFAULT_PACE_THRESHOLDS,
): PaceEvaluation {
  const deviation = actual - expected;
  let status: PaceStatus = 'ON_TRACK';
  if (deviation < -thresholds.atRiskDeviationPct) status = 'AT_RISK';
  else if (deviation < -thresholds.behindDeviationPct) status = 'BEHIND';
  return { actualPct: clamp(actual), expectedPct: clamp(expected), deviationPct: deviation, status };
}

/// The fields certificationStatus reads off a CertificationProgress row plus its
/// certification's dueWeek and requiredHours.
export interface CertForPace {
  progressPct: number;
  dueDate: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  cert: { dueWeek: number };
}

/**
 * Status for one certification row, ported verbatim from certificationStatus().
 * Overdue means the pace fell below the expected curve — not merely that the
 * date passed.
 */
export function certificationStatus(
  cert: CertForPace,
  now = new Date(),
  thresholds: PaceThresholds = DEFAULT_PACE_THRESHOLDS,
): { status: ProgressStatus; pace: PaceEvaluation } {
  const startedAt =
    cert.startedAt ?? new Date(cert.dueDate.getTime() - cert.cert.dueWeek * 7 * 86_400_000);
  const pace = evaluatePace(cert.progressPct, expectedPct(startedAt, cert.dueDate, now), thresholds);

  if (cert.progressPct >= 99.5 || cert.completedAt) return { status: 'COMPLETED', pace };
  if (now > cert.dueDate || pace.status === 'AT_RISK') return { status: 'OVERDUE', pace };
  if (cert.progressPct > 0) return { status: 'IN_PROGRESS', pace };
  return { status: 'NOT_STARTED', pace };
}

// --- labels, ported from reep.ts ------------------------------------------

export const STATUS_LABEL: Record<ProgressStatus, string> = {
  NOT_STARTED: 'Not Started',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  OVERDUE: 'Overdue',
};

export function formatHours(hours: number): string {
  if (!Number.isFinite(hours)) return '0h';
  const whole = Math.floor(hours);
  const mins = Math.round((hours - whole) * 60);
  return mins === 0 ? `${whole}h` : `${whole}h ${mins}m`;
}
