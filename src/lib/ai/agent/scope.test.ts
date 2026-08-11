import { beforeAll, describe, expect, it } from 'vitest';

import type { SessionPayload } from '@/lib/auth';
import { mentorScope } from '@/lib/mentor-scope';

/**
 * The rule these tests exist for: the assistant and the dashboard must give the
 * same answer to "which students may this person read?".
 *
 * They did not. `scope.ts` kept its own role table with `MENTOR: 'programme'`,
 * so every mentor's chat box could read the whole roster — including a MENTOR
 * account with no `Mentor` row, which `mentor-scope.ts` maps to `{ kind: 'none' }`
 * precisely because `authenticate()` mints that token for any user with role
 * MENTOR and no mentor record. The narrow rule was the one that did not decide
 * what left the database, which made it decorative.
 *
 * So the last describe block is the important one: it asserts the two modules
 * agree for every session shape, and it fails the moment someone reintroduces a
 * role table here.
 *
 * `scope.ts` is imported dynamically because it pulls in `@/lib/db`, which
 * constructs a PrismaClient at module load and wants a DATABASE_URL to exist.
 * Nothing under test here talks to the database — `resolveScope` and
 * `visibleStudentWhere` are pure — but the import graph still has to resolve.
 * `test/confirmed-defects.test.ts` reaches `@/lib/rules` the same way.
 */

process.env.DATABASE_URL ??= 'postgresql://unit:test@127.0.0.1:5432/unit_test';

type ScopeModule = typeof import('./scope');
let scopeModule: ScopeModule;

beforeAll(async () => {
  scopeModule = await import('./scope');
});

function session(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    userId: 'usr_1',
    email: 'staff@bgscet.ac.in',
    name: 'Prof. Rakesh Iyer',
    role: 'MENTOR',
    ...overrides,
  };
}

/// Every session shape the product can actually mint, so the agreement test
/// below and the eyeball tests above cover the same ground.
const SESSIONS: SessionPayload[] = [
  session({ mentorId: 'mnt_1' }),
  session({ mentorId: undefined }),
  session({ mentorId: '' }),
  session({ role: 'DIRECTOR' }),
  session({ role: 'ADMIN' }),
  session({ role: 'DIRECTOR', mentorId: 'mnt_1' }),
  session({ role: 'STUDENT', studentId: 'stu_1' }),
  session({ role: 'STUDENT', studentId: undefined }),
];

describe('resolveScope', () => {
  it('confines a mentor with a mentor group to their own mentees', async () => {
    const scope = await scopeModule.resolveScope(session({ mentorId: 'mnt_1' }));

    expect(scope).toMatchObject({ kind: 'mentees', mentorId: 'mnt_1', selfStudentId: null });
  });

  it('REFUSES a mentor whose token carries no mentor group', async () => {
    // The defect. This session used to get `programme` — the widest scope in
    // the product — while their own /mentor screens showed them nothing.
    expect(await scopeModule.resolveScope(session({ mentorId: undefined }))).toBeNull();
    expect(await scopeModule.resolveScope(session({ mentorId: '' }))).toBeNull();
  });

  it('never resolves a MENTOR to programme, whatever else the token carries', async () => {
    for (const broken of [
      session({ mentorId: undefined }),
      session({ mentorId: 'mnt_1' }),
      session({ mentorId: 'mnt_1', studentId: 'stu_1' }),
    ]) {
      expect((await scopeModule.resolveScope(broken))?.kind).not.toBe('programme');
    }
  });

  it('leaves a director on the whole programme', async () => {
    const scope = await scopeModule.resolveScope(session({ role: 'DIRECTOR' }));

    expect(scope).toMatchObject({ kind: 'programme', mentorId: null, selfStudentId: null });
  });

  it('leaves an admin on the whole programme', async () => {
    const scope = await scopeModule.resolveScope(session({ role: 'ADMIN' }));

    expect(scope).toMatchObject({ kind: 'programme', mentorId: null });
  });

  it('gives a director the programme even when they somehow carry a mentorId', async () => {
    // The role decides, not the shape of the token — same as mentorScope.
    const scope = await scopeModule.resolveScope(session({ role: 'DIRECTOR', mentorId: 'mnt_1' }));

    expect(scope).toMatchObject({ kind: 'programme', mentorId: null });
  });

  it('gives a student their own record and nothing else', async () => {
    const scope = await scopeModule.resolveScope(session({ role: 'STUDENT', studentId: 'stu_1' }));

    expect(scope).toMatchObject({ kind: 'self', selfStudentId: 'stu_1', mentorId: null });
  });

  it('refuses a student session with no student record', async () => {
    expect(await scopeModule.resolveScope(session({ role: 'STUDENT' }))).toBeNull();
  });

  it('refuses a role that is in the schema but in nobody’s table', async () => {
    // A Role added to the enum and not to mentor-scope.ts must not arrive at
    // programme scope by default.
    expect(await scopeModule.resolveScope(session({ role: 'GUEST' as SessionPayload['role'] })))
      .toBeNull();
  });

  it('carries the session through as the actor, so the prompt names who asked', async () => {
    const asker = session({ mentorId: 'mnt_1' });

    expect((await scopeModule.resolveScope(asker))?.actor).toBe(asker);
  });

  it('describes its own reach honestly in the label', async () => {
    const mentor = await scopeModule.resolveScope(session({ mentorId: 'mnt_1' }));
    const director = await scopeModule.resolveScope(session({ role: 'DIRECTOR' }));

    // The label is shown to the reader and put in the prompt. A mentor's must
    // not claim the programme.
    expect(mentor?.label).toContain('assigned to you');
    expect(mentor?.label).not.toContain('every student');
    expect(director?.label).toContain('every student');
  });
});

