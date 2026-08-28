import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { CompanionsComponent } from './companions.component';

describe('CompanionsComponent', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [CompanionsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('loads the admin registry and the selected companion memory', async () => {
    const fixture = TestBed.createComponent(CompanionsComponent);
    fixture.detectChanges();

    const registry = http.expectOne('/api/companions');
    expect(registry.request.withCredentials).toBe(true);
    registry.flush([
      {
        id: 'c1',
        slug: 'coach',
        name: 'Coach',
        role_key: 'INTERVIEW_TRAINER',
        description: null,
        system_prompt: null,
        capabilities: ['voice'],
        allowed_roles: ['STUDENT'],
        status: 'ACTIVE',
        memory_count: 0,
      },
    ]);

    await fixture.whenStable();
    const memory = http.expectOne('/api/companions/c1/memory');
    memory.flush([]);
    await fixture.whenStable();

    expect(fixture.componentInstance.companions().length).toBe(1);
    expect(fixture.componentInstance.selectedId()).toBe('c1');
    expect(fixture.componentInstance.memories()).toEqual([]);
  });
});
