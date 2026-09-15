import { TestBed } from '@angular/core/testing';

import { InterviewRecordsComponent } from './interviews.component';

/**
 * The policy card is always open, so its college list is read when the
 * screen opens, and picking a college reads that college's sheet. A college
 * nobody has configured reads "Not configured" with the deployment's
 * defaults in the boxes — never as a stored row.
 */
function scriptedFetch(calls: string[]): typeof fetch {
  const reply = (status: number, body: unknown) =>
    ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/api') + 4);
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path.startsWith('/admin/interviews/summary')) {
      return reply(200, {
        interviews: 0,
        completed: 0,
        abandoned: 0,
        failed: 0,
        running: 0,
        students: 0,
        recorded: 0,
        scored: 0,
        average_overall: null,
      });
    }
    if (path.startsWith('/admin/interviews?')) {
      return reply(200, { rows: [], next_cursor: null, page_size: 200 });
    }
    if (path === '/admin/cohorts') return reply(200, []);
    if (path === '/admin/colleges') {
      return reply(200, [{ id: 'c1', code: '1MP', name: 'BGSCET', status: 'ACTIVE' }]);
    }
    if (path === '/admin/interview-policies/c1') {
      return reply(200, {
        college_id: 'c1',
        college_name: 'BGSCET',
        default: null,
        courses: [],
        effective_default: {
          store_transcript: true,
          store_audio: false,
          retention_days: 180,
          daily_cap: 8,
          attempt_cap: 20,
          time_limit_seconds: 900,
          source: 'default',
        },
      });
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

describe('Interview records · the policy card', () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    calls.length = 0;
    globalThis.fetch = scriptedFetch(calls);
    await TestBed.configureTestingModule({
      imports: [InterviewRecordsComponent],
    }).compileComponents();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('reads the colleges when the screen opens, and an unconfigured college as the defaults', async () => {
    const fixture = TestBed.createComponent(InterviewRecordsComponent);
    const c = fixture.componentInstance;
    await until(() => c.colleges() !== null && !c.loading());
    expect(calls).toContain('GET /admin/colleges');
    expect(c.collegesBlocked()).toBeNull();
    expect(c.policySheet()).toBeNull();

    const pick = { target: { value: 'c1' } } as unknown as Event;
    await c.setPolicyCollege(pick);
    expect(c.policySheet()?.college_name).toBe('BGSCET');
    expect(c.policyIsConfigured()).toBe(false);
    expect(c.draftRetentionDays()).toBe(180);
    expect(c.draftAttemptCap()).toBe(20);
    expect(c.policyCapsAreOrdered()).toBe(true);
    expect(c.canSavePolicy()).toBe(true);
  });
});
