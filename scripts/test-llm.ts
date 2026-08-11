/**
 * Does the configured model actually write a usable resume?
 *
 * `smoke.ts` proves the screens render and `test-exports.ts` proves the files
 * are right; neither exercises the one part of this product where a machine
 * writes prose that goes on a student's job application. That path has failure
 * modes the others don't: a model that ignores the JSON schema, one that pads
 * its reply with markdown fences, one whose context window silently swallows
 * half the evidence pack — and, the one that actually matters, a model that
 * writes a confident sentence about a certification the student never earned.
 *
 * So this checks three things in order: that the server answers at all, that
 * the reply survives parsing, and that every claim in it cites a real record.
 *
 * Usage: npx tsx --env-file=.env scripts/test-llm.ts [baseUrl]
 */

import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';

import { estimateTokens, extractJson } from '@/lib/ai/llm-parse';

const prisma = new PrismaClient();
const BASE = process.argv[2] ?? 'http://localhost:3100';

let pass = 0;
let fail = 0;

function report(ok: boolean, label: string, detail = '') {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label.padEnd(54)} ${detail}`);
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
    .setExpirationTime('2h')
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
}

async function main() {
  const baseUrl = process.env.LLM_BASE_URL?.replace(/\/+$/, '');
  const model = process.env.LLM_MODEL;

  // --- the parser, without a model -----------------------------------------
  // These are the shapes small models actually emit. They cost nothing to check
  // and they are the difference between a working integration and a mysterious
  // "no JSON found" in production.

  console.log('\nParsing what models actually send back');

  report(
    (extractJson('{"a":1}') as { a: number })?.a === 1,
    'a bare object',
  );
  report(
    (extractJson('```json\n{"a":1}\n```') as { a: number })?.a === 1,
    'fenced in markdown',
  );
  report(
    (extractJson('Here is the resume:\n\n{"a":1}\n\nHope that helps!') as { a: number })?.a === 1,
    'wrapped in chatty prose',
  );
  report(
    (extractJson('<think>Let me plan.</think>{"a":1}') as { a: number })?.a === 1,
    'after a reasoning block',
  );
  report(
    (extractJson('{"text":"a } brace and a \\" quote","a":1}') as { a: number })?.a === 1,
    'containing braces and quotes inside strings',
  );
  report(extractJson('{"a":1') === undefined, 'truncated object rejected, not half-parsed');
  report(extractJson('no json at all') === undefined, 'prose-only reply rejected');
  report(estimateTokens('x'.repeat(3400)) === 1000, 'token estimate is in the right order');

  if (!baseUrl || !model) {
    console.log('\nLLM_BASE_URL / LLM_MODEL not set — skipping the live model checks.');
    console.log(`\n${pass}/${pass + fail} checks passed.\n`);
    await prisma.$disconnect();
    process.exit(fail > 0 ? 1 : 0);
  }

  // --- the server ----------------------------------------------------------

  console.log(`\nModel server (${model} at ${baseUrl})`);

  const started = Date.now();
  const ping = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.LLM_API_KEY ? { authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      stream: false,
    }),
  }).catch((e) => e as Error);

  if (ping instanceof Error) {
    report(false, 'server reachable', ping.message);
    console.log(`\n${pass}/${pass + fail} checks passed.\n`);
    await prisma.$disconnect();
    process.exit(1);
  }

  const pingBody = (await ping.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  report(
    ping.ok && Boolean(pingBody.choices?.[0]?.message?.content),
    'server reachable and answering',
    `HTTP ${ping.status} in ${Date.now() - started}ms`,
  );

  // --- the real thing ------------------------------------------------------

  console.log('\nWriting a real resume');

  const studentToken = await tokenFor('ananya.r@bgscet.ac.in');
  const genStarted = Date.now();
  const res = await fetch(`${BASE}/api/resume/generate`, {
    method: 'POST',
    headers: { cookie: `reep_session=${studentToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      targetRole: 'Business Analyst',
      targetIndustry: 'Management Consulting',
      jobDescription:
        'MBA graduate with data analysis, Excel modelling and stakeholder communication skills.',
    }),
  });
  const elapsed = Date.now() - genStarted;
  const payload = (await res.json()) as {
    id?: string;
    generatedBy?: string;
    model?: string;
    error?: string;
  };

  report(
    res.status === 201,
    'POST /api/resume/generate',
    `HTTP ${res.status} in ${(elapsed / 1000).toFixed(1)}s${payload.error ? ` — ${payload.error}` : ''}`,
  );

  report(
    payload.generatedBy === 'local',
    'the local model wrote it, not the fallback',
    `generatedBy=${payload.generatedBy} model=${payload.model}`,
  );

  if (!payload.id) {
    console.log(`\n${pass}/${pass + fail} checks passed.\n`);
    await prisma.$disconnect();
    process.exit(1);
  }

  const stored = await prisma.resume.findUnique({ where: { id: payload.id } });
  const content = stored?.content as Record<string, unknown> | null;
  const evidence = stored?.evidence as {
    records?: { id: string }[];
    claims?: { evidenceIds?: string[] }[];
  } | null;

  report(
    typeof content?.summary === 'string' && (content.summary as string).length > 80,
    'it wrote a real summary',
    `${(content?.summary as string | undefined)?.length ?? 0} chars`,
  );
  report(
    (stored?.markdown.length ?? 0) > 600,
    'markdown rendered',
    `${stored?.markdown.length ?? 0} chars`,
  );

  // The claim that matters. Every id cited anywhere in the resume must name a
  // record in the pack — `adoptModelOutput` drops the rest, so a violation here
  // means the trust boundary itself has broken.
  const known = new Set((evidence?.records ?? []).map((r) => r.id));
  const cited = (evidence?.claims ?? []).flatMap((c) => c.evidenceIds ?? []);
  const unbacked = cited.filter((id) => !known.has(id));

  report(
    cited.length > 0,
    'claims are cited at all',
    `${cited.length} citations across ${evidence?.claims?.length ?? 0} claims`,
  );
  report(
    unbacked.length === 0,
    'every citation names a real record',
    unbacked.length > 0 ? `unbacked: ${unbacked.slice(0, 4).join(', ')}` : `${known.size} records in pack`,
  );

  // A hallucinated employer is the headline risk, and the seeded student has no
  // work history at all — so any experience row here was invented.
  const experience = Array.isArray(content?.experience) ? content.experience : [];
  const profile = await prisma.studentProfile.findUnique({
    where: { studentId: stored!.studentId },
  });
  const declaredJobs = Array.isArray(profile?.experience) ? profile.experience.length : 0;
  report(
    experience.length <= declaredJobs,
    'no employer was invented',
    `${experience.length} experience rows vs ${declaredJobs} the student declared`,
  );

  // Resume convention, and a habit small models fall into unprompted.
  const summary = String(content?.summary ?? '');
  const firstPerson = /\b(I|I'm|I've|my|me)\b/i.test(summary);
  report(!firstPerson, 'summary avoids first-person pronouns', firstPerson ? summary.slice(0, 70) : '');

  console.log('\n--- first 24 lines of what it wrote ---\n');
  console.log((stored?.markdown ?? '').split('\n').slice(0, 24).join('\n'));

  console.log(`\n${pass}/${pass + fail} checks passed.\n`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
