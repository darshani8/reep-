/**
 * End-to-end smoke test: mints a real session cookie with the app's own auth
 * code, then fetches every route and reports status + a content marker.
 *
 * Usage: npx tsx scripts/smoke.ts [baseUrl]
 */

import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';

const prisma = new PrismaClient();
const BASE = process.argv[2] ?? 'http://localhost:3100';

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

async function check(path: string, token: string, mustContain?: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { cookie: `reep_session=${token}` },
    redirect: 'manual',
  });
  const body = res.status === 200 ? await res.text() : '';
  const ok = res.status === 200;
  // Case-insensitive: the marker is here to prove the page rendered its own
  // content, not to police sentence casing.
  const hasMarker =
    !mustContain || body.toLowerCase().includes(mustContain.toLowerCase());

  const status = ok && hasMarker ? 'PASS' : 'FAIL';
  const detail = !ok
    ? `HTTP ${res.status}${res.headers.get('location') ? ` → ${res.headers.get('location')}` : ''}`
    : hasMarker
      ? `${(body.length / 1024).toFixed(0)}kb`
      : `missing "${mustContain}"`;

  console.log(`  [${status}] ${path.padEnd(46)} ${detail}`);
  return status === 'PASS';
}

async function main() {
  const studentToken = await tokenFor('ananya.r@bgscet.ac.in');
  const atRiskToken = await tokenFor('aditi.k@bgscet.ac.in');
  const mentorToken = await tokenFor('rakesh.iyer@bgscet.ac.in');
  const directorToken = await tokenFor('s.manjunath@bgscet.ac.in');

  const aditi = await prisma.student.findFirst({ where: { usn: '1BG24MBA003' } });

  const results: boolean[] = [];

  console.log('\nStudent (Ananya R.)');
  results.push(await check('/student', studentToken, 'Your REEP Journey'));
  results.push(await check('/student/certifications', studentToken, 'Certification'));
  results.push(await check('/student/time-log', studentToken, 'Time'));
  results.push(await check('/student/courses', studentToken, 'REE'));
  results.push(await check('/student/uploads', studentToken, 'Upload'));
  results.push(await check('/student/resume', studentToken, 'Resume'));
  results.push(await check('/student/profile', studentToken, 'Profile'));

  console.log('\nStudent (Aditi K. — at risk)');
  results.push(await check('/student', atRiskToken, 'Your REEP Journey'));
  results.push(await check('/student/time-log', atRiskToken, 'Time'));

  console.log('\nMentor (Prof. Rakesh Iyer)');
  results.push(await check('/mentor', mentorToken, 'Cohort'));
  results.push(await check('/mentor/alerts', mentorToken, 'Alert'));
  results.push(await check('/mentor/uploads', mentorToken, 'Verif'));
  results.push(await check('/mentor/student', mentorToken));
  results.push(await check('/mentor/reports', mentorToken, 'Report'));
  results.push(await check('/mentor/settings', mentorToken, 'Threshold'));
  if (aditi) {
    results.push(await check(`/mentor/student/${aditi.id}`, mentorToken, 'Focus'));
    results.push(
      await check(`/mentor/student/${aditi.id}?tab=certifications`, mentorToken),
    );
  }

  console.log('\nDirector (Dr. S. Manjunath)');
  results.push(await check('/director', directorToken, 'REEP Completion'));
  results.push(await check('/director/courses', directorToken, 'REE'));
  results.push(await check('/director/certifications', directorToken, 'Certification'));
  results.push(await check('/director/placement', directorToken, 'Placement'));

  console.log('\nRole guards');
  const guard = await fetch(`${BASE}/director`, {
    headers: { cookie: `reep_session=${studentToken}` },
    redirect: 'manual',
  });
  const guarded = guard.status >= 300 && guard.status < 400;
  console.log(
    `  [${guarded ? 'PASS' : 'FAIL'}] student blocked from /director${' '.repeat(16)}HTTP ${guard.status}`,
  );
  results.push(guarded);

  const anon = await fetch(`${BASE}/student`, { redirect: 'manual' });
  const anonBlocked = anon.status >= 300 && anon.status < 400;
  console.log(
    `  [${anonBlocked ? 'PASS' : 'FAIL'}] anonymous blocked from /student${' '.repeat(13)}HTTP ${anon.status}`,
  );
  results.push(anonBlocked);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed.\n`);
  if (passed < results.length) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
