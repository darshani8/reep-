/**
 * Rule-based alerting for the mentor dashboard.
 *
 * Thresholds are never hard-coded: every rule reads its parameters from
 * AlertRuleConfig rows scoped to a cohort, falling back to the defaults below
 * only when a cohort has not been configured yet.
 *
 * Deliberately *not* here: anything derived from keystrokes, webcam, or browser
 * activity. Every signal is attendance, provider-reported progress, or a mentor
 * observation — see the privacy note in the wireframes.
 */

import type { AlertRuleKey, AlertSeverity, Prisma } from '@prisma/client';

import { prisma } from './db';
import { ALERT_RULE_LABEL, addDays, daysBetween } from './reep';
import {
  attendancePct,
  certificationPace,
  certificationStatus,
  type CertProgressWithCert,
} from './progress';
import { focusQuality, type SessionRow } from './analytics';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export type RuleParams = {
  NO_CHECKIN_N_DAYS: { days: number };
  PACE_BELOW_THRESHOLD: { deviationPct: number };
  ATTENDANCE_BELOW_THRESHOLD: { minAttendancePct: number };
  CERT_OVERDUE: { graceDays: number };
  LOW_FOCUS_QUALITY: { minProgressPerHour: number; minSessions: number };
};

export const DEFAULT_RULE_PARAMS: RuleParams = {
  NO_CHECKIN_N_DAYS: { days: 5 },
  PACE_BELOW_THRESHOLD: { deviationPct: 25 },
  ATTENDANCE_BELOW_THRESHOLD: { minAttendancePct: 75 },
  CERT_OVERDUE: { graceDays: 0 },
  LOW_FOCUS_QUALITY: { minProgressPerHour: 1.0, minSessions: 3 },
};

export const DEFAULT_RULE_SEVERITY: Record<AlertRuleKey, AlertSeverity> = {
  NO_CHECKIN_N_DAYS: 'WARNING',
  PACE_BELOW_THRESHOLD: 'CRITICAL',
  ATTENDANCE_BELOW_THRESHOLD: 'WARNING',
  CERT_OVERDUE: 'WARNING',
  LOW_FOCUS_QUALITY: 'INFO',
};

export const ALL_RULE_KEYS = Object.keys(DEFAULT_RULE_PARAMS) as AlertRuleKey[];

export type ResolvedRule<K extends AlertRuleKey = AlertRuleKey> = {
  ruleKey: K;
  enabled: boolean;
  severity: AlertSeverity;
  params: RuleParams[K];
};

/// Merge cohort config over defaults so a partially-configured cohort still works.
export function resolveRules(
  configs: { ruleKey: AlertRuleKey; enabled: boolean; severity: AlertSeverity; params: unknown }[],
): ResolvedRule[] {
  return ALL_RULE_KEYS.map((ruleKey) => {
    const config = configs.find((c) => c.ruleKey === ruleKey);
    const defaults = DEFAULT_RULE_PARAMS[ruleKey] as Record<string, number>;
    const overrides = (config?.params ?? {}) as Record<string, number>;
    return {
      ruleKey,
      enabled: config?.enabled ?? true,
      severity: config?.severity ?? DEFAULT_RULE_SEVERITY[ruleKey],
      params: { ...defaults, ...overrides },
    } as ResolvedRule;
  });
}

// ---------------------------------------------------------------------------
// Evaluation (pure)
// ---------------------------------------------------------------------------

export type StudentSignals = {
  studentId: string;
  studentName: string;
  sessions: SessionRow[];
  certs: CertProgressWithCert[];
  attendance: { present: boolean }[];
};

export type TriggeredAlert = {
  studentId: string;
  ruleTriggered: AlertRuleKey;
  severity: AlertSeverity;
  message: string;
  context: Prisma.InputJsonValue;
};