describe('visibleStudentWhere', () => {
  it('filters to the mentor group for a mentor', async () => {
    const scope = (await scopeModule.resolveScope(session({ mentorId: 'mnt_1' })))!;

    expect(scopeModule.visibleStudentWhere(scope)).toEqual({ mentorId: 'mnt_1' });
  });

  it('is an unfiltered clause only for programme scope', async () => {
    for (const role of ['DIRECTOR', 'ADMIN'] as const) {
      const scope = (await scopeModule.resolveScope(session({ role })))!;

      expect(scopeModule.visibleStudentWhere(scope)).toEqual({});
    }
  });

  it('is a single-id clause for a student', async () => {
    const scope = (await scopeModule.resolveScope(session({ role: 'STUDENT', studentId: 'stu_1' })))!;

    expect(scopeModule.visibleStudentWhere(scope)).toEqual({ id: 'stu_1' });
  });

  it('never returns an empty clause for a scope that is not programme-wide', async () => {
    // An empty object means "every student". A `mentees` scope that lost its
    // mentorId — however it got that way — must not become the director query.
    const broken = {
      kind: 'mentees' as const,
      actor: session(),
      selfStudentId: null,
      mentorId: null,
      label: 'the students assigned to you as their mentor',
    };

    expect(scopeModule.visibleStudentWhere(broken)).toEqual({ id: '__none__' });
  });

  it('never filters on a null mentorId, which would match the unassigned students', async () => {
    // `{ mentorId: null }` is not "no filter" — it is every student with no
    // mentor, a real and entirely wrong set of rows.
    const where = scopeModule.visibleStudentWhere({
      kind: 'mentees' as const,
      actor: session(),
      selfStudentId: null,
      mentorId: null,
      label: '',
    });

    expect(where).not.toHaveProperty('mentorId');
  });
});

describe('resolveScope agrees with mentorScope', () => {
  it('gives staff exactly the students mentorScope gives them, for every session shape', async () => {
    for (const s of SESSIONS) {
      if (s.role === 'STUDENT') continue;

      const staff = mentorScope(s);
      const agent = await scopeModule.resolveScope(s);

      if (staff.kind === 'none') {
        // The refusing case: no scope object at all, so no run, no prompt and
        // no tools.
        expect(agent).toBeNull();
        continue;
      }

      expect(agent?.kind).toBe(staff.kind);
      expect(scopeModule.visibleStudentWhere(agent!)).toEqual(
        staff.kind === 'mentees' ? { mentorId: staff.mentorId } : {},
      );
    }
  });
});
