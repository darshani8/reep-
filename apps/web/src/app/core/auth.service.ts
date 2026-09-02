/**
 * The client half of authentication.
 *
 * Two doors, one session: the Google callback sets the httpOnly `reep_session`
 * cookie server-side and the SPA simply reboots into it; the email & password
 * form (`login()`) and the set-password screen (`setPassword()`) POST here and
 * receive the same cookie plus the session payload in the body. `withCredentials`
 * is what carries that cookie back on every later request — the cookie is never
 * read by JavaScript, whichever door minted it.
 *
 * The signed-in session is held in a signal so guards and the shell can react
 * to it without re-fetching, and both POSTs set it on success so the guard
 * chain has one source of truth rather than a second `/auth/me` round trip.
 */

import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../environments/environment';
import type { SessionPayload } from './session';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  private readonly _session = signal<SessionPayload | null>(null);
  readonly session = this._session.asReadonly();
  readonly isSignedIn = computed(() => this._session() !== null);

  /// POST the credentials; the backend validates against the scrypt hash and
  /// sets the session cookie. Returns the session so the caller can route by
  /// role. 401/403/429 arrive as HttpErrorResponse with a `detail` sentence.
  async login(email: string, password: string): Promise<SessionPayload> {
    const session = await firstValueFrom(
      this.http.post<SessionPayload>(
        `${environment.apiBase}/auth/login`,
        { email, password },
        { withCredentials: true },
      ),
    );
    this._session.set(session);
    return session;
  }

  /// Redeem an emailed code for a new password (create, reset or change — the
  /// endpoint is the same for all three). On success the caller is signed in
  /// on a fresh cookie and every other session of theirs is revoked, so the
  /// signal is set here too. 400/403/422/429/503 arrive as HttpErrorResponse.
  async setPassword(email: string, code: string, newPassword: string): Promise<SessionPayload> {
    const session = await firstValueFrom(
      this.http.post<SessionPayload>(
        `${environment.apiBase}/auth/password/set`,
        { email, code, new_password: newPassword },
        { withCredentials: true },
      ),
    );
    this._session.set(session);
    return session;
  }

  /// Reads the current session from the cookie, or null. Used by the guard on
  /// first load and after a hard refresh. FastAPI exposes this as /auth/me.
  async refresh(): Promise<SessionPayload | null> {
    try {
      const session = await firstValueFrom(
        this.http.get<SessionPayload>(`${environment.apiBase}/auth/me`, {
          withCredentials: true,
        }),
      );
      this._session.set(session);
      return session;
    } catch {
      this._session.set(null);
      return null;
    }
  }

  async logout(): Promise<void> {
    await firstValueFrom(
      this.http.post(`${environment.apiBase}/auth/logout`, {}, { withCredentials: true }),
    );
    this._session.set(null);
  }
}
