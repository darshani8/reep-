import { beforeEach, describe, expect, it } from 'vitest';

import type { AgentScope } from './scope';

/**
 * The agent reads a student's own REEP records to answer, so it must pass the
 * same egress gate the resume writer does. Before this test the loop checked
 * only that a model was *configured*, not *where it runs* — so pointing
 * LLM_BASE_URL at a hosted endpoint (Gemini, Groq) would POST a student's marks
 * and attendance to a third party with no flag set, the same leak Phase 0 closed
 * on the resume path. This asserts the loop refuses that.
 */

const SELF_SCOPE: AgentScope = {
  kind: 'self',
  actor: { userId: 'u1', email: 'a@bgscet.ac.in', name: 'A', role: 'STUDENT', studentId: 's1' },
  selfStudentId: 's1',
  mentorId: null,
  label: 'your own record',
};

describe('agent egress gate', () => {
  beforeEach(() => {
    process.env.DATABASE_URL ??= 'postgresql://unit:test@127.0.0.1:5432/unit_test';
    delete process.env.LLM_ALLOW_REMOTE_STUDENT_DATA;
  });

  it('refuses a remote model for a student-data question unless explicitly allowed', async () => {
    process.env.LLM_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
    process.env.LLM_MODEL = 'gemini-2.5-flash';

    const { runAgent } = await import('./loop');
    const outcome = await runAgent({ question: 'What is my attendance?', scope: SELF_SCOPE, history: [] });

    // Refused before any tool or model call — no record left the machine.
    expect(outcome.status).toBe('REFUSED');
    expect(outcome.answer).toContain('LLM_ALLOW_REMOTE_STUDENT_DATA');
    expect(outcome.steps).toEqual([]);
    expect(outcome.model).toBeNull();
  });

  // The positive path — a loopback model is always allowed — is covered by
  // egress.test.ts on studentDataEgressAllowed(); re-driving it through the full
  // loop would need a live model server, so it is not repeated here.
});
