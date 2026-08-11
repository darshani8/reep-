/**
 * `rules.ts` is the one module in this suite that is not import-free: it has a
 * value import of `./db`, so loading it constructs a `PrismaClient`. That is
 * harmless — Prisma connects lazily, so nothing here touches a database — but
 * the constructor still wants a URL, and a developer without a `.env` should not
 * see this file fail for a reason that has nothing to do with the rules.
 *
 * Hence the dummy URL and the dynamic import: the environment is set before the
 * module graph is pulled in. `runAlertScan` is the only export that would
 * actually issue a query, and nothing here calls it.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { makeCertProgress, makeSession } from '../../test/fixtures';
import type { AlertRuleKey, AlertSeverity } from '@prisma/client';
import type { StudentSignals, TriggeredAlert } from './rules';

process.env.DATABASE_URL ??= 'postgresql://unit:test@127.0.0.1:5432/unit_test';

type RulesModule = typeof import('./rules');
let rules: RulesModule;

beforeAll(async () => {
  rules = await import('./rules');
});

/// Every rule on, at its default parameters — the shape `resolveRules` produces
/// for a cohort nobody has configured.
function allRules(overrides: Partial<Record<AlertRuleKey, unknown>> = {}) {
  return rules.resolveRules(
    rules.ALL_RULE_KEYS.map((ruleKey) => ({
      ruleKey,
      enabled: true,
      severity: rules.DEFAULT_RULE_SEVERITY[ruleKey],
      params: overrides[ruleKey] ?? {},
    })),
  );
}

function signals(overrides: Partial<StudentSignals> = {}): StudentSignals {
  return {
    studentId: 'stu_1',
    studentName: 'Asha Nair',
    sessions: [],
    certs: [],
    attendance: [],
    ...overrides,
  };
}

const keys = (alerts: TriggeredAlert[]) => alerts.map((a) => a.ruleTriggered);

describe('resolveRules', () => {
  it('returns every rule even for a cohort with no configuration at all', () => {
    const resolved = rules.resolveRules([]);

    expect(resolved.map((r) => r.ruleKey).sort()).toEqual([...rules.ALL_RULE_KEYS].sort());
  });

  it('enables a rule by default when the cohort has not said otherwise', () => {
    expect(rules.resolveRules([]).every((r) => r.enabled)).toBe(true);
  });

  it('falls back to the default severity and parameters', () => {
    const noCheckIn = rules.resolveRules([]).find((r) => r.ruleKey === 'NO_CHECKIN_N_DAYS')!;

    expect(noCheckIn.severity).toBe(rules.DEFAULT_RULE_SEVERITY.NO_CHECKIN_N_DAYS);
    expect(noCheckIn.params).toEqual(rules.DEFAULT_RULE_PARAMS.NO_CHECKIN_N_DAYS);
  });

  it('merges a partial override over the defaults rather than replacing them', () => {
    const resolved = rules.resolveRules([
      {
        ruleKey: 'LOW_FOCUS_QUALITY',
        enabled: true,
        severity: 'CRITICAL' as AlertSeverity,
        params: { minSessions: 10 },
      },
    ]);
    const focus = resolved.find((r) => r.ruleKey === 'LOW_FOCUS_QUALITY')!;

    expect(focus.params).toEqual({
      minProgressPerHour: rules.DEFAULT_RULE_PARAMS.LOW_FOCUS_QUALITY.minProgressPerHour,
      minSessions: 10,
    });
    expect(focus.severity).toBe('CRITICAL');
  });

  it('honours a rule the cohort has switched off', () => {
    const resolved = rules.resolveRules([
      { ruleKey: 'CERT_OVERDUE', enabled: false, severity: 'INFO', params: {} },
    ]);

    expect(resolved.find((r) => r.ruleKey === 'CERT_OVERDUE')!.enabled).toBe(false);
  });

  it('ignores a stored params value that is not an object', () => {
    const resolved = rules.resolveRules([
      { ruleKey: 'NO_CHECKIN_N_DAYS', enabled: true, severity: 'WARNING', params: null },
    ]);

    expect(resolved.find((r) => r.ruleKey === 'NO_CHECKIN_N_DAYS')!.params).toEqual(
      rules.DEFAULT_RULE_PARAMS.NO_CHECKIN_N_DAYS,
    );
  });

  it('ignores configuration for a rule key that is no longer known', () => {
    const resolved = rules.resolveRules([
      {
        ruleKey: 'RETIRED_RULE' as AlertRuleKey,
        enabled: true,
        severity: 'INFO',
        params: { days: 1 },
      },
    ]);

    expect(resolved).toHaveLength(rules.ALL_RULE_KEYS.length);
    expect(resolved.map((r) => r.ruleKey)).not.toContain('RETIRED_RULE');
  });
});

describe('evaluateStudent — no check-in', () => {
  const now = new Date(2026, 7, 9, 12, 0);

  it('says nothing about a student who checked in today', () => {
    const alerts = rules.evaluateStudent(
      signals({ sessions: [makeSession({ checkInAt: new Date(2026, 7, 9, 9, 0) })] }),
      allRules(),
      now,
    );

    expect(keys(alerts)).not.toContain('NO_CHECKIN_N_DAYS');
  });

  it('fires once the idle days reach the threshold', () => {
    const alerts = rules.evaluateStudent(
      signals({ sessions: [makeSession({ checkInAt: new Date(2026, 7, 4, 12, 0) })] }),
      allRules({ NO_CHECKIN_N_DAYS: { days: 5 } }),
      now,
    );

    expect(keys(alerts)).toContain('NO_CHECKIN_N_DAYS');
  });

  it('does not fire one day short of the threshold', () => {
    const alerts = rules.evaluateStudent(
      signals({ sessions: [makeSession({ checkInAt: new Date(2026, 7, 5, 12, 0) })] }),
      allRules({ NO_CHECKIN_N_DAYS: { days: 5 } }),
      now,
    );

    expect(keys(alerts)).not.toContain('NO_CHECKIN_N_DAYS');
  });

  it('uses the most recent session, not the first one in the list', () => {
    const alerts = rules.evaluateStudent(
      signals({
        sessions: [
          makeSession({ checkInAt: new Date(2026, 6, 1) }),
          makeSession({ checkInAt: new Date(2026, 7, 9, 9, 0) }),
        ],
      }),
      allRules(),
      now,
    );

    expect(keys(alerts)).not.toContain('NO_CHECKIN_N_DAYS');
  });

  it('words the alert differently for a student who has never checked in', () => {
    const alerts = rules.evaluateStudent(signals(), allRules(), now);
    const alert = alerts.find((a) => a.ruleTriggered === 'NO_CHECKIN_N_DAYS')!;

    expect(alert.message).toContain('never checked in');
    expect(alert.context).toMatchObject({ idleDays: null });
  });

  it('says nothing at all when the rule is switched off', () => {
    const off = rules.resolveRules([
      { ruleKey: 'NO_CHECKIN_N_DAYS', enabled: false, severity: 'WARNING', params: {} },
    ]);

    expect(keys(rules.evaluateStudent(signals(), off, now))).not.toContain('NO_CHECKIN_N_DAYS');
  });

  it('addresses the student by first name', () => {
    const alerts = rules.evaluateStudent(
      signals({ studentName: 'Asha Nair' }),
      allRules(),
      now,
    );

    expect(alerts[0].message.startsWith('Asha —')).toBe(true);
  });

  it('copes with a single-word name', () => {
    const alerts = rules.evaluateStudent(signals({ studentName: 'Asha' }), allRules(), now);

    expect(alerts[0].message.startsWith('Asha —')).toBe(true);
  });
});

describe('evaluateStudent — attendance', () => {
  const now = new Date(2026, 7, 9);

  it('stays silent for a student with no attendance register', () => {
    // The rule is skipped entirely rather than reading the vacuous 100%.
    const alerts = rules.evaluateStudent(signals({ attendance: [] }), allRules(), now);

    expect(keys(alerts)).not.toContain('ATTENDANCE_BELOW_THRESHOLD');
  });

  it('fires below the threshold', () => {
    const attendance = [
      ...Array.from({ length: 7 }, () => ({ present: true })),
      ...Array.from({ length: 3 }, () => ({ present: false })),
    ];
    const alerts = rules.evaluateStudent(
      signals({ attendance }),
      allRules({ ATTENDANCE_BELOW_THRESHOLD: { minAttendancePct: 75 } }),
      now,
    );

    expect(keys(alerts)).toContain('ATTENDANCE_BELOW_THRESHOLD');
  });

  it('does not fire exactly at the threshold', () => {
    const attendance = [
      ...Array.from({ length: 3 }, () => ({ present: true })),
      { present: false },
    ];
    const alerts = rules.evaluateStudent(
      signals({ attendance }),
      allRules({ ATTENDANCE_BELOW_THRESHOLD: { minAttendancePct: 75 } }),
      now,
    );

    expect(keys(alerts)).not.toContain('ATTENDANCE_BELOW_THRESHOLD');
  });
});

describe('evaluateStudent — certification pace and overdue', () => {
  const now = new Date(2026, 7, 9);

  it('stays silent for a student with no certifications at all', () => {
    const alerts = rules.evaluateStudent(signals({ certs: [] }), allRules(), now);

    expect(keys(alerts)).not.toContain('PACE_BELOW_THRESHOLD');
    expect(keys(alerts)).not.toContain('CERT_OVERDUE');
  });

  it('fires the pace rule for a student far below the curve', () => {
    const certs = [
      makeCertProgress({
        progressPct: 0,
        startedAt: new Date(2026, 0, 1),
        dueDate: new Date(2026, 8, 1),
      }),
    ];
    const alerts = rules.evaluateStudent(signals({ certs }), allRules(), now);

    expect(keys(alerts)).toContain('PACE_BELOW_THRESHOLD');
  });

  it('does not fire the pace rule for a student who is ahead', () => {
    const certs = [
      makeCertProgress({
        progressPct: 100,
        startedAt: new Date(2026, 0, 1),
        dueDate: new Date(2026, 8, 1),
      }),
    ];
    const alerts = rules.evaluateStudent(signals({ certs }), allRules(), now);

    expect(keys(alerts)).not.toContain('PACE_BELOW_THRESHOLD');
  });

  it('never raises an overdue alert for an optional certification', () => {
    const certs = [
      makeCertProgress({
        progressPct: 0,
        dueDate: new Date(2026, 6, 1),
        cert: { isOptional: true },
      }),
    ];
    const alerts = rules.evaluateStudent(signals({ certs }), allRules(), now);

    expect(keys(alerts)).not.toContain('CERT_OVERDUE');
  });

  it('raises one overdue alert naming several certifications rather than one each', () => {
    const certs = ['C1', 'C2', 'C3'].map((code) =>
      makeCertProgress({
        id: code,
        certCode: code,
        progressPct: 0,
        dueDate: new Date(2026, 6, 1),
        cert: { code, name: `Cert ${code}` },
      }),
    );
    const alerts = rules.evaluateStudent(signals({ certs }), allRules(), now);
    const overdue = alerts.filter((a) => a.ruleTriggered === 'CERT_OVERDUE');

    expect(overdue).toHaveLength(1);
    expect(overdue[0].message).toContain('3 required certifications overdue');
    expect(overdue[0].context).toMatchObject({ count: 3 });
  });

  it('respects a grace period on the due date', () => {
    const certs = [
      makeCertProgress({
        progressPct: 0,
        startedAt: new Date(2026, 7, 1),
        dueDate: new Date(2026, 7, 8),
      }),
    ];
    const withGrace = rules.evaluateStudent(
      signals({ certs }),
      allRules({ CERT_OVERDUE: { graceDays: 30 } }),
      now,
    );

    expect(keys(withGrace)).not.toContain('CERT_OVERDUE');
  });
});

describe('evaluateStudent — low focus quality', () => {
  const now = new Date(2026, 7, 9);

  const labSession = (progressDeltaPct: number | null) =>
    makeSession({
      mode: 'SUPERVISED_LAB',
      durationMin: 120,
      checkInAt: new Date(2026, 7, 5, 10, 0),
      progressDeltaPct,
    });

  it('stays silent below the minimum session count', () => {
    const alerts = rules.evaluateStudent(
      signals({ sessions: [labSession(0), labSession(0)] }),
      allRules({ LOW_FOCUS_QUALITY: { minProgressPerHour: 1, minSessions: 3 } }),
      now,
    );

    expect(keys(alerts)).not.toContain('LOW_FOCUS_QUALITY');
  });

  it('fires for enough lab sessions producing little progress', () => {
    const alerts = rules.evaluateStudent(
      signals({ sessions: [labSession(0.1), labSession(0.1), labSession(0.1)] }),
      allRules({ LOW_FOCUS_QUALITY: { minProgressPerHour: 1, minSessions: 3 } }),
      now,
    );

    expect(keys(alerts)).toContain('LOW_FOCUS_QUALITY');
  });

  it('does not fire for a student whose lab hours are converting', () => {
    const alerts = rules.evaluateStudent(
      signals({ sessions: [labSession(10), labSession(10), labSession(10)] }),
      allRules({ LOW_FOCUS_QUALITY: { minProgressPerHour: 1, minSessions: 3 } }),
      now,
    );

    expect(keys(alerts)).not.toContain('LOW_FOCUS_QUALITY');
  });

  it('looks only at supervised lab sessions, ignoring lectures and independent study', () => {
    const nonLab = [
      makeSession({ mode: 'INSTRUCTOR_LED', durationMin: 120, progressDeltaPct: 0 }),
      makeSession({ mode: 'INDEPENDENT', durationMin: 120, progressDeltaPct: 0 }),
      makeSession({ mode: 'INDEPENDENT', durationMin: 120, progressDeltaPct: 0 }),
    ];
    const alerts = rules.evaluateStudent(
      signals({ sessions: nonLab }),
      allRules({ LOW_FOCUS_QUALITY: { minProgressPerHour: 1, minSessions: 3 } }),
      now,
    );

    expect(keys(alerts)).not.toContain('LOW_FOCUS_QUALITY');
  });
});

describe('evaluateStudent — overall behaviour', () => {
  const now = new Date(2026, 7, 9);

  it('returns nothing when every rule is disabled, however bad the signals', () => {
    const off = rules.resolveRules(
      rules.ALL_RULE_KEYS.map((ruleKey) => ({
        ruleKey,
        enabled: false,
        severity: 'INFO' as AlertSeverity,
        params: {},
      })),
    );
    const bad = signals({
      certs: [makeCertProgress({ progressPct: 0, dueDate: new Date(2026, 0, 1) })],
      attendance: [{ present: false }],
    });

    expect(rules.evaluateStudent(bad, off, now)).toEqual([]);
  });

  it('carries the configured severity onto the alert it raises', () => {
    const custom = rules.resolveRules([
      { ruleKey: 'NO_CHECKIN_N_DAYS', enabled: true, severity: 'CRITICAL', params: {} },
    ]);
    const alert = rules
      .evaluateStudent(signals(), custom, now)
      .find((a) => a.ruleTriggered === 'NO_CHECKIN_N_DAYS')!;

    expect(alert.severity).toBe('CRITICAL');
  });

  it('stamps every alert with the student it belongs to', () => {
    const alerts = rules.evaluateStudent(signals({ studentId: 'stu_42' }), allRules(), now);

    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.every((a) => a.studentId === 'stu_42')).toBe(true);
  });

  it('raises at most one alert per rule', () => {
    const bad = signals({
      certs: [
        makeCertProgress({ id: 'a', certCode: 'A', progressPct: 0, dueDate: new Date(2026, 0, 1), cert: { code: 'A' } }),
        makeCertProgress({ id: 'b', certCode: 'B', progressPct: 0, dueDate: new Date(2026, 0, 1), cert: { code: 'B' } }),
      ],
      attendance: [{ present: false }, { present: false }],
    });
    const fired = keys(rules.evaluateStudent(bad, allRules(), now));

    expect(new Set(fired).size).toBe(fired.length);
  });
});

describe('alertStripSummary', () => {
  it('is an empty strip for a cohort with no open alerts', () => {
    expect(rules.alertStripSummary([])).toEqual({ count: 0, text: '' });
  });

  it('counts every alert but shows only the first few', () => {
    const alerts = Array.from({ length: 5 }, (_, i) => ({ message: `Alert ${i}` }));
    const summary = rules.alertStripSummary(alerts, 3);

    expect(summary.count).toBe(5);
    expect(summary.text.split('  |  ')).toHaveLength(3);
    expect(summary.text).toContain('Alert 0');
    expect(summary.text).not.toContain('Alert 3');
  });

  it('does not pad the separator when there is a single alert', () => {
    expect(rules.alertStripSummary([{ message: 'Only one' }])).toEqual({
      count: 1,
      text: 'Only one',
    });
  });
});

describe('ruleLabel', () => {
  it('gives every known rule key a human label', () => {
    for (const key of rules.ALL_RULE_KEYS) {
      expect(rules.ruleLabel(key)).toBeTruthy();
      expect(rules.ruleLabel(key)).not.toBe(key);
    }
  });
});
