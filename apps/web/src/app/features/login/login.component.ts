/**
 * Sign in — the Angular port of the React `/login` screen.
 *
 * Matched to `src/app/login/page.tsx` and `login-form.tsx`: brand panel on the
 * left from lg up, a compact brand strip below it, the sign-in column on the
 * right, and the demo-account card. Every measurement is the MUI original —
 * 8px spacing unit, lg at 1200px, sm at 600px — and every colour is a ported
 * token, so it renders identically to today.
 *
 * The demo-account buttons write into the same two fields the form submits,
 * which is why the whole screen is one component, exactly as the note in
 * login-form.tsx explains.
 */

import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';

import { AuthService } from '../../core/auth.service';
import { HOME_FOR_ROLE } from '../../core/session';

interface DemoAccount {
  email: string;
  who: string;
  role: string;
}

const DEMO_PASSWORD = 'reep2026';

const DEMO_ACCOUNTS: DemoAccount[] = [
  { email: 'ananya.r@bgscet.ac.in', who: 'Ananya R.', role: 'Student, on track' },
  { email: 'aditi.k@bgscet.ac.in', who: 'Aditi K.', role: 'Student, behind on hours' },
  { email: 'rakesh.iyer@bgscet.ac.in', who: 'Prof. Rakesh Iyer', role: 'Faculty mentor' },
  { email: 's.manjunath@bgscet.ac.in', who: 'Dr. S. Manjunath', role: 'Programme director' },
];

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly demoAccounts = DEMO_ACCOUNTS;
  readonly demoPassword = DEMO_PASSWORD;

  email = '';
  password = '';
  showPassword = signal(false);
  error = signal<string | null>(null);
  pending = signal(false);

  /// Same-origin paths only, matching the React page's `safeNext` check.
  private get safeNext(): string | undefined {
    const next = this.route.snapshot.queryParamMap.get('next');
    return next && next.startsWith('/') && !next.startsWith('//') ? next : undefined;
  }

  get subtitle(): string {
    return this.safeNext
      ? 'Sign in to carry on to the page you asked for.'
      : 'Use your BGSCET email address and password.';
  }

  togglePassword(): void {
    this.showPassword.update((shown) => !shown);
  }

  fillFrom(demoEmail: string): void {
    this.email = demoEmail;
    this.password = DEMO_PASSWORD;
    this.showPassword.set(false);
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.pending()) return;

    if (!this.email || !this.password) {
      this.error.set('Enter both your email and password.');
      return;
    }

    this.pending.set(true);
    this.error.set(null);
    try {
      const session = await this.auth.login(this.email, this.password, this.safeNext);
      await this.router.navigateByUrl(this.safeNext ?? HOME_FOR_ROLE[session.role]);
    } catch {
      // The backend answers a bad credential with 401; anything else is a
      // connection problem. The message stays deliberately vague, as the React
      // action's did — it never reveals whether the email exists.
      this.error.set('Those credentials do not match an account.');
    } finally {
      this.pending.set(false);
    }
  }
}