export function evaluateStudent(
  signals: StudentSignals,
  rules: ResolvedRule[],
  now = new Date(),
): TriggeredAlert[] {
  const triggered: TriggeredAlert[] = [];
  const enabled = new Map(rules.filter((r) => r.enabled).map((r) => [r.ruleKey, r]));
  const first = signals.studentName.split(' ')[0] ?? signals.studentName;

  // --- no check-in in N days ---
  const noCheckIn = enabled.get('NO_CHECKIN_N_DAYS');
  if (noCheckIn) {
    const { days } = noCheckIn.params as RuleParams['NO_CHECKIN_N_DAYS'];
    const last = signals.sessions.reduce<Date | null>(
      (latest, s) => (!latest || s.checkInAt > latest ? s.checkInAt : latest),
      null,
    );
    const idleDays = last ? daysBetween(now, last) : Number.POSITIVE_INFINITY;
    if (idleDays >= days) {
      triggered.push({
        studentId: signals.studentId,
        ruleTriggered: 'NO_CHECKIN_N_DAYS',
        severity: noCheckIn.severity,
        message: last
          ? `${first} — no lab check-in in ${idleDays} days`
          : `${first} — has never checked in to a lab session`,
        context: { idleDays: Number.isFinite(idleDays) ? idleDays : null, threshold: days },
      });
    }
  }

  // --- certification pace below the expected curve ---
  const paceRule = enabled.get('PACE_BELOW_THRESHOLD');
  if (paceRule && signals.certs.length > 0) {
    const { deviationPct } = paceRule.params as RuleParams['PACE_BELOW_THRESHOLD'];
    const pace = certificationPace(signals.certs, now);
    if (pace.deviationPct < -deviationPct) {
      triggered.push({
        studentId: signals.studentId,
        ruleTriggered: 'PACE_BELOW_THRESHOLD',
        severity: paceRule.severity,
        message: `${first} — certification pace ${Math.abs(pace.deviationPct).toFixed(0)}% below target`,
        context: {
          actualPct: pace.actualPct,
          expectedPct: pace.expectedPct,
          deviationPct: pace.deviationPct,
          threshold: deviationPct,
        },
      });
    }
  }

  // --- attendance below threshold ---
  const attendanceRule = enabled.get('ATTENDANCE_BELOW_THRESHOLD');
  if (attendanceRule && signals.attendance.length > 0) {
    const { minAttendancePct } = attendanceRule.params as RuleParams['ATTENDANCE_BELOW_THRESHOLD'];
    const pct = attendancePct(signals.attendance);
    if (pct < minAttendancePct) {
      triggered.push({
        studentId: signals.studentId,
        ruleTriggered: 'ATTENDANCE_BELOW_THRESHOLD',
        severity: attendanceRule.severity,
        message: `${first} — attendance ${pct.toFixed(0)}%`,
        context: { attendancePct: pct, threshold: minAttendancePct },
      });
    }
  }

  // --- required certification past due ---
  const overdueRule = enabled.get('CERT_OVERDUE');
  if (overdueRule) {
    const { graceDays } = overdueRule.params as RuleParams['CERT_OVERDUE'];
    const overdue = signals.certs.filter((c) => {
      if (c.cert.isOptional) return false;
      const { status } = certificationStatus(c, now);
      return status === 'OVERDUE' && now > addDays(c.dueDate, graceDays);
    });
    if (overdue.length > 0) {
      triggered.push({
        studentId: signals.studentId,
        ruleTriggered: 'CERT_OVERDUE',
        severity: overdueRule.severity,
        message: `${first} — ${overdue.length} required certification${overdue.length > 1 ? 's' : ''} overdue (${overdue
          .slice(0, 2)
          .map((c) => c.cert.name)
          .join(', ')}${overdue.length > 2 ? '…' : ''})`,
        context: { count: overdue.length, certs: overdue.map((c) => c.cert.name) },
      });
    }
  }

  // --- lab hours not converting into progress ---
  const focusRule = enabled.get('LOW_FOCUS_QUALITY');
  if (focusRule) {
    const { minProgressPerHour, minSessions } =
      focusRule.params as RuleParams['LOW_FOCUS_QUALITY'];
    const labSessions = signals.sessions.filter((s) => s.mode === 'SUPERVISED_LAB');
    const quality = focusQuality(labSessions);
    if (
      quality.totalSessions >= minSessions &&
      quality.totalHours >= 2 &&
      quality.progressPerHour < minProgressPerHour
    ) {
      triggered.push({
        studentId: signals.studentId,
        ruleTriggered: 'LOW_FOCUS_QUALITY',
        severity: focusRule.severity,
        message: `${first} — ${quality.totalHours}h logged but only ${quality.progressGainedPct}% platform progress gained`,
        context: {
          progressPerHour: quality.progressPerHour,
          threshold: minProgressPerHour,
          totalHours: quality.totalHours,
          abandonedRatePct: quality.abandonedRatePct,
        },
      });
    }
  }

  return triggered;
}

