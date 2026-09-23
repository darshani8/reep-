import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';

import { AuthService } from '../../core/auth.service';
import { LoginComponent } from './login.component';

/**
 * The sign-in card's own behaviour, without a server: the field messages
 * follow the fields.
 */

/** The capability probe, answering with the password door open. */
const probeFetch = (async () =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ google_available: false, password_login_available: true }),
  }) as unknown as Response) as typeof fetch;

/** An AuthService whose every sign-in is refused with `status`. */
function refusingAuth(status: number, detail?: string): Partial<AuthService> {
  return {
    login: async () => {
      throw new HttpErrorResponse({ status, error: detail === undefined ? null : { detail } });
    },
  };
}

async function create(auth: Partial<AuthService> = refusingAuth(401)): Promise<LoginComponent> {
  await TestBed.configureTestingModule({
    imports: [LoginComponent],
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) } } },
      { provide: AuthService, useValue: auth },
    ],
  }).compileComponents();
  return TestBed.createComponent(LoginComponent).componentInstance;
}

describe('Sign in · the field messages follow the fields', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = probeFetch;
    localStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('shows both after an empty attempt and clears each as its field is filled', async () => {
    const c = await create();
    await c.submitPassword();
    expect(c.idErr()).toBe(true);
    expect(c.pwErr()).toBe(true);

    c.form.controls.id.setValue('student@bgscet.ac.in');
    expect(c.idErr()).toBe(false);
    expect(c.pwErr()).toBe(true);

    c.form.controls.password.setValue('wrong-password');
    expect(c.pwErr()).toBe(false);

    c.form.controls.id.setValue('   ');
    expect(c.idErr()).toBe(true);
  });

  it('does not ask for a password beside the answer to a refused sign-in', async () => {
    const c = await create();
    c.form.setValue({ id: 'student@bgscet.ac.in', password: 'wrong-password', remember: false });
    await c.submitPassword();
    expect(c.formError()).toContain('did not match an account');
    expect(c.form.controls.password.value).toBe('');
    expect(c.pwErr()).toBe(false);
    expect(c.idErr()).toBe(false);
  });
});
