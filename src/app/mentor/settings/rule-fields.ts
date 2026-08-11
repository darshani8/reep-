import type { AlertRuleKey, AlertSeverity } from '@prisma/client';

/**
 * Field descriptors for the threshold editor.
 *
 * The form and the server action both read this map, so a rule can never render
 * an input the action does not know how to read back — and the min/max here is
 * the same clamp applied on the server.
 */

export type RuleField = {
  name: string;
  label: string;
  suffix: string;
  min: number;
  max: number;
  step: number;
};

export const RULE_FIELDS: Record<AlertRuleKey, RuleField[]> = {
  NO_CHECKIN_N_DAYS: [
    { name: 'days', label: 'Consecutive idle days', suffix: 'days', min: 1, max: 60, step: 1 },
  ],
  PACE_BELOW_THRESHOLD: [
    {
      name: 'deviationPct',
      label: 'Shortfall against the expected curve',
      suffix: '%',
      min: 1,
      max: 90,
      step: 1,
    },
  ],
  ATTENDANCE_BELOW_THRESHOLD: [
    { name: 'minAttendancePct', label: 'Minimum attendance', suffix: '%', min: 0, max: 100, step: 1 },
  ],
  CERT_OVERDUE: [
    {
      name: 'graceDays',
      label: 'Grace period after the due date',
      suffix: 'days',
      min: 0,
      max: 60,
      step: 1,
    },
  ],
  LOW_FOCUS_QUALITY: [
    {
      name: 'minProgressPerHour',
      label: 'Minimum progress gained per lab hour',
      suffix: '% / h',
      min: 0,
      max: 20,
      step: 0.1,
    },
    {
      name: 'minSessions',
      label: 'Lab sessions before the rule judges',
      suffix: 'sessions',
      min: 1,
      max: 50,
      step: 1,
    },
  ],
};

export const SEVERITY_OPTIONS: AlertSeverity[] = ['INFO', 'WARNING', 'CRITICAL'];

// Field names are namespaced by rule so one flat FormData carries all five rules.
export const enabledName = (ruleKey: AlertRuleKey) => `${ruleKey}__enabled`;
export const severityName = (ruleKey: AlertRuleKey) => `${ruleKey}__severity`;
export const fieldName = (ruleKey: AlertRuleKey, param: string) => `${ruleKey}__${param}`;
