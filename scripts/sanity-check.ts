/**
 * Prints the mentor roster and one student's rollup so the progress formulas
 * can be eyeballed against the wireframe numbers without opening a browser.
 * Run with: npx tsx scripts/sanity-check.ts
 */

import { PrismaClient } from '@prisma/client';

import { focusQuality } from '../src/lib/analytics';
import {
  attendancePct,
  certificationPace,
  dimensionScores,
  overallCompletionPct,
  stageProgress,
  type CertProgressWithCert,
  type EnrollmentWithCourse,
} from '../src/lib/progress';

const prisma = new PrismaClient();

async function main() {
  const mentor = await prisma.mentor.findFirst({
    where: { mentorGroup: 'MBA-2026-B' },
    include: { user: true },
  });
  if (!mentor) throw new Error('Mentor MBA-2026-B not found — run the seed first.');

  const students = await prisma.student.findMany({
    where: { mentorId: mentor.id },
    include: {
      user: true,
      enrollments: { include: { course: true } },
      certProgress: { include: { cert: { include: { course: true } } } },
      attendance: { select: { present: true } },
      labSessions: true,
      alerts: { where: { resolvedAt: null } },
    },
    orderBy: { usn: 'asc' },
  });

  console.log(`\n${mentor.user.name} — ${mentor.mentorGroup} (${students.length} students)\n`);
  console.log(
    'Student'.padEnd(14) +
      'Overall'.padStart(8) +
      'Attend'.padStart(8) +
      'Pace'.padStart(10) +
      'Focus'.padStart(7) +
      'Hours'.padStart(8) +
      'Alerts'.padStart(8),
  );
  console.log('-'.repeat(63));

  for (const s of students) {
    const certs = s.certProgress as CertProgressWithCert[];
    const enrollments = s.enrollments as EnrollmentWithCourse[];
    const overall = overallCompletionPct(enrollments, certs);
    const att = attendancePct(s.attendance);
    const pace = certificationPace(certs);
    const focus = focusQuality(s.labSessions);

    console.log(
      s.user.name.padEnd(14) +
        `${overall.toFixed(0)}%`.padStart(8) +
        `${att.toFixed(0)}%`.padStart(8) +
        pace.status.padStart(10) +
        String(focus.focusScore).padStart(7) +
        `${focus.totalHours}h`.padStart(8) +
        String(s.alerts.length).padStart(8),
    );
  }

  const ananya = students.find((s) => s.usn === '1BG24MBA001');
  if (ananya) {
    const certs = ananya.certProgress as CertProgressWithCert[];
    const enrollments = ananya.enrollments as EnrollmentWithCourse[];
    console.log(`\n${ananya.user.name} — stage rail:`);
    for (const stage of stageProgress(enrollments, certs)) {
      console.log(`  ${stage.stage.padEnd(16)} ${stage.pct.toFixed(0)}%`);
    }
    console.log(`${ananya.user.name} — dimensions:`);
    for (const dim of dimensionScores(enrollments, certs)) {
      console.log(`  ${dim.dimension.padEnd(16)} ${dim.pct.toFixed(0)}%`);
    }
    console.log(`  sessions logged: ${ananya.labSessions.length}`);
  }

  const alertCounts = await prisma.alert.groupBy({
    by: ['ruleTriggered'],
    _count: true,
    where: { resolvedAt: null },
  });
  console.log('\nOpen alerts by rule:');
  for (const row of alertCounts) {
    console.log(`  ${row.ruleTriggered.padEnd(28)} ${row._count}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
