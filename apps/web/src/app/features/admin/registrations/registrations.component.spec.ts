import { TestBed } from '@angular/core/testing';

import { AdminRegistrationsComponent } from './registrations.component';

/**
 * The screen asks for the rules and for the batch names at the same moment it
 * opens, and which answer lands first is chance. A rule's "Seats in" was worked
 * out once, when the rules landed, so a rule read before the names read
 * "Batch 9b799137" for as long as the screen stayed open — while the queue
 * beside it named the same batch correctly.
 */
const BATCH_ID = '9b799137-5c2e-4a51-9f0e-2d7c1a3b4e5f';
const BATCH_LABEL = 'Master of Business Administration - Finance · 2024-26 Section B';

function scriptedFetch(batchNamesHeld: Promise<void>): typeof fetch {
  const reply = (body: unknown) =>
    ({ ok: true, status: 200, headers: new Headers(), json: async () => body }) as Response;
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/api') + 4);
    if (path === '/register/pending') return reply([]);
    if (path === '/register/rules') {
      return reply([
        {
          id: 'r1',
          name: 'MBA 2024-26 auto-admit',
          enabled: true,
          email_domain: 'bgscet.ac.in',
          usn_pattern: null,
          degree_level: 'PG',
          cohort_id: BATCH_ID,
          auto_approve: true,
          priority: 10,
          created_at: '2026-09-01T00:00:00Z',
        },
      ]);
    }
    if (path === '/register/hierarchy') {
      await batchNamesHeld;
      return reply({
        colleges: [
          {
            id: 'c1',
            name: 'BGSCET',
            departments: [
              {
                batches: [
                  {
                    id: BATCH_ID,
                    name: '2024-26 Section B',
                    batch_label: '2024-26',
                    display_label: BATCH_LABEL,
                  },
                ],
              },
            ],
          },
        ],
      });
    }
    return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) } as Response;
  }) as typeof fetch;
}

async function until(check: () => boolean, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the condition never held');
}

describe('Registrations · the rules dialog', () => {
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminRegistrationsComponent],
    }).compileComponents();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('names the batch a rule seats in when the batch names arrive after the rules', async () => {
    let releaseBatchNames = (): void => undefined;
    const batchNamesHeld = new Promise<void>((resolve) => (releaseBatchNames = resolve));
    globalThis.fetch = scriptedFetch(batchNamesHeld);

    const c = TestBed.createComponent(AdminRegistrationsComponent).componentInstance;
    await until(() => c.seatingRules() !== null);
    // Before the names: the id is all this screen has, and it says so.
    expect(c.seatingRules()?.[0].seatsIn).toBe('Batch 9b799137');

    releaseBatchNames();
    await until(() => c.batchNames().size > 0);
    expect(c.seatingRules()?.[0].seatsIn).toBe(BATCH_LABEL);
  });
});
