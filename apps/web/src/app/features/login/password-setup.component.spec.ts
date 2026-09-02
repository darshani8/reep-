import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';

import { AuthService } from '../../core/auth.service';
import { PasswordSetupComponent } from './password-setup.component';

/**
 * The set-password screen, against a stubbed probe and a stubbed AuthService.
 *
 * Three behaviours worth pinning, because each one is invisible from `ng build`:
 * a 202 must move to the code step and start the resend countdown (and say
 * nothing about whether the address exists); a probe that says the door is off
 * must render the reason and NO form; and a wrong code (400) must keep the
 * typed password while clearing the code — the code was wrong, not the
 * password, and re-typing ten characters per attempt is how people give up.
 */

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(routes: Record<string, () => Response>): FetchStub {
  const stub: FetchStub = async (url) => {
    for (const [suffix, make] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return make();
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  vi.stubGlobal('fetch', vi.fn(stub));
  return stub;
}

const STATUS_ON = {
  google_available: true,
  password_setup_available: true,
  domain: 'bgscet.ac.in',
};

describe('PasswordSetupComponent', () => {
  let authStub: {
    session: ReturnType<typeof signal<null>>;
    refresh: ReturnType<typeof vi.fn>;
    setPassword: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    authStub = {
      session: signal(null),
      refresh: vi.fn(async () => null),
      setPassword: vi.fn(),
      logout: vi.fn(async () => undefined),
    };
    await TestBed.configureTestingModule({
      imports: [PasswordSetupComponent],
      providers: [provideRouter([]), { provide: AuthService, useValue: authStub }],
    }).compileComponents();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function settle(fixture: { whenStable(): Promise<unknown>; detectChanges(): void }) {
    // The probe is a fetch in the constructor; let its promise chain drain.
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }

  it('moves to the code step on a 202 and starts the resend countdown', async () => {
    stubFetch({
      '/auth/sso/status': () => jsonResponse(200, STATUS_ON),
      '/auth/password/otp': () => jsonResponse(202, { ok: true, resend_after_seconds: 60 }),
    });
    const fixture = TestBed.createComponent(PasswordSetupComponent);
    const cmp = fixture.componentInstance;
    await settle(fixture);
    expect(cmp.step()).toBe('email');

    cmp.email = 'student@bgscet.ac.in';
    await cmp.requestCode();
    fixture.detectChanges();

    expect(cmp.step()).toBe('code');
    expect(cmp.resendIn()).toBe(60);
    // Never "sent" and never "not found": the server answers 202 for everyone.
    expect(cmp.info()).toMatch(/If that address is on the roster/);
    expect(cmp.error()).toBeNull();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('input[name="code"]')).not.toBeNull();
    expect(host.textContent).toContain('Send a new code (60 s)');
    fixture.destroy();
  });

  it('renders the reason and no form when the probe says the door is off', async () => {
    stubFetch({
      '/auth/sso/status': () =>
        jsonResponse(200, {
          google_available: true,
          password_setup_available: false,
          password_reason:
            'Email & password sign-in is not switched on for this server (LOCAL_AUTH_ENABLED).',
          domain: 'bgscet.ac.in',
        }),
    });
    const fixture = TestBed.createComponent(PasswordSetupComponent);
    await settle(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const status = host.querySelector('[role="status"]');
    expect(status?.textContent).toContain('LOCAL_AUTH_ENABLED');
    expect(host.querySelector('form')).toBeNull();
    expect(fixture.componentInstance.available()).toBe(false);
    fixture.destroy();
  });

  it('keeps the typed password and clears the code on a 400', async () => {
    stubFetch({
      '/auth/sso/status': () => jsonResponse(200, STATUS_ON),
      '/auth/password/otp': () => jsonResponse(202, { ok: true, resend_after_seconds: 60 }),
    });
    const detail =
      'That code is not valid or has expired. Only the newest code works — check the ' +
      'latest email, or request a new one.';
    authStub.setPassword.mockRejectedValue(
      new HttpErrorResponse({ status: 400, error: { detail } }),
    );
    const fixture = TestBed.createComponent(PasswordSetupComponent);
    const cmp = fixture.componentInstance;
    await settle(fixture);

    cmp.email = 'student@bgscet.ac.in';
    await cmp.requestCode();
    fixture.detectChanges();
    cmp.code = '123456';
    cmp.newPassword = 'correct horse battery';
    cmp.confirm = 'correct horse battery';
    await cmp.submitPassword(new Event('submit'));
    fixture.detectChanges();

    expect(authStub.setPassword).toHaveBeenCalledWith(
      'student@bgscet.ac.in',
      '123456',
      'correct horse battery',
    );
    expect(cmp.error()).toBe(detail);
    expect(cmp.code).toBe('');
    expect(cmp.newPassword).toBe('correct horse battery');
    expect(cmp.step()).toBe('code');
    fixture.destroy();
  });
});
