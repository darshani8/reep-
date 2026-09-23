import { TestBed } from '@angular/core/testing';

import { LeaderboardsComponent } from './leaderboards.component';

/**
 * A board the office switched off for this student is refused with the
 * office's own sentence (`require_feature`, a 403 marked
 * `X-Reep-Feature-Disabled`), and the screen must print that sentence rather
 * than its own "Could not load the leaderboard.", which reads as a broken app.
 */
function answering(status: number, body: unknown, headers: Record<string, string> = {}) {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    })) as typeof fetch;
}

async function until(check: () => boolean, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the condition never held');
}

describe('Leaderboards · a refused read', () => {
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [LeaderboardsComponent] }).compileComponents();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("prints the office's message when the feature is switched off", async () => {
    globalThis.fetch = answering(
      403,
      { detail: 'Leaderboards are paused this week.' },
      { 'X-Reep-Feature-Disabled': 'student.leaderboards' },
    );
    const c = TestBed.createComponent(LeaderboardsComponent).componentInstance;
    await until(() => c.error() !== null);
    expect(c.error()).toBe('Leaderboards are paused this week.');
  });

  it('keeps its own line for any other failure', async () => {
    globalThis.fetch = answering(500, { detail: 'boom' });
    const c = TestBed.createComponent(LeaderboardsComponent).componentInstance;
    await until(() => c.error() !== null);
    expect(c.error()).toBe('Could not load the leaderboard.');
  });
});
