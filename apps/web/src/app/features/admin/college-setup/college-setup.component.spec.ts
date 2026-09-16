import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';

import { AuthService } from '../../../core/auth.service';
import { AdminCollegeSetupComponent } from './college-setup.component';

/**
 * "Create everything" against a scripted API: the five POSTs College structure
 * makes, in parent-before-child order, with the same payloads — and a 409
 * answered by looking the row up rather than failing, which is what makes the
 * button safe to press twice.
 */
interface Call {
  method: string;
  path: string;
  body: unknown;
}

function scriptedFetch(calls: Call[]): typeof fetch {
  const reply = (status: number, body: unknown) =>
    ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/api') + 4);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    if (method === 'GET' && path === '/admin/colleges') return reply(200, []);
    if (method === 'POST' && path === '/admin/colleges') {
      return reply(201, { id: 'c1', code: '1MP', name: 'BGSCET', campus: null, email_domains: [] });
    }
    if (method === 'POST' && path === '/admin/colleges/c1/departments') {
      return reply(201, { id: 'd1', code: 'MBA', name: 'Management', head: null });
    }
    if (method === 'POST' && path === '/admin/departments/d1/academic-courses') {
      return reply(201, { id: 'k1', code: 'MBA', name: 'General MBA', duration_months: 24 });
    }
    if (method === 'POST' && path === '/admin/academic-courses/k1/academic-specializations') {
      return reply(409, { detail: 'A specialization with code FA already exists.' });
    }
    if (method === 'GET' && path === '/admin/academic-courses/k1/academic-specializations') {
      return reply(200, [{ id: 's1', course_id: 'k1', code: 'FA', name: 'Financial Analytics' }]);
    }
    if (method === 'POST' && path === '/admin/departments/d1/cohorts') {
      return reply(201, { id: 'b1', code: body.code, course_id: 'k1', specialization_id: 's1' });
    }
    return reply(404, { detail: `unscripted ${method} ${path}` });
  }) as typeof fetch;
}

