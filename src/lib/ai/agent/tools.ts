import 'server-only';

/**
 * What the assistant can look at.
 *
 * One registry for every role. A tool is not "the student version" or "the
 * director version" — it is one function that runs inside a scope, and the
 * scope decides which rows it can see. That is why there is a single agent
 * rather than three: the difference between the roles lives in `scope.ts`, not
 * in twenty near-identical tools that would drift apart.
 *
 * Two conventions, both load-bearing:
 *
 * **No tool takes a student id.** They take a USN and pass it through
 * `resolveStudent`, which refuses anything outside scope. Internal cuids never
 * reach the model, so it cannot enumerate students by guessing.
 *
 * **Every tool returns compact text, never raw rows.** The model server here is
 * a 12B model in a 16k window, and `getStudentDetail()` alone serialises to
 * tens of thousands of tokens — dumping it would blow the context check in
 * `llm.ts` on the first step. Each `digest` below is a hand-written summary
 * that fits in a few hundred tokens and states its numbers exactly as the
 * dashboard states them, so the assistant and the screens cannot disagree.
 */

import { z } from 'zod';

import { prisma } from '@/lib/db';
import { certificationStatus, overallCompletionPct, attendancePct } from '@/lib/progress';
import { focusQuality } from '@/lib/analytics';
import {
  ALERT_RULE_LABEL,
  DIMENSION_LABEL,
  PACE_LABEL,
  SEVERITY_LABEL,
  STAGE_LABEL,
  formatHours,
  relativeDay,
} from '@/lib/reep';
import {
  getDirectorAnalytics,
  getStudentCertifications,
  getStudentDetail,
  getStudentTimeLog,
} from '@/lib/queries';
import type { CertProgressWithCert, EnrollmentWithCourse } from '@/lib/progress';

import { resolveStudent, visibleStudentWhere, type AgentScope, type ScopeKind } from './scope';

/// What a tool hands back. `factId` is what an answer cites; `denied` marks an
/// out-of-scope request so the trace can show it was refused rather than broken.
export type ToolResult = { factId: string; digest: string; denied?: boolean };

export type Tool<A extends z.ZodType = z.ZodType> = {
  name: string;
  /// Written for the model — this and `argsHint` are all it knows about the tool.
  description: string;
  /**
   * Argument documentation, which has to vary by scope.
   *
   * A student's assistant can read exactly one student, so a `usn` argument is
   * not merely unnecessary there — it is a trap. Shown a hint containing a
   * concrete USN, a 12B model copies it: the first live run had a student ask
   * "how am I doing on my certifications?" and watched the model pass the
   * example USN straight out of this documentation, earning an access refusal
   * for the student's own record. The refusal was correct; showing it something
   * to copy was not.
   */
  argsHint: (kind: ScopeKind) => string;
  args: A;
  /// Which scopes may call this at all. A tool absent from the catalogue is one
  /// the model never learns exists, which is a better defence than refusing it
  /// after the fact. Listing a scope here is not a shortcut around row-level
  /// scoping: a tool that reads students still applies `visibleStudentWhere` or
  /// goes through `resolveStudent`.
  scopes: ScopeKind[];
  run(args: z.infer<A>, scope: AgentScope): Promise<ToolResult>;
};

function tool<A extends z.ZodType>(t: Tool<A>): Tool<A> {
  return t;
}

const USN = z
  .string()
  .trim()
  .max(24)
  .optional()
  .describe('University seat number, e.g. 1BG24MBA001');

/**
 * How to document a `usn` argument to each scope.
 *
 * A director gets a concrete example because they have to name someone. A
 * student is told the argument does not exist, because for them it does not:
 * there is one readable record and the tool resolves it from the session.
 * `resolveStudent` still refuses a foreign USN if one arrives anyway — this only
 * removes the reason for one to.
 *
 * A mentor gets the shape without a plausible-looking value, for the same reason
 * the student gets none. The example USN is almost certainly in somebody else's
 * mentor group, a model that copies it earns a denial, and a denial *ends the
 * run* (see loop.ts) — so one copied placeholder would cost the mentor their
 * whole question. Sending them through find_students first costs a step and
 * always works.
 */
function usnHint(kind: ScopeKind, extra = ''): string {
  if (kind === 'self') {
    return `{${extra ? ` ${extra} ` : ''}} — always reads your own record; there is no student argument`;
  }
  const example = kind === 'mentees' ? 'a USN from find_students' : '1BG24MBA001';
  return `{ "usn": "${example}"${extra ? `, ${extra}` : ''} } — use a USN returned by find_students`;
}

