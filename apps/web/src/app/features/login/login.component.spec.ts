import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';

import { AuthService } from '../../core/auth.service';
import { LoginComponent } from './login.component';

/**
 * The password door reads two probe fields, and both are "only an explicit
 * false shuts it". These pin the two shut states: the whole form disabled WITH
 * the server's reason, and the setup links replaced by the reason. The
 * load-bearing pin on the field NAMES is apps/api-py/tests/test_sso_contract.py;
 * this is the cheap insurance that the values are read once they arrive.
 */

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

describe('LoginComponent — the password door', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LoginComponent],
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: { session: signal(null), login: vi.fn(), refresh: vi.fn(async () => null) },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function render(status: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, status)),
    );
    const fixture = TestBed.createComponent(LoginComponent);
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    return fixture;
  }

  it('renders the form disabled with the reason when password sign-in is off', async () => {
    const fixture = await render({
      google_available: true,
      password_login_available: false,
      password_setup_available: false,
      password_reason:
        'Email & password sign-in is not switched on for this server (LOCAL_AUTH_ENABLED).',
      domain: 'bgscet.ac.in',
    });
    const host = fixture.nativeElement as HTMLElement;
    const email = host.querySelector<HTMLInputElement>('input[name="email"]');
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(email?.disabled).toBe(true);
    expect(submit?.disabled).toBe(true);
    expect(host.querySelector('.door [role="status"]')?.textContent).toContain(
      'LOCAL_AUTH_ENABLED',
    );
    expect(host.querySelector('a[href*="/login/password"]')).toBeNull();
    fixture.destroy();
  });

  it('hides the create/forgot links when only the emailed-code setup is off', async () => {
    const fixture = await render({
      google_available: true,
      password_login_available: true,
      password_setup_available: false,
      password_reason: 'Email is not configured on this server (EMAIL_TRANSPORT is blank).',
      domain: 'bgscet.ac.in',
    });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector<HTMLInputElement>('input[name="email"]')?.disabled).toBe(false);
    expect(host.querySelector('a[href*="/login/password"]')).toBeNull();
    expect(host.querySelector('.setup-link--muted')?.textContent).toContain('EMAIL_TRANSPORT');
    fixture.destroy();
  });

  it('keeps everything live when the probe does not mention the password fields', async () => {
    const fixture = await render({ google_available: true, domain: 'bgscet.ac.in' });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector<HTMLInputElement>('input[name="email"]')?.disabled).toBe(false);
    expect(host.querySelectorAll('a[href*="/login/password"]').length).toBe(2);
    fixture.destroy();
  });
});
