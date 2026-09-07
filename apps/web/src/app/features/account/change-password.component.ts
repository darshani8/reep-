/**
 * Change password — signed in, knows the current one.
 *
 * The simplest of the three password flows: no email, no token. Current
 * password checked, new one through the same policy activation uses, and
 * then OTHER devices are signed out while this one stays — the API re-issues
 * this cookie with the new token_version before answering, and the service's
 * `refresh()` reads it back so the shell never flickers to signed-out.
 *
 * Staff only in practice. Students sign in with Google and hold no password
 * (option B); the API answers 409 for them and the screen says so instead of
 * showing a form that can never succeed.
 */

import { Component, inject, signal } from '@angular/core';
import {
  AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';

import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/auth.service';

const MIN_LENGTH = 12;

function matching(group: AbstractControl): ValidationErrors | null {
  const a = group.get('new_password')?.value;
  const b = group.get('confirm')?.value;
  return a && b && a !== b ? { mismatch: true } : null;
}

@Component({
  selector: 'app-change-password',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './change-password.component.html',
  styleUrl: './change-password.component.scss',
})
export class ChangePasswordComponent {
  private readonly auth = inject(AuthService);

  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);
  readonly flash = signal<string | null>(null);
  /** 409 from the API: this account has no password to change. */
  readonly noPassword = signal(false);
  readonly minLength = MIN_LENGTH;

  readonly form = new FormGroup(
    {
      current_password: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
      new_password: new FormControl('', {
        nonNullable: true,
        validators: [Validators.required, Validators.minLength(MIN_LENGTH)],
      }),
      confirm: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    },
    { validators: [matching] },
  );

  async submit(): Promise<void> {
    if (this.form.invalid || this.submitting()) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.error.set(null);
    this.flash.set(null);
    const { current_password, new_password } = this.form.getRawValue();
    try {
      const res = await fetch(`${environment.apiBase}/auth/change-password`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password, new_password }),
      });
      const body = (await res.json().catch(() => ({}))) as { detail?: unknown };
      const detail = typeof body.detail === 'string' ? body.detail : null;
      if (res.status === 409) {
        this.noPassword.set(true);
        return;
      }
      if (!res.ok) {
        this.error.set(detail ?? `Could not change the password (${res.status}).`);
        // Never leave the current password sitting in the DOM behind a refusal.
        this.form.patchValue({ current_password: '' });
        return;
      }
      await this.auth.refresh(); // the re-issued cookie, read back
      this.form.reset();
      this.flash.set('Password changed. Your other devices have been signed out; this one stays.');
    } catch {
      this.error.set('Could not reach the server. Try again in a moment.');
    } finally {
      this.submitting.set(false);
    }
  }
}