const pct = (n: number) => `${n.toFixed(0)}%`;
const date = (d: Date | null | undefined) =>
  d ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

/// Refusals and misses come back as a readable observation rather than a thrown
/// error: the model needs to *say* what happened, and a step that throws would
/// end the run with a stack trace instead of an explanation.
function refusal(name: string, r: { denied: boolean; reason: string }): ToolResult {
  return { factId: `${name}#refused`, digest: r.reason, denied: r.denied };
}

// ---------------------------------------------------------------------------

export const TOOLS: Tool[] = [
  // -------------------------------------------------------------------------
  tool({
    name: 'student_record',
    description:
      'The headline record for one student: stage, overall REEP completion, certification pace, attendance, focus score and finish forecast.',
    argsHint: (kind) => usnHint(kind),
    args: z.object({ usn: USN }),
    scopes: ['self', 'mentees', 'programme'],
    async run({ usn }, scope) {
      const found = await resolveStudent(scope, usn);
      if (!found.ok) return refusal('student_record', found);

      const detail = await getStudentDetail(found.student.id);
      if (!detail) return refusal('student_record', { denied: false, reason: 'No record found.' });

      const { student, overallPct, certPace, focus, consistency, forecast } = detail;
      const openAlerts = detail.alerts.filter((a) => a.resolvedAt === null);

      const lines = [
        `${student.user.name} · USN ${student.usn} · ${student.cohort.name}`,
        `Stage: ${STAGE_LABEL[student.currentStage]}, Semester ${student.currentSemester}`,
        `Overall REEP completion: ${pct(overallPct)}`,
        `Certification pace: ${PACE_LABEL[certPace.status]} — ${pct(certPace.actualPct)} actual vs ${pct(certPace.expectedPct)} expected (${certPace.deviationPct >= 0 ? '+' : ''}${certPace.deviationPct.toFixed(0)} points)`,
        `Attendance (instructor-led): ${pct(detail.attendancePct)}`,
        `Focus score: ${focus.focusScore}/100 — ${focus.progressPerHour.toFixed(2)} progress points per logged hour across ${focus.totalSessions} sessions (${formatHours(focus.totalHours)} total)`,
        `Consistency (30d): active ${consistency.activeDays}/${consistency.windowDays} days, current streak ${consistency.currentStreakDays}d, longest gap ${consistency.longestGapDays}d, last active ${relativeDay(consistency.lastActiveAt)}`,
        `Forecast: ${forecast.velocityPctPerWeek.toFixed(1)}%/week now vs ${forecast.requiredPctPerWeek.toFixed(1)}%/week needed over ${forecast.weeksRemaining.toFixed(1)} weeks — projected ${pct(forecast.projectedCompletionPct)} by the cohort deadline (${forecast.willFinishOnTime ? 'on time' : 'short'})`,
        forecast.extraHoursPerWeekNeeded > 0
          ? `To land on time at this student's own yield: about ${formatHours(forecast.extraHoursPerWeekNeeded)} more per week.`
          : 'No additional weekly hours required at the current rate.',
        `Open alerts: ${openAlerts.length === 0 ? 'none' : openAlerts.map((a) => `${SEVERITY_LABEL[a.severity]} ${ALERT_RULE_LABEL[a.ruleTriggered]}`).join('; ')}`,
        `Courses enrolled: ${detail.enrollments.length} — ${detail.enrollments
          .map((e) => `${e.enrollment.courseCode} ${pct(e.completionPct)}`)
          .join(', ')}`,
      ];

      return { factId: `student_record#${student.usn}`, digest: lines.join('\n') };
    },
  }),

  // -------------------------------------------------------------------------
  tool({
    name: 'certifications',
    description:
      'Every certification for one student with provider, required hours, progress, due date and status (COMPLETED / IN_PROGRESS / OVERDUE / NOT_STARTED).',
    argsHint: (kind) => usnHint(kind, '"status": "all|completed|in_progress|overdue"'),
    args: z.object({
      usn: USN,
      status: z.enum(['all', 'completed', 'in_progress', 'overdue']).default('all'),
    }),
    scopes: ['self', 'mentees', 'programme'],
    async run({ usn, status }, scope) {
      const found = await resolveStudent(scope, usn);
      if (!found.ok) return refusal('certifications', found);

      const data = await getStudentCertifications(found.student.id);
      if (!data) return refusal('certifications', { denied: false, reason: 'No record found.' });

      const wanted: Record<string, string | null> = {
        all: null,
        completed: 'COMPLETED',
        in_progress: 'IN_PROGRESS',
        overdue: 'OVERDUE',
      };
      const filter = wanted[status];
      const rows = filter ? data.rows.filter((r) => r.status === filter) : data.rows;

      const lines = [
        `${found.student.name} (${found.student.usn}) — ${data.summary.completed} completed, ${data.summary.inProgress} in progress, ${data.summary.overdue} overdue, of ${data.summary.required} required.`,
        ...rows.map(
          (r) =>
            `- ${r.cert.cert.name} [${r.cert.certCode}] · ${r.cert.cert.provider} · ${r.cert.cert.requiredHours}h · course ${r.courseCode} (${STAGE_LABEL[r.stage]}) · ${pct(r.cert.progressPct)} · ${r.status} · due ${date(r.cert.dueDate)}${r.cert.cert.isOptional ? ' · optional' : ''}`,
        ),
      ];
      if (rows.length === 0) lines.push(`(no certifications matched status "${status}")`);

      return { factId: `certifications#${found.student.usn}`, digest: lines.join('\n') };
    },
  }),

  // -------------------------------------------------------------------------
  tool({
    name: 'time_log',
    description:
      'How one student actually spends their learning time: hours by learning mode, weekly totals against target, best time of day, and hours per course.',
    argsHint: (kind) => usnHint(kind),
    args: z.object({ usn: USN }),
    scopes: ['self', 'mentees', 'programme'],
    async run({ usn }, scope) {
      const found = await resolveStudent(scope, usn);
      if (!found.ok) return refusal('time_log', found);

      const log = await getStudentTimeLog(found.student.id, 0);
      if (!log) return refusal('time_log', { denied: false, reason: 'No record found.' });

      const bestBand = [...log.timeOfDay].sort((a, b) => b.progressPerHour - a.progressPerHour)[0];

      const lines = [
        `${found.student.name} (${found.student.usn}) — weekly target ${formatHours(log.student.weeklyHourTarget)}.`,
        `This week: ${formatHours(log.weekTotalHours)} logged.`,
        `Last 8 weeks: ${log.weekly.map((w) => `${w.label} ${w.hours.toFixed(1)}h`).join(', ')}`,
        `By mode: ${log.modes.map((m) => `${m.label} ${formatHours(m.hours)} (${pct(m.pct)}, ${m.sessionCount} sessions)`).join(', ')}`,
        `Focus: ${log.focus.focusScore}/100, ${log.focus.progressPerHour.toFixed(2)} points/hour, median session ${log.focus.medianSessionMin} min, abandoned ${pct(log.focus.abandonedRatePct)} of sessions.`,
        `Session mix: ${Object.entries(log.focus.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`,
        bestBand
          ? `Most productive band: ${bestBand.band} at ${bestBand.progressPerHour.toFixed(2)} points/hour over ${formatHours(bestBand.hours)}.`
          : 'No time-of-day pattern yet.',
        `Hours per course: ${log.allocation.map((a) => `${a.courseCode} ${formatHours(a.loggedHours)} of ${formatHours(a.requiredHours)} required (${pct(a.coveragePct)} covered, ${a.progressPerHour.toFixed(2)} points/hour)`).join('; ') || 'none logged'}`,
      ];

      return { factId: `time_log#${found.student.usn}`, digest: lines.join('\n') };
    },
  }),

  // -------------------------------------------------------------------------
  tool({
    name: 'alerts',
    description:
      'Open and recently resolved alerts for one student, with the rule that fired and when.',
    argsHint: (kind) => usnHint(kind),
    args: z.object({ usn: USN }),
    scopes: ['self', 'mentees', 'programme'],
    async run({ usn }, scope) {
      const found = await resolveStudent(scope, usn);
      if (!found.ok) return refusal('alerts', found);

      const rows = await prisma.alert.findMany({
        where: { studentId: found.student.id },
        orderBy: [{ resolvedAt: 'asc' }, { triggeredAt: 'desc' }],
        take: 15,
      });

      const lines = [
        `${found.student.name} (${found.student.usn}) — ${rows.filter((r) => !r.resolvedAt).length} open of ${rows.length} recent.`,
        ...rows.map(
          (a) =>
            `- [${SEVERITY_LABEL[a.severity]}] ${ALERT_RULE_LABEL[a.ruleTriggered]}: ${a.message} · triggered ${relativeDay(a.triggeredAt)}${a.resolvedAt ? ` · resolved ${relativeDay(a.resolvedAt)}` : ' · OPEN'}`,
        ),
      ];
      if (rows.length === 0) lines.push('(no alerts have ever fired for this student)');

      return { factId: `alerts#${found.student.usn}`, digest: lines.join('\n') };
    },
  }),

  // -------------------------------------------------------------------------
  // Staff-only from here down. These are absent from a student's catalogue, so
  // the model is never told they exist.
  //
  // `mentees` is staff too, but not everywhere: a tool that reads *rows* can
  // take it, because `visibleStudentWhere` narrows those rows to the mentor
  // group. A tool that returns a programme-wide aggregate has no such seam, so
  // it stays `programme`.
  // -------------------------------------------------------------------------
  tool({
    name: 'find_students',
    description:
      'Search the roster by name, USN, stage or risk. Returns USNs to use with the other tools. Staff only.',
    argsHint: () =>
      '{ "query": "priya", "stage": "any|REBOOT|EXCEL|EXCEL_ADVANCED|ELEVATE", "risk": "any|at_risk|behind", "limit": 12 } — all optional, "any" means no filter',
    args: z.object({
      query: z.string().trim().max(60).optional(),
      // "any" is accepted rather than requiring the field to be omitted. A
      // model asked for "students most at risk" reaches for `stage: "any"` —
      // it is the obvious mirror of `risk: "any"` right below — and rejecting
      // it cost a real run two of its four steps before it gave up. Widening
      // the enum is cheaper than teaching the model our omission convention.
      stage: z.enum(['any', 'REBOOT', 'EXCEL', 'EXCEL_ADVANCED', 'ELEVATE']).default('any'),
      risk: z.enum(['any', 'at_risk', 'behind']).default('any'),
      limit: z.number().int().min(1).max(25).default(12),
    }),
    // Safe for a mentor because `visibleStudentWhere(scope)` below is the first
    // key in the `where` — the search runs over the mentor group, not over the
    // roster with the group filtered out afterwards.
    scopes: ['mentees', 'programme'],
    async run({ query, stage, risk, limit }, scope) {
      // Having been shown "any" as the no-filter value for stage and risk, the
      // model puts it in `query` too — where it became a name substring that
      // matched nobody, and the assistant reported "no students are at risk" to
      // a director. A confidently wrong roster is worse than a slow one, so the
      // placeholders are absorbed here rather than trusted as a search term.
      const term = query && !['any', 'all', '*', 'none'].includes(query.toLowerCase())
        ? query
        : null;

      const students = await prisma.student.findMany({
        where: {
          ...visibleStudentWhere(scope),
          ...(stage && stage !== 'any' ? { currentStage: stage } : {}),
          ...(term
            ? {
                OR: [
                  { usn: { contains: term, mode: 'insensitive' as const } },
                  { user: { name: { contains: term, mode: 'insensitive' as const } } },
                ],
              }
            : {}),
        },
        include: {
          user: { select: { name: true } },
          cohort: { select: { name: true } },
          enrollments: { include: { course: true } },
          certProgress: { include: { cert: { include: { course: true } } } },
          attendance: { select: { present: true } },
          labSessions: { orderBy: { checkInAt: 'desc' } },
          alerts: { where: { resolvedAt: null }, select: { severity: true } },
        },
        orderBy: { user: { name: 'asc' } },
        // Read a wider slice than we return, because the risk filter below is
        // computed rather than stored and cannot be pushed into the query.
        take: risk === 'any' ? limit : 120,
      });

      const now = new Date();
      const rows = students
        .map((s) => {
          const certs = s.certProgress as CertProgressWithCert[];
          const enrollments = s.enrollments as EnrollmentWithCourse[];
          const overdue = certs.filter((c) => certificationStatus(c, now).status === 'OVERDUE');
          return {
            usn: s.usn,
            name: s.user.name,
            cohort: s.cohort.name,
            stage: s.currentStage,
            overallPct: overallCompletionPct(enrollments, certs),
            attendance: attendancePct(s.attendance),
            focus: focusQuality(s.labSessions).focusScore,
            lastActive: s.labSessions[0]?.checkInAt ?? null,
            criticalAlerts: s.alerts.filter((a) => a.severity === 'CRITICAL').length,
            openAlerts: s.alerts.length,
            overdueCerts: overdue.length,
          };
        })
        .filter((r) =>
          risk === 'at_risk'
            ? r.criticalAlerts > 0
            : risk === 'behind'
              ? r.overdueCerts > 0 || r.overallPct < 50
              : true,
        )
        .slice(0, limit);

      const lines = [
        `${rows.length} student${rows.length === 1 ? '' : 's'} matched${term ? ` "${term}"` : ''}${stage && stage !== 'any' ? ` in ${STAGE_LABEL[stage]}` : ''}${risk !== 'any' ? ` (${risk.replace('_', ' ')})` : ''}.`,
        ...rows.map(
          (r) =>
            `- ${r.name} · ${r.usn} · ${r.cohort} · ${STAGE_LABEL[r.stage]} · ${pct(r.overallPct)} complete · attendance ${pct(r.attendance)} · focus ${r.focus}/100 · ${r.overdueCerts} overdue certs · ${r.openAlerts} open alerts · last active ${relativeDay(r.lastActive)}`,
        ),
      ];
      if (rows.length === 0) lines.push('(nothing matched — try a broader query)');

      return { factId: 'find_students#roster', digest: lines.join('\n') };
    },
  }),

  // -------------------------------------------------------------------------
  tool({
    name: 'programme_analytics',
    description:
      'Programme-wide numbers: cohort roll-up, average completion, placement readiness, at-risk counts and the courses acting as bottlenecks. Staff only.',
    argsHint: () => '{} — takes no arguments',
    args: z.object({}),
    // Not `mentees`. `getDirectorAnalytics()` rolls up every cohort and takes no
    // scope argument, and a per-mentor version of it does not exist —
    // `/mentor/reports/export` says as much when it refuses and points at the
    // director report. A mentor asking for programme numbers is told the tool
    // is not theirs, rather than shown the whole programme.
    scopes: ['programme'],
    async run(_args, _scope) {
      const a = await getDirectorAnalytics();

      const lines = [
        `Programme: ${a.summary.studentCount} students across ${a.summary.cohortCount} cohorts.`,
        `Average REEP completion ${pct(a.summary.reepCompletion)}, average required-certification completion ${pct(a.summary.certCompletion)}.`,
        `Placement-ready ${pct(a.summary.placementReadyPct)} against criteria: REEP ≥ ${a.criteria.minReepCompletionPct}%, certs ≥ ${a.criteria.minCertCompletionPct}%, attendance ≥ ${a.criteria.minAttendancePct}%${a.criteria.requireCoreCerts ? ', all core certifications complete' : ''}.`,
        `At risk (open CRITICAL alert): ${a.summary.atRiskCount} students.`,
        '',
        'By cohort:',
        ...a.cohortRollup.map(
          (c) =>
            `- ${c.cohort.name} (${c.cohort.code}): ${c.studentCount} students · ${pct(c.reepPct)} complete · ${pct(c.placementReadyPct)} placement-ready · ${c.atRisk} at risk`,
        ),
        '',
        'Bottleneck courses (lowest mean completion):',
        ...a.bottlenecks.map(
          (b) =>
            `- ${b.courseCode} ${b.courseName} (${STAGE_LABEL[b.stage]}): ${b.completionPct}% mean completion across ${b.enrolledCount} enrolled, ${b.atRiskCount} at risk`,
        ),
        '',
        `At-risk trend by week: ${a.atRiskTrend.map((t) => `${t.label} ${t.value}`).join(', ')}`,
      ];

      return { factId: 'programme_analytics#summary', digest: lines.join('\n') };
    },
  }),

  // -------------------------------------------------------------------------
  tool({
    name: 'mentor_notes',
    description:
      'Faculty mentor notes and logged actions for one student, most recent first. Staff only — students cannot read notes written about them.',
    argsHint: (kind) => usnHint(kind),
    args: z.object({ usn: USN }),
    scopes: ['mentees', 'programme'],
    async run({ usn }, scope) {
      const found = await resolveStudent(scope, usn);
      if (!found.ok) return refusal('mentor_notes', found);

      const notes = await prisma.mentorNote.findMany({
        where: { studentId: found.student.id },
        orderBy: { createdAt: 'desc' },
        take: 12,
        include: { mentor: { include: { user: { select: { name: true } } } } },
      });

      const lines = [
        `${found.student.name} (${found.student.usn}) — ${notes.length} recent note${notes.length === 1 ? '' : 's'}.`,
        ...notes.map(
          (n) =>
            `- ${date(n.createdAt)} · ${n.mentor.user.name} · action ${n.linkedAction}: ${n.noteText.slice(0, 300)}`,
        ),
      ];
      if (notes.length === 0) lines.push('(no mentor notes recorded)');

      return { factId: `mentor_notes#${found.student.usn}`, digest: lines.join('\n') };
    },
  }),
];

/// The tools a given scope is even told about.
export function toolsFor(scope: AgentScope): Tool[] {
  return TOOLS.filter((t) => t.scopes.includes(scope.kind));
}

export function findTool(scope: AgentScope, name: string): Tool | undefined {
  return toolsFor(scope).find((t) => t.name === name);
}
