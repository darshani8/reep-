/**
 * The client half of authentication.
 *
 * The React app signed in through a Server Action that set an http-only cookie;
 * the Angular client cannot run server code, so it POSTs credentials to the
 * NestJS backend, which sets the same http-only session cookie and returns the
 * session payload. `withCredentials` is what carries that cookie back on every
 * later request — the cookie is never read by JavaScript, exactly as before.
 *
 * The signed-in session is held in a signal so guards and the shell can react
 * to it without re-fetching.
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

  /// POST the credentials; the backend validates against the same scrypt hash
  /// and sets the session cookie. Returns the session so the caller can route
  /// by role.
  async login(email: string, password: string, next?: string): Promise<SessionPayload> {
    const session = await firstValueFrom(
      this.http.post<SessionPayload>(
        `${environment.apiBase}/auth/login`,
        { email, password, next },
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
