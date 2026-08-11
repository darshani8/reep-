import { describe, expect, it } from 'vitest';

import { adoptDecision } from './decide';

/**
 * This is the function standing between a 12B model's improvisation and a tool
 * call, so the tests that matter most are the ones about what it *refuses*: the
 * allowlist is the whole security property, and it has to hold for a tool the
 * model invented, a tool belonging to a wider scope, and a tool name arriving as
 * something other than a string.
 */

const STUDENT_TOOLS = ['student_record', 'certifications'];
const STAFF_TOOLS = [...STUDENT_TOOLS, 'find_students'];

describe('adoptDecision — dispatching a tool', () => {
  it('calls a tool the caller listed', () => {
    const decision = adoptDecision({ tool: 'student_record', args: { usn: '1BG23MBA01' } }, STUDENT_TOOLS);

    expect(decision).toMatchObject({
      kind: 'call',
      tool: 'student_record',
      args: { usn: '1BG23MBA01' },
    });
  });

  it('carries the reasoning through with the call', () => {
    const decision = adoptDecision(
      { reasoning: '  Need the record first.  ', tool: 'student_record' },
      STUDENT_TOOLS,
    );

    expect(decision.reasoning).toBe('Need the record first.');
  });

  it('defaults args to an empty object when the model sent none', () => {
    const decision = adoptDecision({ tool: 'certifications' }, STUDENT_TOOLS);

    expect(decision).toMatchObject({ kind: 'call', args: {} });
  });

  it('replaces non-object args rather than passing them to a tool', () => {
    for (const args of ['a string', 42, null, ['an', 'array']]) {
      const decision = adoptDecision({ tool: 'certifications', args }, STUDENT_TOOLS);

      expect(decision).toMatchObject({ kind: 'call', args: {} });
    }
  });
});

describe('adoptDecision — refusing a tool', () => {
  it('does not call a tool the caller did not list, even a real one', () => {
    // A student's run naming a staff tool it was never shown.
    const decision = adoptDecision({ tool: 'find_students', answer: 'ok' }, STUDENT_TOOLS);

    expect(decision.kind).toBe('answer');
  });

  it('calls that same tool when the caller is scoped to it', () => {
    expect(adoptDecision({ tool: 'find_students' }, STAFF_TOOLS).kind).toBe('call');
  });

  it('does not call a tool the model invented', () => {
    expect(adoptDecision({ tool: 'drop_all_students' }, STAFF_TOOLS).kind).toBe('answer');
  });

  it('never dispatches when the allowlist is empty', () => {
    expect(adoptDecision({ tool: 'student_record' }, []).kind).toBe('answer');
  });

  it('does not match a tool name by prefix or case', () => {
    expect(adoptDecision({ tool: 'student_record_all' }, STUDENT_TOOLS).kind).toBe('answer');
    expect(adoptDecision({ tool: 'STUDENT_RECORD' }, STUDENT_TOOLS).kind).toBe('answer');
  });

  it('ignores a tool name that is not a string', () => {
    for (const tool of [42, null, {}, ['student_record']]) {
      expect(adoptDecision({ tool }, STUDENT_TOOLS).kind).toBe('answer');
    }
  });

  it('trims a tool name before matching, so trailing whitespace still dispatches', () => {
    expect(adoptDecision({ tool: ' student_record ' }, STUDENT_TOOLS).kind).toBe('call');
  });
});

describe('adoptDecision — answering', () => {
  it('takes the answer field when there is one', () => {
    const decision = adoptDecision({ answer: 'You are on track.' }, STUDENT_TOOLS);

    expect(decision).toMatchObject({ kind: 'answer', answer: 'You are on track.' });
  });

  it('falls back to reasoning when the model put its reply there', () => {
    // Unparseable is not fatal: a model that answered in the wrong field has,
    // in practice, answered.
    const decision = adoptDecision({ reasoning: 'You are on track.' }, STUDENT_TOOLS);

    expect(decision).toMatchObject({ kind: 'answer', answer: 'You are on track.' });
  });

  it('prefers the answer field over reasoning when both are present', () => {
    const decision = adoptDecision(
      { answer: 'The answer.', reasoning: 'The thinking.' },
      STUDENT_TOOLS,
    );

    expect(decision).toMatchObject({ answer: 'The answer.', reasoning: 'The thinking.' });
  });

  it('produces a usable message rather than an empty one when the model said nothing', () => {
    const decision = adoptDecision({}, STUDENT_TOOLS);

    expect(decision.kind).toBe('answer');
    expect(decision).toMatchObject({ answer: expect.stringContaining('rephrasing') });
  });

  it('treats whitespace-only text as nothing', () => {
    const decision = adoptDecision({ answer: '   ', reasoning: '\n' }, STUDENT_TOOLS);

    expect(decision).toMatchObject({ answer: expect.stringContaining('rephrasing') });
  });
});

describe('adoptDecision — citations', () => {
  it('normalises a list of citation strings', () => {
    const decision = adoptDecision({ answer: 'ok', citations: ['a', ' b '] }, STUDENT_TOOLS);

    expect(decision).toMatchObject({ citations: ['a', 'b'] });
  });

  it('drops non-string and empty entries rather than passing them on', () => {
    const decision = adoptDecision(
      { answer: 'ok', citations: ['a', 42, null, '', '  ', { id: 'x' }] },
      STUDENT_TOOLS,
    );

    expect(decision).toMatchObject({ citations: ['a'] });
  });

  it('is an empty list when citations are absent or not an array', () => {
    for (const citations of [undefined, null, 'a,b', 7, {}]) {
      const decision = adoptDecision({ answer: 'ok', citations }, STUDENT_TOOLS);

      expect(decision).toMatchObject({ citations: [] });
    }
  });
});

describe('adoptDecision — hostile and malformed input', () => {
  it('never throws, whatever it is handed', () => {
    for (const raw of [null, undefined, 42, 'a string', [], [{ tool: 'student_record' }], true]) {
      expect(() => adoptDecision(raw, STAFF_TOOLS)).not.toThrow();
    }
  });

  it('treats a top-level array as an empty decision rather than reading index 0', () => {
    const decision = adoptDecision([{ tool: 'student_record' }], STAFF_TOOLS);

    expect(decision.kind).toBe('answer');
  });

  it('always returns one of the two kinds', () => {
    for (const raw of [null, 42, {}, { tool: 'student_record' }, { answer: 'x' }]) {
      expect(['call', 'answer']).toContain(adoptDecision(raw, STAFF_TOOLS).kind);
    }
  });
});