// ---------------------------------------------------------------------------
// Scan + persist
// ---------------------------------------------------------------------------

export type ScanResult = {
  scanned: number;
  opened: number;
  reopened: number;
  autoResolved: number;
  alerts: TriggeredAlert[];
};

/**
 * Re-evaluates every student in a cohort (or the whole programme when
 * `cohortId` is omitted) and reconciles the Alert table:
 *   - a newly-firing rule opens an alert
 *   - a rule that no longer fires auto-resolves its open alert
 *   - a rule that keeps firing is left alone, so `triggeredAt` stays honest
 */
export async function runAlertScan(cohortId?: string): Promise<ScanResult> {
  const students = await prisma.student.findMany({
    where: cohortId ? { cohortId } : undefined,
    include: {
      user: { select: { name: true } },
      labSessions: true,
      attendance: { select: { present: true } },
      certProgress: { include: { cert: { include: { course: true } } } },
      alerts: { where: { resolvedAt: null } },
    },
  });

  const cohortIds = [...new Set(students.map((s) => s.cohortId))];
  const configs = await prisma.alertRuleConfig.findMany({
    where: { cohortId: { in: cohortIds } },
  });

  const now = new Date();
  let opened = 0;
  let reopened = 0;
  let autoResolved = 0;
  const all: TriggeredAlert[] = [];

  for (const student of students) {
    const rules = resolveRules(configs.filter((c) => c.cohortId === student.cohortId));

    const triggered = evaluateStudent(
      {
        studentId: student.id,
        studentName: student.user.name,
        sessions: student.labSessions,
        certs: student.certProgress,
        attendance: student.attendance,
      },
      rules,
      now,
    );
    all.push(...triggered);

    const firingKeys = new Set(triggered.map((t) => t.ruleTriggered));
    const openKeys = new Set(student.alerts.map((a) => a.ruleTriggered));

    for (const alert of triggered) {
      if (openKeys.has(alert.ruleTriggered)) {
        // Keep the original triggeredAt, but refresh the message/context so the
        // mentor sees current numbers.
        await prisma.alert.updateMany({
          where: {
            studentId: student.id,
            ruleTriggered: alert.ruleTriggered,
            resolvedAt: null,
          },
          data: { message: alert.message, context: alert.context, severity: alert.severity },
        });
        reopened += 1;
      } else {
        await prisma.alert.create({ data: { ...alert, triggeredAt: now } });
        opened += 1;
      }
    }

    const stale = student.alerts.filter((a) => !firingKeys.has(a.ruleTriggered));
    if (stale.length > 0) {
      await prisma.alert.updateMany({
        where: { id: { in: stale.map((a) => a.id) } },
        data: { resolvedAt: now, resolvedBy: 'auto' },
      });
      autoResolved += stale.length;
    }
  }

  return { scanned: students.length, opened, reopened, autoResolved, alerts: all };
}

/// Short strip copy for the mentor overview, e.g. "3 alerts: Aditi K. — …".
export function alertStripSummary(
  alerts: { message: string }[],
  limit = 3,
): { count: number; text: string } {
  const shown = alerts.slice(0, limit).map((a) => a.message);
  return {
    count: alerts.length,
    text: shown.join('  |  '),
  };
}

export function ruleLabel(key: AlertRuleKey): string {
  return ALERT_RULE_LABEL[key];
}
