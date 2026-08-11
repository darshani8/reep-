/**
 * The export surface, at all three scopes.
 *
 * `smoke.ts` proves the screens render; this proves the files are right, which
 * is a different question. An export that returns HTTP 200 and quietly carries
 * the whole programme when one student was asked for is the failure that matters
 * here, and it looks like success from the outside — so every check below is
 * about the *contents* of the download, not its status code.
 *
 * Usage: npx tsx --env-file=.env scripts/test-exports.ts [baseUrl]
 */

import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';

const prisma = new PrismaClient();
const BASE = process.argv[2] ?? 'http://localhost:3100';

/// ZIP local file header. An .xlsx is a zip archive, so this is the cheapest
/// proof that what came back is a real workbook rather than an error page.
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/// The three bytes that make Excel on Windows decode a .csv as UTF-8 instead of
/// the system codepage. Checked as bytes because decoding to text eats them.
const UTF8_BOM = [0xef, 0xbb, 0xbf];

let pass = 0;
let fail = 0;

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

async function main() {
  const director = await tokenFor('s.manjunath@bgscet.ac.in');
  const student = await tokenFor('ananya.r@bgscet.ac.in');

  const ananya = await prisma.student.findFirst({
    where: { user: { email: 'ananya.r@bgscet.ac.in' } },
    include: { cohort: true },
  });
  if (!ananya) throw new Error('Seed data missing — run npm run db:seed');

  const id = ananya.id;
  const cohortSize = await prisma.student.count({ where: { cohortId: ananya.cohortId } });
  const programmeSize = await prisma.student.count();

  // --- scope: the whole programme, one cohort, one student ----------------

  console.log('\nScope');

  const whole = await (await get('/api/export/json', director)).json();
  report(
    whole.counts.students === programmeSize,
    'no scope → every student',
    `${whole.counts.students} of ${programmeSize}`,
  );

  const cohort = await (
    await get(`/api/export/json?cohortId=${ananya.cohortId}`, director)
  ).json();
  report(
    cohort.counts.students === cohortSize && cohortSize < programmeSize,
    'cohortId → that cohort only',
    `${cohort.counts.students} of ${programmeSize}`,
  );

  const one = await (await get(`/api/export/json?studentId=${id}`, director)).json();
  report(one.counts.students === 1, 'studentId → one student', `${one.counts.students} row(s)`);
  report(
    one.scope.studentId === id && one.scope.label.includes(ananya.usn),
    'the scope block names who it is about',
    one.scope.label,
  );

  // The bug this guards against: a student scope also carries their cohort id,
  // so filtering on the wrong one widens the export to their whole section
  // while still looking scoped.
  const strayStudents = one.labSessions.filter(
    (row: { studentId: string }) => row.studentId !== id,
  );
  const strayAlerts = one.alerts.filter((row: { studentId: string }) => row.studentId !== id);
  const strayUploads = one.uploads.filter((row: { studentId: string }) => row.studentId !== id);
  report(
    strayStudents.length === 0 && strayAlerts.length === 0 && strayUploads.length === 0,
    'no other student leaks into a single-student export',
    `${strayStudents.length + strayAlerts.length + strayUploads.length} stray rows`,
  );
  report(
    one.labSessions.length > 0,
    'and it is not empty either',
    `${one.labSessions.length} sessions`,
  );

  // --- formats agree -------------------------------------------------------

  console.log('\nFormats');

  const xlsx = await get(`/api/export/xlsx?studentId=${id}`, director);
  const bytes = new Uint8Array(await xlsx.arrayBuffer());
  report(
    xlsx.status === 200 && ZIP_MAGIC.every((byte, i) => bytes[i] === byte),
    'xlsx is a real workbook',
    `${(bytes.byteLength / 1024).toFixed(0)}kb`,
  );
  report(
    xlsx.headers.get('content-disposition')?.includes(ananya.usn.toLowerCase()) === true,
    'and is named after the student',
    xlsx.headers.get('content-disposition') ?? '',
  );

  const csv = await get(`/api/export/csv?table=sessions&studentId=${id}`, director);
  // Bytes, not text: TextDecoder strips a leading BOM while decoding, so
  // `res.text()` can never see the three bytes that make Excel read UTF-8.
  const csvBytes = new Uint8Array(await csv.clone().arrayBuffer());
  const body = await csv.text();
  const lines = body.trim().split('\r\n');
  report(
    UTF8_BOM.every((byte, i) => csvBytes[i] === byte),
    'csv keeps its UTF-8 byte-order mark',
    [...csvBytes.slice(0, 3)].map((b) => b.toString(16)).join(' '),
  );
  report(
    lines.length - 1 === one.labSessions.length,
    'csv row count matches the json',
    `${lines.length - 1} vs ${one.labSessions.length}`,
  );
  report(
    lines[0].includes('Recorded at') && lines[0].includes('Backdated'),
    'sessions carry the recorded-at audit columns',
  );

  // --- refusals ------------------------------------------------------------

  console.log('\nRefusals');

  for (const [label, path] of [
    ['unknown student', `/api/export/xlsx?studentId=nope`],
    ['unknown cohort', `/api/export/json?cohortId=nope`],
    ['unknown table', `/api/export/csv?table=nope`],
  ] as const) {
    const res = await get(path, director);
    report(res.status === 400, `${label} → 400, not a silent full export`, `HTTP ${res.status}`);
  }

  for (const path of [
    `/api/export/xlsx?studentId=${id}`,
    `/api/export/json?studentId=${id}`,
    `/api/export/student/${id}`,
  ]) {
    const res = await get(path, student);
    report(
      res.status === 307 || res.status === 302,
      `a student is redirected away from ${path.split('?')[0]}`,
      `HTTP ${res.status}`,
    );
  }

  console.log(`\n${pass}/${pass + fail} checks passed.\n`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
