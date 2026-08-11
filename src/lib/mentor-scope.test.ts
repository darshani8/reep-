import { describe, expect, it } from 'vitest';

import type { SessionPayload } from './auth';
import { canSeeStudent, menteeWhere, mentorScope } from './mentor-scope';

/**
 * The rule these tests exist for: a MENTOR session carrying no `mentorId` must
 * resolve to NOBODY, not to the whole programme.
 *
 * That is not hypothetical. `authenticate()` builds the payload with
 * `mentorId: user.mentor?.id`, so any user with role MENTOR and no `Mentor`
 * row — a newly created account, a mentor whose record was removed — gets a
 * valid signed token with the field absent. The four staff screens used to
 * branch on that field's presence, which put exactly those accounts on the
 * director path.
 */

function session(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    userId: 'usr_1',
    email: 'staff@bgscet.ac.in',
    name: 'Prof. Rakesh Iyer',
    role: 'MENTOR',
    ...overrides,
  };
}

describe('mentorScope', () => {
  it('scopes a mentor with a mentor group to their own mentees', () => {
    expect(mentorScope(session({ mentorId: 'mnt_1' }))).toEqual({
      kind: 'mentees',
      mentorId: 'mnt_1',
    });
  });

  it('gives a director the whole programme', () => {
    expect(mentorScope(session({ role: 'DIRECTOR' }))).toEqual({ kind: 'programme' });
  });

  it('gives an admin the whole programme', () => {
    expect(mentorScope(session({ role: 'ADMIN' }))).toEqual({ kind: 'programme' });
  });

  it('gives a director the whole programme even when they somehow carry a mentorId', () => {
    // The role decides, not the shape of the token.
    expect(mentorScope(session({ role: 'DIRECTOR', mentorId: 'mnt_1' }))).toEqual({
      kind: 'programme',
    });
  });

  it('FAILS CLOSED for a mentor whose token carries no mentor group', () => {
    // The defect this module was written for. Before the fix this session read
    // every alert, every upload and every cohort in the programme.
    expect(mentorScope(session({ mentorId: undefined }))).toEqual({ kind: 'none' });
  });

  it('fails closed for a mentor whose mentorId is an empty string', () => {
    expect(mentorScope(session({ mentorId: '' }))).toEqual({ kind: 'none' });
  });

  it('fails closed for a student who reaches a staff screen', () => {
    expect(mentorScope(session({ role: 'STUDENT', studentId: 'stu_1' }))).toEqual({
      kind: 'none',
    });
  });

  it('fails closed for a role that is not in the map at all', () => {
    // A Role enum value added to the schema and not to this module must not
    // arrive at programme scope by default.
    expect(mentorScope(session({ role: 'GUEST' as SessionPayload['role'] }))).toEqual({
      kind: 'none',
    });
  });
});

describe('menteeWhere', () => {
  it('is an unfiltered clause only for programme-wide roles', () => {
    expect(menteeWhere(session({ role: 'DIRECTOR' }))).toEqual({});
    expect(menteeWhere(session({ role: 'ADMIN' }))).toEqual({});
  });

  it('filters to the mentor group for a real mentor', () => {
    expect(menteeWhere(session({ mentorId: 'mnt_1' }))).toEqual({ mentorId: 'mnt_1' });
  });

  it('never returns an empty clause for a closed scope', () => {
    // An empty object here would mean "every student" — the exact bug. The
    // closed case must be a filter that cannot match, not the absence of one.
    for (const broken of [
      session({ mentorId: undefined }),
      session({ role: 'STUDENT', studentId: 'stu_1' }),
    ]) {
      const where = menteeWhere(broken);

      expect(where).not.toEqual({});
      expect(Object.keys(where).length).toBeGreaterThan(0);
      expect(where).toEqual({ id: '__none__' });
    }
  });

  it('never returns an empty clause for a MENTOR, whatever the token carries', () => {
    // The role, not the field, is what makes `{}` safe. No token that says
    // MENTOR may produce the clause that means "every student".
    for (const mentorId of [undefined, '']) {
      expect(menteeWhere(session({ role: 'MENTOR', mentorId }))).not.toEqual({});
    }
    expect(menteeWhere(session({ role: 'MENTOR', mentorId: 'mnt_1' }))).toEqual({
      mentorId: 'mnt_1',
    });
  });

  it('agrees with mentorScope for every session shape', () => {
    const cases: SessionPayload[] = [
      session({ role: 'DIRECTOR' }),
      session({ role: 'ADMIN' }),
      session({ mentorId: 'mnt_1' }),
      session({ mentorId: undefined }),
      session({ role: 'STUDENT', studentId: 'stu_1' }),
    ];

    for (const s of cases) {
      const scope = mentorScope(s);
      const where = menteeWhere(s);

      if (scope.kind === 'programme') expect(where).toEqual({});
      else if (scope.kind === 'mentees') expect(where).toEqual({ mentorId: scope.mentorId });
      else expect(where).toEqual({ id: '__none__' });
    }
  });
});

describe('canSeeStudent', () => {
  it('lets a mentor reach their own mentee', () => {
    expect(canSeeStudent(session({ mentorId: 'mnt_1' }), 'mnt_1')).toBe(true);
  });

  it("does not let a mentor reach another mentor's student", () => {
    expect(canSeeStudent(session({ mentorId: 'mnt_1' }), 'mnt_2')).toBe(false);
  });

  it('does not let a mentor reach a student with no mentor at all', () => {
    // An unassigned student is in nobody's group, so nobody but programme staff
    // reaches them. `null !== 'mnt_1'` is the whole rule and it is the right one.
    expect(canSeeStudent(session({ mentorId: 'mnt_1' }), null)).toBe(false);
  });

  it('lets a director and an admin reach any student, assigned or not', () => {
    for (const role of ['DIRECTOR', 'ADMIN'] as const) {
      expect(canSeeStudent(session({ role }), 'mnt_1')).toBe(true);
      expect(canSeeStudent(session({ role }), null)).toBe(true);
    }
  });

  it('FAILS CLOSED for a mentor whose token carries no mentor group', () => {
    // The shipped defect in its most direct form. The guard this replaced was
    //   if (session.mentorId && student.mentorId !== session.mentorId) notFound()
    // and for this session the `&&` short-circuited, so it read *and wrote to*
    // every student in the programme.
    for (const studentMentorId of ['mnt_1', 'mnt_2', null]) {
      expect(canSeeStudent(session({ mentorId: undefined }), studentMentorId)).toBe(false);
      expect(canSeeStudent(session({ mentorId: '' }), studentMentorId)).toBe(false);
    }
  });

  it('fails closed for a student who reaches a staff screen', () => {
    expect(canSeeStudent(session({ role: 'STUDENT', studentId: 'stu_1' }), 'mnt_1')).toBe(
      false,
    );
  });
});
