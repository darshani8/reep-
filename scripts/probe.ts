/**
 * Fetch one route with a real session and print whatever error the server
 * rendered. Faster than digging through dev.log when a page 500s.
 *
 * Usage: npx tsx --env-file=.env scripts/probe.ts /student [email]
 */

import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';

const prisma = new PrismaClient();

const route = process.argv[2] ?? '/student';
const email = process.argv[3] ?? 'ananya.r@bgscet.ac.in';

async function main() {
  const user = await prisma.user.findUnique({
    where: { email },
    include: { student: true, mentor: true },
  });
  if (!user) throw new Error(`No user ${email}`);

  const token = await new SignJWT({
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
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET));

  const res = await fetch(`http://localhost:3100${route}`, {
    headers: { cookie: `reep_session=${token}` },
    redirect: 'manual',
  });

  console.log(`${route} → HTTP ${res.status}`);
  const body = await res.text();

  if (res.status === 200) {
    console.log(`OK, ${(body.length / 1024).toFixed(0)}kb`);
    // Optional third arg: print the surrounding text of the first match, which
    // is handy for asserting a page actually rendered the value you expect.
    const needle = process.argv[4];
    if (needle) {
      const at = body.indexOf(needle);
      console.log(at === -1 ? `"${needle}" not found` : body.slice(at, at + 240));
    }
    return;
  }

  // Next renders the message into the error overlay payload; pull the first
  // few distinct-looking error strings out rather than dumping the whole page.
  const seen = new Set<string>();
  for (const match of body.matchAll(/"message":"((?:[^"\\]|\\.){10,400})"/g)) {
    const text = match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    if (!seen.has(text)) {
      seen.add(text);
      console.log('\n---\n' + text);
    }
    if (seen.size >= 3) break;
  }
  if (seen.size === 0) console.log(body.slice(0, 1200));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
