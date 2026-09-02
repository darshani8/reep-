/**
 * Set a password — create, reset AND change, on one screen.
 *
 * `/login/password?mode=create|reset|change`. The three modes differ in COPY
 * only: the endpoints, the table, the caps and the revocation are identical,
 * and a `mode` this screen does not know renders as `create`. Two steps:
 *
 *   1. `email` — POST `/api/auth/password/otp` with the address. The server
 *      answers 202 with one constant body for EVERY address — enrolled,
 *      unknown, off-domain, throttled, capped, or a send that failed — so this
 *      screen must never say "sent" as if it knew, and never "not found". The
 *      only thing shown after a 202 is "if that address is on the roster, a
 *      code is on its way".
 *   2. `code` — `AuthService.setPassword(email, code, newPassword)`, i.e. POST
 *      `/api/auth/password/set`. Code and password travel in ONE request, so
 *      there is no "code verified" state to hold here. Success signs the
 *      person in (the response sets the cookie and the session signal), routes
 *      by role, and has revoked every OTHER session they held — which is why
 *      the change-mode copy says so.
 *
 * `mode=change` is the shell's titlebar link. The screen binds the address to
 * the signed-in session (read-only field), because the server refuses a code
 * request whose address differs from a present session — the same two
 * endpoints, with an optional cookie, serve all three modes.
 *
 * Refusals are JSON `{detail}` (400/403/422/429/503), rendered through
 * `auth-errors.ts`; nothing here is a `?error=` redirect. The probe is the
 * login screen's `GET /api/auth/sso/status`, read for `password_setup_available`
 * and `password_reason`, and it fails OPEN like every probe in this app.
 *
 * Hygiene: the code field is `inputmode=numeric autocomplete=one-time-code`,
 * the password field `autocomplete=new-password`; nothing but the prefilled
 * `email` (an address, not a secret) is ever in a URL; `?next` is re-validated
 * with the login screen's rule and never handed to the server.
 *
 * URLs in this file use only `[a-z/]` characters after the `environment.apiBase`
 * interpolation so the route-table contract test (tests/test_sso_contract.py)
 * can scan it.
 */

import { Component, ElementRef, OnDestroy, inject, signal, viewChild } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/auth.service';
import { HOME_FOR_ROLE } from '../../core/session';
import { detailOf, detailOfHttpError } from './auth-errors';
import type { SsoStatus } from './login.component';

export type PasswordMode = 'create' | 'reset' | 'change';

const HEADINGS: Record<PasswordMode, string> = {
  create: 'Create your password',
  reset: 'Reset your password',
  change: 'Change your password',
};

/** What a 202 is allowed to say. Not "sent": the server answers 202 for an
 *  unknown address too, and this copy must not turn that into an oracle. */
const CODE_REQUESTED =
  'If that address is on the roster, a code is on its way. It works for 10 minutes ' +
  'and only the newest one counts. Give it a minute, and check spam before asking ' +
  'for another.';

const NETWORK = 'Could not reach the sign-in service.';
const DEFAULT_DOMAIN_LABEL = 'your college';
const PASSWORD_MIN_CHARS = 10;

function isMode(value: string | null): value is PasswordMode {
  return value === 'create' || value === 'reset' || value === 'change';
}

