import { TestBed } from '@angular/core/testing';

import { InterviewQuestionsComponent } from './interview-questions.component';

/**
 * The track tabs and the questions under the picked one: the screen lands on
 * the first track the server names, and picking another reads that track's
 * questions and nothing else.
 */
function track(key: string, label: string, count: number) {
  return {
    key,
    label,
    phases: ['opening', 'probing', 'deep_dive', 'wrap_up'],
    count,
    enabled_count: count,
    id: `t-${key}`,
    code: key,
    persona: `a ${label} interviewer`,
    frameworks: ['STAR'],
    sample_question: 'Tell me about a time you led a team through a change.',
    nova_voice: '',
    syllabus: [],
    enabled: true,
    position: 0,
    college_id: null,
    course_id: null,
    specialization_id: null,
    source: 'table',
    editable: true,
  };
}

function question(id: string, trackKey: string, text: string) {
  return {
    id,
    track: trackKey,
    phase: 'probing',
    text,
    position: 0,
    enabled: true,
    created_at: '2026-09-01T00:00:00Z',
  };
}

function scriptedFetch(calls: string[]): typeof fetch {
  const reply = (status: number, body: unknown) =>
    ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/api') + 4);
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/admin/interview-questions/tracks') {
      return reply(200, [track('hr', 'Human Resources', 2), track('fa', 'Financial Analytics', 1)]);
    }
    if (path === '/admin/interview-questions?track=hr') {
      return reply(200, [
        question('q1', 'hr', 'Describe a conflict you resolved at work.'),
        question('q2', 'hr', 'How do you give difficult feedback?'),
      ]);
    }
    if (path === '/admin/interview-questions?track=fa') {
      return reply(200, [question('q3', 'fa', 'Walk me through a DCF.')]);
    }
    return reply(404, { detail: `unscripted ${path}` });
  }) as typeof fetch;
}

async function until(check: () => boolean, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the condition never held');
}

describe('Interview questions · tracks and their questions', () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    calls.length = 0;
    globalThis.fetch = scriptedFetch(calls);
    await TestBed.configureTestingModule({
      imports: [InterviewQuestionsComponent],
    }).compileComponents();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('lands on the first track and lists its questions; picking another reads only that one', async () => {
    const fixture = TestBed.createComponent(InterviewQuestionsComponent);
    const c = fixture.componentInstance;
    await until(() => c.questionCount() === 2);
    expect(c.selectedTrackKey()).toBe('hr');
    expect(c.trackCount()).toBe(2);
    expect(c.questionsAcrossTracks()).toBe(3);
    expect(c.pageRows().map((row) => row.number)).toEqual([1, 2]);
    expect(c.draftPersona()).toBe('a Human Resources interviewer');

    await c.selectTrack('fa');
    await until(() => c.questionCount() === 1);
    expect(c.selectedTrackLabel()).toBe('Financial Analytics');
    expect(c.draftPersona()).toBe('a Financial Analytics interviewer');
    expect(calls.filter((k) => k.startsWith('GET /admin/interview-questions?track='))).toEqual([
      'GET /admin/interview-questions?track=hr',
      'GET /admin/interview-questions?track=fa',
    ]);
  });
});
