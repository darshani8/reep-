/**
 * End-to-end test of the upload feature, including who is allowed to see what.
 *
 * Access control is the part worth testing: one student's ID scan must never be
 * readable by another student, and a mentor must only reach their own mentees'
 * files. This exercises each of those paths against the running server and
 * cleans up after itself.
 *
 * Usage: npx tsx --env-file=.env scripts/test-uploads.ts
 */

import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';

const prisma = new PrismaClient();
const BASE = 'http://localhost:3100';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function tokenFor(email: string) {
  const user = await prisma.user.findUnique({
    where: { email },
    include: { student: true, mentor: true },
  });
  if (!user) throw new Error(`No user ${email}`);
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
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
}

/// Smallest thing that is genuinely a PDF, so the mime check is real.
function fakePdf(): Blob {
  const body = '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
  return new Blob([body], { type: 'application/pdf' });
}

async function main() {
  const [ananya, rohan, mentorB, mentorOther, director] = await Promise.all([
    tokenFor('ananya.r@bgscet.ac.in'),
    tokenFor('rohan.m@bgscet.ac.in'),
    tokenFor('rakesh.iyer@bgscet.ac.in'),
    tokenFor('vivek.kulkarni@bgscet.ac.in'), // mentors the senior cohort, not Ananya
    tokenFor('s.manjunath@bgscet.ac.in'),
  ]);

  const ananyaStudent = await prisma.student.findFirst({
    where: { usn: '1BG24MBA001' },
    include: { certProgress: { include: { cert: true }, take: 1 } },
  });
  if (!ananyaStudent) throw new Error('Seed data missing — run npm run db:seed');
  const certCode = ananyaStudent.certProgress[0]?.certCode;

  console.log('\nUpload');

  const form = new FormData();
  form.set('file', fakePdf(), 'leadership-certificate.pdf');
  form.set('kind', 'CERTIFICATE_PROOF');
  form.set('title', 'Leadership Skills certificate');
  if (certCode) form.set('certCode', certCode);

  const created = await fetch(`${BASE}/api/uploads`, {
    method: 'POST',
    headers: { cookie: `reep_session=${ananya}` },
    body: form,
  });
  const payload = (await created.json()) as { upload?: { id: string; status: string } };
  check('student can upload a certificate', created.status === 201, `HTTP ${created.status}`);

  const uploadId = payload.upload?.id;
  if (!uploadId) {
    console.log('\nNo upload id returned — stopping.');
    process.exitCode = 1;
    return;
  }
  check('upload starts awaiting review', payload.upload?.status === 'PENDING_REVIEW');

  console.log('\nRejected uploads');

  const tooBig = new FormData();
  tooBig.set('file', new Blob([new Uint8Array(11 * 1024 * 1024)], { type: 'application/pdf' }), 'big.pdf');
  tooBig.set('kind', 'CERTIFICATE_PROOF');
  const bigRes = await fetch(`${BASE}/api/uploads`, {
    method: 'POST',
    headers: { cookie: `reep_session=${ananya}` },
    body: tooBig,
  });
  check('oversized file is refused', bigRes.status === 400, `HTTP ${bigRes.status}`);

  const wrongType = new FormData();
  wrongType.set('file', new Blob(['#!/bin/sh\n'], { type: 'application/x-sh' }), 'run.sh');
  wrongType.set('kind', 'RESUME');
  const typeRes = await fetch(`${BASE}/api/uploads`, {
    method: 'POST',
    headers: { cookie: `reep_session=${ananya}` },
    body: wrongType,
  });
  check('disallowed file type is refused', typeRes.status === 400, `HTTP ${typeRes.status}`);

  const anonRes = await fetch(`${BASE}/api/uploads`, { method: 'POST', body: new FormData() });
  check('anonymous upload is refused', anonRes.status === 401, `HTTP ${anonRes.status}`);

  console.log('\nWho can read the file');

  const read = async (label: string, token: string | null, expect: number) => {
    const res = await fetch(`${BASE}/api/uploads/${uploadId}`, {
      headers: token ? { cookie: `reep_session=${token}` } : {},
      redirect: 'manual',
    });
    check(`${label} → ${expect}`, res.status === expect, `got HTTP ${res.status}`);
  };

  await read('owner reads own file', ananya, 200);
  await read('another student is blocked', rohan, 403);
  await read('their own mentor reads it', mentorB, 200);
  await read('a different mentor is blocked', mentorOther, 403);
  await read('the director reads it', director, 200);
  await read('anonymous is blocked', null, 401);

  console.log('\nMentor verification');

  const wrongMentor = await fetch(`${BASE}/api/uploads/${uploadId}/review`, {
    method: 'POST',
    headers: { cookie: `reep_session=${mentorOther}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'VERIFIED' }),
  });
  check('a different mentor cannot verify', wrongMentor.status === 403, `HTTP ${wrongMentor.status}`);

  const studentSelfVerify = await fetch(`${BASE}/api/uploads/${uploadId}/review`, {
    method: 'POST',
    headers: { cookie: `reep_session=${ananya}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'VERIFIED' }),
  });
  check('a student cannot verify their own proof', studentSelfVerify.status === 403, `HTTP ${studentSelfVerify.status}`);

  const before = certCode
    ? await prisma.certificationProgress.findFirst({
        where: { studentId: ananyaStudent.id, certCode },
        select: { selfReported: true },
      })
    : null;

  const verify = await fetch(`${BASE}/api/uploads/${uploadId}/review`, {
    method: 'POST',
    headers: { cookie: `reep_session=${mentorB}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'VERIFIED', note: 'Checked against Coursera record.' }),
  });
  check('their mentor can verify', verify.status === 200, `HTTP ${verify.status}`);

  if (certCode) {
    const after = await prisma.certificationProgress.findFirst({
      where: { studentId: ananyaStudent.id, certCode },
      select: { selfReported: true },
    });
    check('verifying flips the cert off self-reported', after?.selfReported === false);
    // Put the seeded value back so the demo data stays as generated.
    if (before) {
      await prisma.certificationProgress.updateMany({
        where: { studentId: ananyaStudent.id, certCode },
        data: { selfReported: before.selfReported },
      });
    }
  }

  console.log('\nDelete');

  const wrongDelete = await fetch(`${BASE}/api/uploads/${uploadId}`, {
    method: 'DELETE',
    headers: { cookie: `reep_session=${rohan}` },
  });
  check('another student cannot delete it', wrongDelete.status === 403, `HTTP ${wrongDelete.status}`);

  const del = await fetch(`${BASE}/api/uploads/${uploadId}`, {
    method: 'DELETE',
    headers: { cookie: `reep_session=${ananya}` },
  });
  check('owner can delete it', del.status === 200, `HTTP ${del.status}`);

  const gone = await prisma.upload.findUnique({ where: { id: uploadId } });
  check('row is removed from the database', gone === null);

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