@Component({
  selector: 'app-password-setup',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './password-setup.component.html',
  styleUrl: './password-setup.component.scss',
})
export class PasswordSetupComponent implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);

  readonly mode: PasswordMode;
  readonly step = signal<'email' | 'code'>('email');

  /** Two-way bound form model, the registration screen's pattern. */
  email = '';
  code = '';
  newPassword = '';
  confirm = '';

  readonly pending = signal(false);
  readonly error = signal<string | null>(null);
  /** True when the error was a 403 — the "signed in as someone else" case,
   *  which has a fix this screen can offer. */
  readonly sessionMismatch = signal(false);
  readonly info = signal<string | null>(null);
  /** Seconds until "Send a new code" is allowed again. */
  readonly resendIn = signal(0);
  /** Fail-open: the form is live unless the probe positively shuts it. */
  readonly available = signal(true);
  readonly unavailableReason = signal<string | null>(null);
  readonly domain = signal(DEFAULT_DOMAIN_LABEL);
  /** In `change` mode, the session's address; the field is read-only then. */
  readonly lockedEmail = signal<string | null>(null);
  readonly showPassword = signal(false);

  private readonly codeInput = viewChild<ElementRef<HTMLInputElement>>('codeInput');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const params = this.route.snapshot.queryParamMap;
    const mode = params.get('mode');
    this.mode = isMode(mode) ? mode : 'create';
    this.email = (params.get('email') ?? '').trim();
    void this.probe();
    if (this.mode === 'change') void this.bindSession();
  }

  ngOnDestroy(): void {
    this.stopCountdown();
  }

  get heading(): string {
    return HEADINGS[this.mode];
  }

  get passwordMinChars(): number {
    return PASSWORD_MIN_CHARS;
  }

  /// Same-origin paths only — the login screen's rule, verbatim.
  protected get safeNext(): string | undefined {
    const next = this.route.snapshot.queryParamMap.get('next');
    return next && next.startsWith('/') && !next.startsWith('//') ? next : undefined;
  }

  /** The same probe the login screen runs, read for the password fields. */
  private async probe(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/auth/sso/status`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const status = (await res.json()) as SsoStatus;
      if (status.domain) this.domain.set(status.domain);
      if (status.password_setup_available === false) {
        this.available.set(false);
        this.unavailableReason.set(
          status.password_reason || 'Email & password sign-in is not configured on this server.',
        );
      }
    } catch {
      // Fail open, deliberately: a broken probe must never be the reason a
      // password cannot be set.
    }
  }

  /** `mode=change`: the address is the session's, and it is not editable. */
  private async bindSession(): Promise<void> {
    const session = this.auth.session() ?? (await this.auth.refresh());
    if (session) {
      this.email = session.email;
      this.lockedEmail.set(session.email);
    }
  }

  toggleShowPassword(): void {
    this.showPassword.update((v) => !v);
  }

  /** Digits only, six at most — typed, pasted or autofilled. */
  onCodeChange(value: string): void {
    this.code = (value ?? '').replace(/\D/g, '').slice(0, 6);
  }

  /** Back to the address step (not offered in `change` mode). */
  changeEmail(): void {
    this.step.set('email');
    this.code = '';
    this.info.set(null);
    this.error.set(null);
    this.sessionMismatch.set(false);
  }

  /**
   * Step 1 (and "Send a new code"): ask for a code. 202 is the ONLY success
   * and says nothing about the address — see the header.
   */
  async requestCode(event?: Event): Promise<void> {
    event?.preventDefault();
    if (this.pending() || !this.available() || this.resendIn() > 0) return;

    const email = this.email.trim();
    this.error.set(null);
    this.sessionMismatch.set(false);
    if (!email || !email.includes('@')) {
      this.error.set('Enter your college email address.');
      return;
    }
    this.email = email;

    this.pending.set(true);
    try {
      const res = await fetch(`${environment.apiBase}/auth/password/otp`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.status === 202) {
        let seconds = 60;
        try {
          const body = (await res.json()) as { resend_after_seconds?: unknown };
          if (typeof body?.resend_after_seconds === 'number') seconds = body.resend_after_seconds;
        } catch {
          /* the constant is the contract; the body is a courtesy */
        }
        this.code = '';
        this.info.set(CODE_REQUESTED);
        this.step.set('code');
        this.startCountdown(seconds);
        this.focusCode();
        return;
      }
      this.sessionMismatch.set(res.status === 403);
      this.error.set(await detailOf(res));
    } catch {
      this.error.set(NETWORK);
    } finally {
      this.pending.set(false);
    }
  }

  /**
   * Step 2: code + new password in one request. A 400 keeps the typed
   * password (the code was wrong, not the password) and clears the code, so
   * the next attempt is one field's worth of typing.
   */
  async submitPassword(event: Event): Promise<void> {
    event.preventDefault();
    if (this.pending() || !this.available()) return;

    this.error.set(null);
    this.sessionMismatch.set(false);
    const email = this.email.trim();
    if (!/^[0-9]{6}$/.test(this.code)) {
      this.error.set('Enter the 6-digit code from the email.');
      this.focusCode();
      return;
    }
    if (this.newPassword.length < PASSWORD_MIN_CHARS) {
      this.error.set(`Choose a password of at least ${PASSWORD_MIN_CHARS} characters.`);
      return;
    }
    if (this.newPassword !== this.confirm) {
      this.error.set('The two passwords do not match.');
      return;
    }

    this.pending.set(true);
    try {
      const session = await this.auth.setPassword(email, this.code, this.newPassword);
      this.stopCountdown();
      await this.router.navigateByUrl(this.safeNext ?? HOME_FOR_ROLE[session.role]);
    } catch (err) {
      if (err instanceof HttpErrorResponse) {
        this.error.set(detailOfHttpError(err));
        if (err.status === 400) {
          this.code = '';
          this.focusCode();
        }
        this.sessionMismatch.set(err.status === 403);
      } else {
        this.error.set(NETWORK);
      }
    } finally {
      this.pending.set(false);
    }
  }

  /** The 403 fix: drop the other account's session and try again. */
  async signOut(): Promise<void> {
    try {
      await this.auth.logout();
    } catch {
      /* the cookie may already be gone; either way the binding is released */
    }
    this.lockedEmail.set(null);
    this.sessionMismatch.set(false);
    this.error.set(null);
  }

  private startCountdown(seconds: number): void {
    this.stopCountdown();
    this.resendIn.set(Math.max(0, Math.floor(seconds)));
    if (this.resendIn() === 0) return;
    this.timer = setInterval(() => {
      const left = this.resendIn() - 1;
      this.resendIn.set(Math.max(0, left));
      if (left <= 0) this.stopCountdown();
    }, 1000);
  }

  private stopCountdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private focusCode(): void {
    // The input renders on the next change-detection pass after `step` flips.
    setTimeout(() => this.codeInput()?.nativeElement.focus(), 0);
  }
}
