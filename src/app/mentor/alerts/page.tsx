import Grid from '@mui/material/Grid';

import { PageIntro, SectionCard, StatCard, TechNote } from '@/components/kit';
import { requireMentor } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { menteeWhere, mentorScope } from '@/lib/mentor-scope';
import { ALERT_RULE_HELP, ALERT_RULE_LABEL, SEVERITY_LABEL, relativeDay } from '@/lib/reep';
import { ALL_RULE_KEYS } from '@/lib/rules';
import type { Prisma } from '@prisma/client';

import { AlertsPanel, type AlertRowView } from './alerts-panel';
import { RescanButton } from './rescan-button';

export const metadata = { title: 'Alerts — Mentor' };
export const dynamic = 'force-dynamic';

/**
 * The alert queue.
 *
 * One table, one heading. Everything a mentor needs to judge an alert — the
 * message, when it fired, and the numbers the rule actually read — is on the
 * screen or one click away in the detail panel. Nothing has to be decoded.
 */
export default async function MentorAlertsPage() {
  const session = await requireMentor();
  const scope = mentorScope(session);

  const alerts = await prisma.alert.findMany({
    where: { student: menteeWhere(session) },
    include: { student: { include: { user: { select: { name: true } } } } },
    orderBy: { triggeredAt: 'desc' },
  });

  const open = alerts.filter((a) => a.resolvedAt == null);
  const criticalCount = open.filter((a) => a.severity === 'CRITICAL').length;
  const affected = new Set(open.map((a) => a.studentId)).size;
  const rulesFiring = new Set(open.map((a) => a.ruleTriggered)).size;

  // Everything the grid and the detail panel need, as plain JSON — dates are
  // formatted here so no Date object has to cross into a client component.
  const rows: AlertRowView[] = alerts.map((alert) => ({
    id: alert.id,
    studentId: alert.studentId,
    studentName: alert.student.user.name,
    usn: alert.student.usn,
    ruleLabel: ALERT_RULE_LABEL[alert.ruleTriggered],
    ruleHelp: ALERT_RULE_HELP[alert.ruleTriggered],
    severity: alert.severity,
    severityLabel: SEVERITY_LABEL[alert.severity],
    message: alert.message,
    triggeredLabel: relativeDay(alert.triggeredAt),
    triggeredStamp: formatStamp(alert.triggeredAt),
    triggeredAtMs: alert.triggeredAt.getTime(),
    resolved: alert.resolvedAt != null,
    stateLabel: alert.resolvedAt == null ? 'Open' : 'Resolved',
    resolvedLabel:
      alert.resolvedAt == null
        ? null
        : `${relativeDay(alert.resolvedAt)} by ${
            alert.resolvedBy === 'auto'
              ? 'the scan (the rule stopped firing)'
              : (alert.resolvedBy ?? 'a mentor')
          }`,
    context: readContext(alert.context),
  }));

  return (
    <>
      <PageIntro
        title="Alerts"
        subtitle={
          // The wording has to match the `where` above it. Keyed on the session
          // field, a mentor with no mentor group was told this was the
          // programme-wide view while `menteeWhere` was — correctly — showing
          // them nothing.
          scope.kind === 'mentees'
            ? 'Rules that are firing for your mentees. Open one to see the numbers behind it.'
            : scope.kind === 'programme'
              ? 'Programme-wide view — you are not attached to a mentor group.'
              : 'No mentor group is attached to this account, so no alert is in scope.'
        }
        action={<RescanButton />}
      />

      <Grid container spacing={2.5} sx={{ mb: 5 }}>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Open alerts"
            value={open.length}
            // An empty queue is not an achievement to colour in — it is simply
            // nothing to do, which reads best in ink.
            tone={open.length === 0 ? 'neutral' : criticalCount > 0 ? 'critical' : 'warning'}
            hint={`${alerts.length - open.length} resolved so far`}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Critical"
            value={criticalCount}
            tone={criticalCount > 0 ? 'critical' : 'neutral'}
            hint="Worth a conversation this week"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard label="Students involved" value={affected} hint="With at least one open alert" />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Rules firing"
            value={`${rulesFiring} of ${ALL_RULE_KEYS.length}`}
            hint="Thresholds live under Alert Thresholds"
          />
        </Grid>
      </Grid>

      <SectionCard
        title="The queue"
        subtitle="Newest first. Search by student, rule or message."
      >
        <AlertsPanel rows={rows} />
      </SectionCard>

      <TechNote>
        Every row here was written by <code>evaluateStudent()</code> in{' '}
        <code>src/lib/rules.ts</code>, which reads the <code>AlertRuleConfig</code> row for
        that student&apos;s cohort rather than any hard-coded number. The key/value pairs in
        the detail panel are the <code>context</code> JSON the rule snapshotted at the moment
        it fired, so a disputed alert is checked against what the rule saw instead of being
        re-derived from today&apos;s data. &ldquo;Check for new alerts&rdquo; posts to{' '}
        <code>/api/alerts/scan</code>: a rule that is still firing keeps its original{' '}
        <code>triggeredAt</code> but has its message refreshed, and a rule that has stopped
        firing is closed automatically with <code>resolvedBy = &quot;auto&quot;</code>.
        Resolving by hand stamps the mentor&apos;s own name and is scoped to their mentees, so
        an id borrowed from another group does nothing. None of these signals come from
        keystrokes, webcams or browser activity — only attendance, provider-reported progress
        and mentor observations.
      </TechNote>
    </>
  );
}

// ---------------------------------------------------------------------------

/// The rule's own inputs, turned into readable label/value pairs on the server
/// so the client component never has to reason about `Prisma.JsonValue`.
function readContext(context: Prisma.JsonValue): { key: string; value: string }[] {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return [];
  return Object.entries(context as Record<string, unknown>).map(([key, value]) => ({
    key: humanKey(key),
    value: formatContextValue(key, value),
  }));
}

/// "actualPct" → "Actual", "idleDays" → "Idle days". The Pct suffix moves onto
/// the value as a % sign so the label stays short.
function humanKey(key: string): string {
  const words = key
    .replace(/Pct$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatContextValue(key: string, value: unknown): string {
  if (value == null) return '—';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'number') {
    const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
    return /pct$/i.test(key) ? `${text}%` : text;
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function formatStamp(date: Date): string {
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
