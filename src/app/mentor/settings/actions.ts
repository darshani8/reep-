'use server';

import { revalidatePath } from 'next/cache';

import { requireMentor, type SessionPayload } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { mentorScope } from '@/lib/mentor-scope';
import { ALL_RULE_KEYS, DEFAULT_RULE_PARAMS, DEFAULT_RULE_SEVERITY, runAlertScan } from '@/lib/rules';
import type { AlertSeverity, Prisma } from '@prisma/client';

import { RULE_FIELDS, SEVERITY_OPTIONS, enabledName, fieldName, severityName } from './rule-fields';

export type ThresholdState = { ok: boolean; message: string } | null;

/**
 * Persist the cohort's thresholds, then immediately re-scan it.
 *
 * The re-scan is the point of the screen: a coordinator who loosens the
 * attendance floor should see the alert count move on the next paint, not
 * discover the effect the following morning.
 */
export async function saveThresholdsAction(
  _prev: ThresholdState,
  formData: FormData,
): Promise<ThresholdState> {
  const session = await requireMentor();
  const cohortId = String(formData.get('cohortId') ?? '');
  if (!cohortId) return { ok: false, message: 'No cohort selected.' };

  if (!(await canEditCohort(cohortId, session))) {
    return { ok: false, message: 'You do not mentor anyone in that cohort.' };
  }

  for (const ruleKey of ALL_RULE_KEYS) {
    // An unchecked checkbox is simply absent from FormData.
    const enabled = formData.get(enabledName(ruleKey)) != null;

    const severityRaw = String(formData.get(severityName(ruleKey)) ?? '');
    const severity = (SEVERITY_OPTIONS as string[]).includes(severityRaw)
      ? (severityRaw as AlertSeverity)
      : DEFAULT_RULE_SEVERITY[ruleKey];

    // Start from the defaults so a row is always complete, then clamp each
    // submitted value into the range the input advertised.
    const params: Record<string, number> = {
      ...(DEFAULT_RULE_PARAMS[ruleKey] as unknown as Record<string, number>),
    };
    for (const field of RULE_FIELDS[ruleKey]) {
      const raw = Number(formData.get(fieldName(ruleKey, field.name)));
      if (Number.isFinite(raw)) {
        params[field.name] = Math.min(field.max, Math.max(field.min, raw));
      }
    }

    await prisma.alertRuleConfig.upsert({
      where: { cohortId_ruleKey: { cohortId, ruleKey } },
      create: { cohortId, ruleKey, enabled, severity, params: params as Prisma.InputJsonValue },
      update: { enabled, severity, params: params as Prisma.InputJsonValue },
    });
  }

  const result = await runAlertScan(cohortId);

  revalidatePath('/mentor/settings');
  revalidatePath('/mentor/alerts');
  revalidatePath('/mentor');

  return {
    ok: true,
    message: `Saved and re-scanned ${result.scanned} students — ${result.opened} new alert${
      result.opened === 1 ? '' : 's'
    }, ${result.reopened} refreshed, ${result.autoResolved} auto-resolved.`,
  };
}

/// Reset one cohort back to `DEFAULT_RULE_PARAMS` by deleting its overrides —
/// `resolveRules` then falls through to the defaults on its own.
export async function resetThresholdsAction(
  _prev: ThresholdState,
  formData: FormData,
): Promise<ThresholdState> {
  const session = await requireMentor();
  const cohortId = String(formData.get('cohortId') ?? '');
  if (!cohortId) return { ok: false, message: 'No cohort selected.' };

  if (!(await canEditCohort(cohortId, session))) {
    return { ok: false, message: 'You do not mentor anyone in that cohort.' };
  }

  await prisma.alertRuleConfig.deleteMany({ where: { cohortId } });
  const result = await runAlertScan(cohortId);

  revalidatePath('/mentor/settings');
  revalidatePath('/mentor/alerts');
  revalidatePath('/mentor');

  return {
    ok: true,
    message: `Reverted to programme defaults — ${result.scanned} students re-scanned, ${result.opened} new, ${result.autoResolved} auto-resolved.`,
  };
}

/**
 * A mentor may only tune cohorts they actually mentor into; a director or admin
 * arrives without a mentor group and may tune any cohort.
 *
 * Keyed on the role rather than on the presence of `session.mentorId`. The
 * previous `if (!mentorId)` gave the director branch to any MENTOR account with
 * no `Mentor` row, which could then rewrite — and immediately re-scan — the
 * thresholds of every cohort in the programme. That is not unreachable just
 * because the settings screen lists no cohort for such an account to click: the
 * cohort id arrives in FormData, and a hand-made POST supplies it.
 */
async function canEditCohort(cohortId: string, session: SessionPayload): Promise<boolean> {
  const scope = mentorScope(session);
  if (scope.kind === 'none') return false;
  if (scope.kind === 'programme') {
    return (await prisma.cohort.count({ where: { id: cohortId } })) > 0;
  }
  return (
    (await prisma.student.count({ where: { cohortId, mentorId: scope.mentorId } })) > 0
  );
}
