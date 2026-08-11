/**
 * The rules that decide whether a logged hour is believable.
 *
 * Time entry is the one place in this product where a person types a number
 * that every other screen then reasons from, so the interesting cases are all
 * refusals: a day that has not happened, a day before the student was on the
 * programme, more hours than the day has held so far. Each one of those, if it
 * slipped through, would show up as a plausible figure rather than an error.
 *
 * It also checks the standing marks — self-reported versus mentor-entered,
 * contemporaneous versus backfilled — because those are what let a mentor read
 * the hours without having to trust them all equally.
 *
 * Every row it writes is removed again, so the seeded demo data stays
 * deterministic.
 *
 * Usage: npx tsx --env-file=.env scripts/test-activity.ts [baseUrl]
 */

import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';

import {
  clockLabel,
  earliestLoggableDay,
  isBackdated,
  loggedAfterDays,
  minutesBetween,
  parseClock,
  parseDay,
  standingFor,
} from '@/lib/activity-rules';

const prisma = new PrismaClient();
const BASE = process.argv[2] ?? 'http://localhost:3100';

let pass = 0;
let fail = 0;
const written: string[] = [];

function report(ok: boolean, label: string, detail = '') {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label.padEnd(56)} ${detail}`);
}

async function tokenFor(email: string) {
  const user = await prisma.user.findUnique({
    where: { email },
    include: { student: true, mentor: true },
  });
  if (!user) throw new Error(`No user ${email}`);

  const secret = new TextEncoder().encode(process.env.AUTH_SECRET);
  return new SignJWT({
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    studentId: user.student?.id,
    mentorId: user.mentor?.id,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(secret);
}

function get(path: string, token: string) {
  return fetch(`${BASE}${path}`, {
    headers: { cookie: `reep_session=${token}` },
    redirect: 'manual',
  });
}

async function log(token: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/activity`, {
    method: 'POST',
    headers: { cookie: `reep_session=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  const payload = await res.json().catch(() => ({}));
  if (payload?.session?.id) written.push(payload.session.id);
  return { status: res.status, payload };
}

function isoDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

async function main() {
  const student = await tokenFor('ananya.r@bgscet.ac.in');
  const mentor = await tokenFor('rakesh.iyer@bgscet.ac.in');
  const director = await tokenFor('s.manjunath@bgscet.ac.in');

  const ananya = await prisma.student.findFirst({
    where: { user: { email: 'ananya.r@bgscet.ac.in' } },
    include: { cohort: true },
  });
  if (!ananya) throw new Error('Seed data missing — run npm run db:seed');

  const enrolment = await prisma.enrollment.findFirst({
    where: { studentId: ananya.id },
    orderBy: { courseCode: 'asc' },
  });
  if (!enrolment) throw new Error('Ananya has no enrolments');

  // --- how far back you may reach ----------------------------------------

  console.log('\nThe window a day may fall in');

  const old = await log(student, {
    date: isoDay(addDays(new Date(), -45)),
    activity: 'READING',
    durationMin: 90,
    note: 'Caught up after the organizational study block.',
  });
  report(
    old.status === 201 && old.payload.session?.loggedAfterDays >= 44,
    '45 days back is allowed, and marked as entered late',
    `HTTP ${old.status}, ${old.payload.session?.loggedAfterDays} days later`,
  );

  const beforeStart = await log(student, {
    date: isoDay(addDays(ananya.cohort.startDate, -10)),
    activity: 'READING',
    durationMin: 60,
  });
  report(
    beforeStart.status === 400,
    'before the cohort existed is refused',
    beforeStart.payload.error,
  );

  const tomorrow = await log(student, {
    date: isoDay(addDays(new Date(), 1)),
    activity: 'READING',
    durationMin: 60,
  });
  report(tomorrow.status === 400, 'tomorrow is refused', tomorrow.payload.error);

  const longerThanToday = await log(student, {
    date: isoDay(new Date()),
    activity: 'READING',
    durationMin: 720,
  });
  report(
    longerThanToday.status === 400 || new Date().getHours() >= 12,
    'more hours than today has held is refused',
    longerThanToday.payload.error ?? `HTTP ${longerThanToday.status}`,
  );

  // --- what the catalogue does and does not cover -------------------------

  console.log('\nThe activity catalogue');

  const otherWithoutNote = await log(student, {
    date: isoDay(addDays(new Date(), -1)),
    activity: 'OTHER',
    durationMin: 60,
  });
  report(
    otherWithoutNote.status === 400,
    '"Something else" without the note is refused',
    otherWithoutNote.payload.error,
  );

  const otherWithNote = await log(student, {
    date: isoDay(addDays(new Date(), -1)),
    activity: 'OTHER',
    durationMin: 60,
    note: 'Case competition prep with the placement cell.',
  });
  report(
    otherWithNote.status === 201 &&
      otherWithNote.payload.session?.activityNote?.includes('Case competition'),
    '"Something else" with the note keeps the words',
    otherWithNote.payload.session?.module,
  );

  const notEnrolled = await log(student, {
    date: isoDay(addDays(new Date(), -1)),
    activity: 'READING',
    durationMin: 60,
    courseCode: 'REE999',
  });
  report(
    notEnrolled.status === 400,
    'a course they are not enrolled on is refused',
    notEnrolled.payload.error,
  );

  // --- what the row is worth ----------------------------------------------

  console.log('\nStanding of a hand-entered row');

  const before = await prisma.enrollment.findUnique({
    where: { id: enrolment.id },
    select: { selfLearningHoursLogged: true },
  });

  const credited = await log(student, {
    date: isoDay(addDays(new Date(), -2)),
    activity: 'PRACTICE_PROBLEMS',
    durationMin: 120,
    courseCode: enrolment.courseCode,
  });

  const after = await prisma.enrollment.findUnique({
    where: { id: enrolment.id },
    select: { selfLearningHoursLogged: true },
  });

  report(
    credited.status === 201 && credited.payload.session?.creditedToCourse === true,
    'naming a course credits that enrolment',
    `${before?.selfLearningHoursLogged}h → ${after?.selfLearningHoursLogged}h`,
  );

  const row = await prisma.labSession.findUnique({
    where: { id: credited.payload.session.id },
  });
  report(
    row?.source === 'SELF_REPORTED' &&
      row?.mentorConfirmed === false &&
      row?.progressDeltaPct === null,
    "a student's own entry is self-reported and earns no progress",
    `${row?.source}, confirmed=${row?.mentorConfirmed}, delta=${row?.progressDeltaPct}`,
  );

  const lecture = await log(student, {
    date: isoDay(addDays(new Date(), -3)),
    activity: 'LECTURE',
    durationMin: 90,
    courseCode: enrolment.courseCode,
  });
  report(
    lecture.status === 201 && lecture.payload.session?.creditedToCourse === false,
    'a lecture is attendance, not self-learning hours',
    lecture.payload.session?.mode,
  );

  // --- the spreadsheet grid saves a batch ---------------------------------

  console.log('\nSaving a grid of rows at once');

  async function bulk(entries: Record<string, unknown>[]) {
    const res = await fetch(`${BASE}/api/activity/bulk`, {
      method: 'POST',
      headers: { cookie: `reep_session=${student}`, 'content-type': 'application/json' },
      body: JSON.stringify({ entries }),
      redirect: 'manual',
    });
    const payload = await res.json().catch(() => ({}));
    for (const row of payload?.results ?? []) {
      if (row.ok && payload.ids?.[row.index]) written.push(payload.ids[row.index]);
    }
    return { status: res.status, payload };
  }

  const sessionsBefore = await prisma.labSession.count({ where: { studentId: ananya.id } });

  const batch = await bulk([
    { date: isoDay(addDays(new Date(), -4)), activity: 'READING', durationMin: 45 },
    { date: isoDay(addDays(new Date(), -5)), activity: 'REVISION', durationMin: 90 },
    { date: isoDay(addDays(new Date(), -6)), activity: 'GROUP_STUDY', durationMin: 120 },
  ]);
  report(
    batch.status === 201 && batch.payload.savedCount === 3,
    'a clean batch of 3 saves as one call',
    `HTTP ${batch.status}, saved ${batch.payload.savedCount}`,
  );

  const afterBatch = await prisma.labSession.count({ where: { studentId: ananya.id } });
  report(
    afterBatch === sessionsBefore + 3,
    'three rows really landed',
    `${sessionsBefore} → ${afterBatch}`,
  );

  // The behaviour the grid depends on: one bad row must not discard the good ones.
  const mixed = await bulk([
    { date: isoDay(addDays(new Date(), -7)), activity: 'READING', durationMin: 30 },
    { date: isoDay(addDays(new Date(), 1)), activity: 'READING', durationMin: 30 }, // future
    { date: isoDay(addDays(new Date(), -7)), activity: 'OTHER', durationMin: 30 }, // no note
    { date: isoDay(addDays(new Date(), -8)), activity: 'PROJECT_WORK', durationMin: 60 },
  ]);
  report(
    mixed.status === 207,
    'a partly-valid batch answers 207, not 201 or 400',
    `HTTP ${mixed.status}`,
  );
  report(
    mixed.payload.savedCount === 2 && mixed.payload.failedCount === 2,
    'the good rows save and the bad ones do not',
    `saved ${mixed.payload.savedCount}, failed ${mixed.payload.failedCount}`,
  );
  const failures = (mixed.payload.results ?? []).filter((r: { ok: boolean }) => !r.ok);
  report(
    failures.every((r: { error?: string }) => Boolean(r.error)) &&
      failures.length === 2 &&
      failures[0].index === 1 &&
      failures[1].index === 2,
    'each failure is indexed and carries its reason',
    failures.map((r: { index: number; error?: string }) => `#${r.index}`).join(' '),
  );

  const empty = await bulk([]);
  report(empty.status === 400, 'an empty batch is refused', `HTTP ${empty.status}`);

  const huge = await bulk(
    Array.from({ length: 61 }, () => ({
      date: isoDay(addDays(new Date(), -3)),
      activity: 'READING',
      durationMin: 30,
    })),
  );
  report(huge.status === 400, 'an oversized batch is refused', `HTTP ${huge.status}`);

  const anon = await fetch(`${BASE}/api/activity/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: [] }),
    redirect: 'manual',
  });
  report(anon.status === 401, 'anonymous callers are refused', `HTTP ${anon.status}`);

  // Everything the batch wrote has to come back out again, same as the singles.
  const batchRows = await prisma.labSession.findMany({
    where: { studentId: ananya.id, checkInAt: { gte: addDays(new Date(), -9) } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  for (const row of batchRows) if (!written.includes(row.id)) written.push(row.id);

  // --- the staff panel is reachable by both roles -------------------------

  console.log("\nLogging on a student's behalf");

  for (const [role, token] of [
    ['mentor', mentor],
    ['director', director],
  ] as const) {
    const page = await get(`/mentor/student/${ananya.id}`, token);
    const body = page.status === 200 ? await page.text() : '';
    report(
      page.status === 200 && body.includes('Log time for'),
      `${role} sees the log panel`,
      `HTTP ${page.status}`,
    );
  }

  const asStudent = await get(`/mentor/student/${ananya.id}`, student);
  report(
    asStudent.status === 307 || asStudent.status === 302,
    'a student cannot open it',
    `HTTP ${asStudent.status}`,
  );

  // The Server Action itself cannot be posted to from here without the id Next
  // generates for it, and its guard is covered by the three page loads above.
  // What is left is the one thing that actually differs between a mentor's entry
  // and a student's, and that is a pure function.
  const staff = standingFor(
    { kind: 'staff', label: 'Prof. Rakesh Iyer (Faculty Mentor)' },
    new Date('2026-08-05T09:00:00'),
  );
  report(
    staff.source === 'MANUAL' && staff.mentorConfirmed === true,
    'a staff entry is MANUAL and already confirmed',
    `${staff.source}, confirmed=${staff.mentorConfirmed}`,
  );
  report(
    staff.notes?.includes('Prof. Rakesh Iyer (Faculty Mentor)') === true,
    'and names who entered it',
    staff.notes ?? '',
  );

  const own = standingFor({ kind: 'student' }, new Date());
  report(
    own.source === 'SELF_REPORTED' && own.mentorConfirmed === false && own.notes === null,
    "a student's own entry stays unconfirmed and unattributed",
    `${own.source}, confirmed=${own.mentorConfirmed}`,
  );

  // --- the rules on their own ---------------------------------------------

  console.log('\nRules, without a database');

  const day = (iso: string) => parseDay(iso)!;
  report(
    loggedAfterDays({ checkInAt: day('2026-06-01'), createdAt: day('2026-06-01') }) === 0 &&
      isBackdated({ checkInAt: day('2026-06-01'), createdAt: day('2026-06-01') }) === false,
    'same-day entry is not marked',
  );
  report(
    isBackdated({ checkInAt: day('2026-06-01'), createdAt: day('2026-06-03') }) === false &&
      isBackdated({ checkInAt: day('2026-06-01'), createdAt: day('2026-06-04') }) === true,
    'the mark starts after two days, not before',
  );
  report(
    loggedAfterDays({ checkInAt: day('2026-06-04'), createdAt: day('2026-06-01') }) === 0,
    'a clock going backwards clamps to zero rather than going negative',
  );
  report(
    parseDay('2026-02-31') === null && parseDay('nonsense') === null,
    'an impossible date is rejected rather than rolled forward',
  );
  report(
    parseDay('2026-08-04')?.getDate() === 4,
    'a plain date stays on its own day regardless of timezone',
    String(parseDay('2026-08-04')),
  );
  report(
    earliestLoggableDay({
      enrolledAt: day('2026-06-01'),
      cohort: { startDate: day('2026-05-01') },
    }).getTime() === day('2026-05-01').getTime(),
    'the floor is the earlier of enrolment and cohort start',
  );

  // --- clock times ---------------------------------------------------------

  console.log('\nFrom / To');

  report(parseClock('09:05') === 545, 'a clock time is minutes from midnight', '09:05 -> 545');
  report(parseClock('9:05') === 545, 'a single-digit hour is accepted');
  report(parseClock('09:05:00') === 545, 'the seconds some browsers append are dropped');
  report(parseClock('24:00') === null, 'hour 24 is refused');
  report(parseClock('09:60') === null, 'minute 60 is refused');
  report(parseClock('') === null && parseClock('half nine') === null, 'nonsense is refused');
  report(clockLabel(545) === '09:05', 'minutes render back as HH:MM');

  report(minutesBetween(540, 630) === 90, '09:00 to 10:30 is 90 minutes');
  report(minutesBetween(1320, 30) === 150, '22:00 to 00:30 crosses midnight, not backwards');
  report(minutesBetween(600, 600) === 0, 'the same time twice is zero, not a whole day');
  report(
    minutesBetween(840, 780) === 23 * 60,
    'a transposed pair comes back as 23h so the 12-hour rule refuses it',
  );

  // The point of all the above: a session lands where the student said it did.
  const timed = await log(student, {
    date: isoDay(addDays(new Date(), -3)),
    activity: 'READING',
    durationMin: 90,
    startMin: 8 * 60 + 30,
  });
  const timedStart = timed.payload.session?.checkInAt
    ? new Date(timed.payload.session.checkInAt)
    : null;
  report(
    timed.status === 201 && timedStart?.getHours() === 8 && timedStart?.getMinutes() === 30,
    'a stated start time places the session, not the mode heuristic',
    timedStart ? `${timedStart.getHours()}:${String(timedStart.getMinutes()).padStart(2, '0')}` : 'none',
  );

  const untimed = await log(student, {
    date: isoDay(addDays(new Date(), -3)),
    activity: 'READING',
    durationMin: 60,
  });
  const untimedStart = untimed.payload.session?.checkInAt
    ? new Date(untimed.payload.session.checkInAt)
    : null;
  report(
    untimed.status === 201 && untimedStart?.getHours() === 19,
    'a row without a time still falls back to the mode hour',
    untimedStart ? String(untimedStart.getHours()) : 'none',
  );

  const future = await log(student, {
    date: isoDay(new Date()),
    activity: 'READING',
    durationMin: 30,
    startMin: 23 * 60 + 30,
  });
  report(
    future.status === 400,
    'a block today that has not finished yet is refused',
    future.payload.error,
  );

  const outOfDay = await log(student, {
    date: isoDay(addDays(new Date(), -3)),
    activity: 'READING',
    durationMin: 30,
    startMin: 1440,
  });
  report(outOfDay.status === 400, 'a start time outside the day is refused');

  // --- put the demo data back ---------------------------------------------

  // Restore the recorded value rather than decrementing per row.
  //
  // Decrementing assumes every written row was credited, and it is not: a row
  // logged without an explicit course is filed against the student's most
  // recent enrolment but deliberately earns it no self-learning hours, and a
  // lecture earns none either. Subtracting for those drifts the enrolment
  // negative — which made this check fail depending on how many of the batch
  // rows happened to name a course.
  if (written.length > 0) {
    await prisma.labSession.deleteMany({ where: { id: { in: written } } });
    await prisma.enrollment.update({
      where: { id: enrolment.id },
      data: { selfLearningHoursLogged: enrolment.selfLearningHoursLogged },
    });
    console.log(`\n  (removed ${written.length} test rows and restored the enrolment)`);
  }

  const restored = await prisma.enrollment.findUnique({
    where: { id: enrolment.id },
    select: { selfLearningHoursLogged: true },
  });
  report(
    Math.abs(
      (restored?.selfLearningHoursLogged ?? 0) - enrolment.selfLearningHoursLogged,
    ) < 0.05,
    'enrolment hours are back where they started',
    `${restored?.selfLearningHoursLogged}h`,
  );

  console.log(`\n${pass}/${pass + fail} checks passed.\n`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