describe('Set up a college · Create everything', () => {
  const calls: Call[] = [];
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    calls.length = 0;
    globalThis.fetch = scriptedFetch(calls);
    await TestBed.configureTestingModule({
      imports: [AdminCollegeSetupComponent],
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: { session: signal({ role: 'ADMIN', capabilities: ['admin.institution'] }) },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('writes college, department, course, specialization and batch in order, with the screens’ payloads', async () => {
    const fixture = TestBed.createComponent(AdminCollegeSetupComponent);
    const c = fixture.componentInstance;

    c.setCode('1mp');
    c.setName('BGSCET');
    c.setDomains('BGSCET.ac.in');
    const dept = c.departments()[0];
    c.setDepartment(dept.key, 'code', 'MBA');
    c.setDepartment(dept.key, 'name', 'Management');
    c.addCourse(dept.key);
    const course = c.courses()[0];
    c.setCourse(course.key, 'code', 'MBA');
    c.setCourse(course.key, 'name', 'General MBA');
    c.addSpec(course.key);
    const spec = c.specs()[0];
    c.setSpec(spec.key, 'code', 'fa');
    c.setSpec(spec.key, 'name', 'Financial Analytics');
    c.setStartYear('2026');

    expect(c.batches().map((b) => b.code)).toEqual(['1MP-MBA-MBA-FA-2026-28']);
    expect(c.toWrite()).toBe(5);

    await c.createEverything();

    expect(c.runState()).toBe('done');
    expect(c.outcome('college')).toEqual({ status: 'created' });
    expect(c.outcome(dept.key)).toEqual({ status: 'created' });
    expect(c.outcome(course.key)).toEqual({ status: 'created' });
    expect(c.outcome(spec.key)).toEqual({ status: 'existed' });
    expect(c.outcome('batch:' + spec.key)).toEqual({ status: 'created' });

    const posts = calls.filter((k) => k.method === 'POST');
    expect(posts.map((k) => k.path)).toEqual([
      '/admin/colleges',
      '/admin/colleges/c1/departments',
      '/admin/departments/d1/academic-courses',
      '/admin/academic-courses/k1/academic-specializations',
      '/admin/departments/d1/cohorts',
    ]);
    expect(posts[0].body).toEqual({
      code: '1mp',
      name: 'BGSCET',
      campus: null,
      contact: null,
      email_domains: ['bgscet.ac.in'],
    });
    expect(posts[1].body).toEqual({ code: 'MBA', name: 'Management', head: null });
    expect(posts[2].body).toEqual({ code: 'MBA', name: 'General MBA', duration_months: 24 });
    expect(posts[4].body).toEqual({
      code: '1MP-MBA-MBA-FA-2026-28',
      // THE NAME IS THE YEAR. The course and the specialization go down
      // `course_id` / `specialization_id` below, which is the same fact
      // stored once instead of twice; the screens compose them back on.
      name: '2026-28',
      batch_label: '2026-28',
      degree_level: 'PG',
      entry_date: '2026-07-01',
      expected_completion: '2028-06-30',
      course_id: 'k1',
      specialization_id: 's1',
    });
  });

  it('will not leave a step with a required box empty', () => {
    const fixture = TestBed.createComponent(AdminCollegeSetupComponent);
    const c = fixture.componentInstance;
    expect(c.stepComplete()).toBe(false);
    c.setCode('1MP');
    expect(c.stepComplete()).toBe(false);
    c.setName('BGSCET');
    expect(c.stepComplete()).toBe(true);
    c.goNext();
    expect(c.step()).toBe(2);
    expect(c.stepComplete()).toBe(false);
  });
});

/** Poll until `check` holds: the component's loads are plain fetch promises
 *  that `whenStable` does not track. */
async function until(check: () => boolean, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the condition never held');
}

/**
 * Opened from a college card or a College structure section: `?college=` loads
 * that college on step 1 exactly as picking it in the select would, and
 * `?step=` opens on that step — so "Add a course" on College structure is one
 * press away from the course rows rather than six.
 */
describe('Set up a college · opened with ?college= and ?step=', () => {
  const calls: Call[] = [];
  const realFetch = globalThis.fetch;

  function existingCollegeFetch(): typeof fetch {
    const reply = (status: number, body: unknown) =>
      ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.slice(url.indexOf('/api') + 4);
      const method = init?.method ?? 'GET';
      calls.push({ method, path, body: null });
      switch (path) {
        case '/admin/colleges':
          return reply(200, [
            {
              id: 'c1',
              code: '1MP',
              name: 'BGSCET',
              campus: null,
              contact: null,
              email_domains: [],
            },
          ]);
        case '/admin/colleges/c1/departments':
          return reply(200, [{ id: 'd1', code: 'MBA', name: 'Management', head: null }]);
        case '/admin/departments/d1/academic-courses':
          return reply(200, [{ id: 'k1', code: 'MBA', name: 'General MBA', duration_months: 24 }]);
        case '/admin/departments/d1/cohorts':
          return reply(200, []);
        case '/admin/academic-courses/k1/academic-specializations':
          return reply(200, []);
      }
      return reply(404, { detail: `unscripted ${method} ${path}` });
    }) as typeof fetch;
  }

  beforeEach(async () => {
    calls.length = 0;
    globalThis.fetch = existingCollegeFetch();
    await TestBed.configureTestingModule({
      imports: [AdminCollegeSetupComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { queryParamMap: convertToParamMap({ college: 'c1', step: '3' }) },
          },
        },
        {
          provide: AuthService,
          useValue: { session: signal({ role: 'ADMIN', capabilities: ['admin.institution'] }) },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('loads the named college and opens on the named step', async () => {
    const fixture = TestBed.createComponent(AdminCollegeSetupComponent);
    const c = fixture.componentInstance;
    await until(() => c.step() === 3);
    expect(c.existingCollege()?.id).toBe('c1');
    expect(c.departments().map((d) => d.existingId)).toEqual(['d1']);
    expect(c.courses().map((k) => k.existingId)).toEqual(['k1']);
    expect(c.stepComplete()).toBe(true);
    expect(calls.filter((k) => k.method === 'POST')).toEqual([]);
  });
});
