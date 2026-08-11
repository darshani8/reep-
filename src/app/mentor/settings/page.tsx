import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import {
  EmptyState,
  InfoBanner,
  PageIntro,
  SectionCard,
  StatCard,
  TechNote,
} from '@/components/kit';
import { requireMentor } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { menteeWhere, mentorScope } from '@/lib/mentor-scope';
import { ALERT_RULE_HELP, ALERT_RULE_LABEL } from '@/lib/reep';
import { DEFAULT_RULE_PARAMS, resolveRules } from '@/lib/rules';

import { ThresholdForm, type ThresholdRow } from './threshold-form';

export const metadata = { title: 'Alert Thresholds — Mentor' };
export const dynamic = 'force-dynamic';

/**
 * The admin-configurable thresholds.
 *
 * The one thing this screen has to make unmissable is that a threshold belongs
 * to a *cohort*, not to the programme — so the cohort is named in the heading,
 * in the banner, on every card and on the save button.
 */
export default async function MentorSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string }>;
}) {
  const session = await requireMentor();
  const params = await searchParams;

  // A mentor tunes the cohorts they mentor into; a director or admin arrives
  // without a mentor group and gets the whole list — including cohorts with no
  // students yet, which is why this is not simply `{ students: { some: … } }`.
  const scope = mentorScope(session);
  const cohorts = await prisma.cohort.findMany({
    where:
      scope.kind === 'programme'
        ? undefined
        : scope.kind === 'mentees'
          ? { students: { some: { mentorId: scope.mentorId } } }
          : { id: '__none__' },
    orderBy: { code: 'asc' },
  });

  if (cohorts.length === 0) {
    return (
      <>
        <PageIntro
          title="Alert thresholds"
          subtitle="The numbers each alert rule compares against."
        />
        <EmptyState
          title="No cohort to configure."
          hint="Thresholds are stored per cohort, so this screen needs at least one cohort with students assigned to you."
        />
        <TechNote>
          Thresholds live in <code>AlertRuleConfig</code>, keyed on{' '}
          <code>[cohortId, ruleKey]</code>. With no cohort in scope there is no row to write,
          so the screen says so rather than offering a form that would save nowhere.
        </TechNote>
      </>
    );
  }

  const cohort = cohorts.find((c) => c.id === params.cohort) ?? cohorts[0];

  const [configs, cohortSize, menteeCount, openAlerts] = await Promise.all([
    prisma.alertRuleConfig.findMany({ where: { cohortId: cohort.id } }),
    prisma.student.count({ where: { cohortId: cohort.id } }),
    // "How many of these are mine" — the same scope as the cohort list above,
    // spread in rather than re-derived from `session.mentorId`, which would
    // count the whole cohort as a broken mentor's own.
    prisma.student.count({ where: { cohortId: cohort.id, ...menteeWhere(session) } }),
    prisma.alert.count({ where: { resolvedAt: null, student: { cohortId: cohort.id } } }),
  ]);

  const rules = resolveRules(configs);
  const configuredKeys = new Set(configs.map((c) => c.ruleKey));

  const rows: ThresholdRow[] = rules.map((rule) => ({
    ruleKey: rule.ruleKey,
    label: ALERT_RULE_LABEL[rule.ruleKey],
    help: ALERT_RULE_HELP[rule.ruleKey],
    enabled: rule.enabled,
    severity: rule.severity,
    params: rule.params as unknown as Record<string, number>,
    defaults: DEFAULT_RULE_PARAMS[rule.ruleKey] as unknown as Record<string, number>,
    configured: configuredKeys.has(rule.ruleKey),
  }));

  const enabledCount = rules.filter((r) => r.enabled).length;

  return (
    <>
      <PageIntro
        title={`Alert thresholds for ${cohort.code}`}
        subtitle={`${cohort.name} · ${cohort.batchLabel}`}
      />

      <InfoBanner tone="info" title={`These numbers apply to ${cohort.code} only`}>
        Every cohort keeps its own thresholds. A rule you leave alone falls back to the
        programme default, never to another cohort&apos;s setting. Saving re-checks this cohort
        straight away, so you can see what a change actually did.
      </InfoBanner>

      {cohorts.length > 1 && (
        <SectionCard
          title="Which cohort are you editing?"
          subtitle="Each one carries its own set of thresholds."
        >
          {/* A picker, not the point of the screen — the selected one is marked
              by a quiet fill, and saving keeps the accent to itself. */}
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
            {cohorts.map((option) => {
              const active = option.id === cohort.id;
              return (
                <Button
                  key={option.id}
                  href={`/mentor/settings?cohort=${option.id}`}
                  size="small"
                  variant="text"
                  aria-current={active ? 'true' : undefined}
                  sx={{
                    color: active ? 'text.primary' : 'text.secondary',
                    bgcolor: active ? 'action.selected' : 'transparent',
                  }}
                >
                  {option.code}
                  <Typography component="span" variant="caption" sx={{ ml: 1, opacity: 0.7 }}>
                    {option.batchLabel}
                  </Typography>
                </Button>
              );
            })}
          </Stack>
        </SectionCard>
      )}

      <Grid container spacing={2.5} sx={{ mb: 5 }}>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Students in this cohort"
            value={cohortSize}
            hint="Everyone a change here affects"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Your mentees here"
            value={menteeCount}
            hint="Whose alerts you will see"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Rules switched on"
            value={`${enabledCount} of ${rules.length}`}
            hint={
              configuredKeys.size === 0
                ? 'All on programme defaults'
                : `${configuredKeys.size} tuned for this cohort`
            }
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Open alerts right now"
            value={openAlerts}
            tone={openAlerts === 0 ? 'neutral' : 'warning'}
            hint="Recounted the moment you save"
          />
        </Grid>
      </Grid>

      <SectionCard
        title="The five rules"
        subtitle="A rule you leave alone keeps the programme default."
      >
        <ThresholdForm cohortId={cohort.id} cohortCode={cohort.code} rows={rows} />
      </SectionCard>

      <TechNote>
        Each card writes one <code>AlertRuleConfig</code> row — unique on{' '}
        <code>[cohortId, ruleKey]</code> — holding <code>enabled</code>, <code>severity</code>{' '}
        and a <code>params</code> JSON blob. Saving upserts all five rows and then calls{' '}
        <code>runAlertScan(cohortId)</code>, so the alert queue reflects the new numbers
        immediately instead of waiting for a nightly pass; the message under the button is
        that scan&apos;s own count of what opened and what closed. The engine reads these rows
        through <code>resolveRules()</code>, which merges a cohort&apos;s overrides on top of{' '}
        <code>DEFAULT_RULE_PARAMS</code> — so a half-configured cohort still evaluates every
        rule, and &ldquo;revert to defaults&rdquo; is simply deleting the rows rather than
        writing a second set of magic numbers. The server re-clamps every value to the range
        its field advertises and re-checks that you mentor someone in the cohort, so nothing
        here trusts what the browser posted.
      </TechNote>
    </>
  );
}
