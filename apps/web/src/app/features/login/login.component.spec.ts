import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';

import { AuthService } from '../../core/auth.service';
import { LoginComponent } from './login.component';

/**
 * The sign-in card's own behaviour, without a server: the field messages
 * follow the fields, and "Remember me" brings back the door it was ticked at.
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

describe('Sign in · Remember me', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = probeFetch;
    localStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    localStorage.clear();
  });

  it('brings back the Main Admin door it was ticked at', async () => {
    localStorage.setItem('reep.login.id', 'admin@bgscet.ac.in');
    localStorage.setItem('reep.login.portal', 'admin');
    const c = await create();
    expect(c.portal()).toBe('admin');
    expect(c.current().fieldLabel).toBe('Institutional email');
    expect(c.form.controls.id.value).toBe('admin@bgscet.ac.in');
    expect(c.form.controls.remember.value).toBe(true);
  });

  it('brings back a portal card, and ignores a value that names none', async () => {
    localStorage.setItem('reep.login.id', 'mentor@bgscet.ac.in');
    localStorage.setItem('reep.login.portal', 'mentor');
    expect((await create()).portal()).toBe('mentor');

    TestBed.resetTestingModule();
    localStorage.setItem('reep.login.portal', 'director');
    expect((await create()).portal()).toBe('student');
  });
});
