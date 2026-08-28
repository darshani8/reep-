/**
 * Sign in — Google in production, plus a password door that only development
 * servers are allowed to open.
 *
 * There is one way into a deployed REEP: a college Google account that is
 * already on the programme roster. `POST /api/auth/login` still exists on the
 * API as a dev/CI affordance that production refuses, and this screen now
 * offers it — but ONLY when the server itself says it is allowed, via
 * `password_login_available` on the capability probe below. See the
 * `devLogin` signal for why that flag fails closed while the Google one fails
 * open; the short version is that a broken probe must never draw a second door
 * on a production login screen.
 *
 * Without it, a machine with no `GOOGLE_CLIENT_ID` has no way into the UI at
 * all — the dashboard is unreachable on a fresh clone, which is what this
 * restores.
 *
 * The flow is backend-terminal, and that is what keeps this component small:
 *
 *   1. a full-page navigation to `/api/auth/sso/google` (an <a href>, not a
 *      fetch — OAuth needs a real top-level redirect, and an XHR cannot leave
 *      the origin and come back with a cookie);
 *   2. the API mints the OAuth `state`, sends the browser to Google, validates
 *      the callback, and sets the same httpOnly `reep_session` cookie the
 *      password path always set;
 *   3. it 302s back into the SPA, which cold-boots, `authGuard` runs,
 *      `AuthService.refresh()` reads `GET /api/auth/me` with the fresh cookie,
 *      and the session is live.
 *
 * So this component never sees a token, never sets a cookie, and does not route
 * by role — step 3 is an ordinary hard refresh, which the guard already handles.
 * The only thing that comes back to *this* screen is a refusal.
 *
 * REFUSALS ARRIVE AS `/login?error=<code>`, and nothing else. The codes in
 * `messageFor` are the contract with the callback docstring in
 * `app/routers/auth.py` — keep them byte-identical to it. An unrecognised code
 * still renders an honest, non-blaming message rather than nothing, but that
 * fallback is a bug report, not a feature: the first version of this screen
 * invented its own vocabulary (`not_on_roster`, `wrong_domain`, …) that shared
 * NOT ONE code with the seven the server emits, so every single refusal —
 * including the commonest one, a personal Gmail — rendered as "the reason given
 * is not one this page knows" and every honest message below was dead code.
 */

import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

import { environment } from '../../../environments/environment';

/**
 * `GET /api/auth/sso/status` — the capability probe.
 *
 * The field names are the API's, snake_case and verbatim (`SsoStatus` in
 * app/routers/auth.py). Renaming them on the way in is how a probe silently
 * stops working: `undefined === false` is `false`, so the button would stay
 * live forever on a server that cannot sign anybody in. Everything but
 * `google_available` is optional so the API can grow the shape without
 * breaking this client.
 */
interface SsoStatus {
  google_available: boolean;
  password_login_available?: boolean;
  domain?: string | null;
  reason?: string | null;
}

/** Stand-in until the probe tells us the institutional domain. The domain is
 *  configurable server-side, so it is never hard-coded into a message here. */
const DEFAULT_DOMAIN_LABEL = 'your college';

/**
 * Where a signed-in user lands when no `?next=` was carried.
 *
 * MIRRORS `_HOME_FOR_ROLE` in app/routers/auth.py — keep the two in step. The
 * SPA's own `''` route redirects to `/student` UNCONDITIONALLY, so a DIRECTOR
 * sent to `/` bounces off a student-only screen and sees "We couldn't reach
 * your record" on every sign-in. The Google flow never hits that because the
 * server picks the destination before it 302s back; the password flow lands in
 * the browser, so it has to do the same arithmetic here.
 *
 * The server's comment has always claimed to mirror a constant of this name in
 * this file. It was true, then the password form was deleted and took the
 * constant with it, and the reference dangled until this door reopened.
 */
const HOME_FOR_ROLE: Record<string, string> = {
  STUDENT: '/student',
  MENTOR: '/mentor',
  DIRECTOR: '/director',
  ADMIN: '/director',
  ALUMNI: '/alumni',
};
const DEFAULT_HOME = '/student';

/**
 * `?error=` codes the callback redirects with, and what a human should read.
 *
 * THE KEYS ARE THE SERVER'S, `sso_*`-namespaced exactly as the callback
 * docstring in app/routers/auth.py lists them. Each message says what happened
 * and what to do next; none says "invalid" and stops. The one anyone will
 * actually hit is `sso_not_enrolled` — a real Google account that is not on the
 * roster, which is what signing in with a personal Gmail looks like from here.
 *
 * There is deliberately NO wrong-domain message. app/google_auth.py does not use
 * Google's `hd` claim and the server has no code for it: the roster is the
 * allowlist, and app/grant_access.py exists to admit staff whose address is not
 * on the student domain at all. Copy promising a refusal the server cannot emit
 * is a lie a student would act on — the old `wrong_domain` message told people a
 * personal Gmail "cannot sign in here, even if your name is on the roster",
 * when a personal Gmail on the roster signs in perfectly.
 */
function messageFor(code: string, domain: string): string {
  switch (code) {
    case 'sso_not_enrolled':
      return (
        'That Google account is not on the programme roster, so it cannot be ' +
        `signed in. Use your college account — the one ending @${domain}. ` +
        'Access is by roster only; there is no self-registration. If you ' +
        'should be on it, ask the placement office to add you.'
      );
    case 'sso_unverified_email':
      return (
        'Google has not verified the email address on that account, so it ' +
        'cannot be used to prove who you are. Verify it with Google, then try ' +
        'again.'
      );
    case 'sso_denied':
      return (
        'You stopped at the Google screen, so nothing was signed in. Choose ' +
        'Sign in with Google again when you are ready.'
      );
    case 'sso_state':
      return (
        'That sign-in attempt could not be matched to the one this browser ' +
        'started — usually because it sat on the Google screen for more than ' +
        'ten minutes, was finished in a different browser, or this browser ' +
        'blocks cookies. Start again from this page.'
      );
    case 'sso_config':
      return (
        'Google sign-in is not switched on for this server yet, so there is ' +
        'nothing to sign in to. Tell whoever runs the dashboard.'
      );
    case 'sso_token':
      return (
        'Google verified you, but this server could not complete the exchange ' +
        'that finishes sign-in. That is a fault at our end, not yours — try ' +
        'once more, and tell whoever runs the dashboard if it persists.'
      );
    case 'sso_identity':
      return (
        'The identity token Google sent back did not pass verification, so it ' +
        'was refused rather than trusted. Try once more; if it keeps ' +
        'happening, tell whoever runs the dashboard.'
      );
    // Deliberately does NOT say "a different Google account is already linked
    // to this address". That is true, and it is a fact about whoever held the
    // address before — a college re-issues an institutional address to the next
    // intake, so the person reading this may simply be its new holder. A login
    // screen must not hand a stranger the shape of someone else's account. The
    // server logs both Google principals for the operator who has to decide;
    // this says only what the student needs, which is that retrying will not
    // help and one specific office can fix it.
    case 'sso_identity_mismatch':
      return (
        'This Google account does not match the one on file for this email ' +
        'address, so it was refused. Trying again will give the same result. ' +
        'Contact the placement office — they can check who the address belongs ' +
        'to and put it right.'
      );
    case 'sso_failed':
      return (
        'Google could not complete the sign-in and did not say why. Try once ' +
        'more; if it keeps happening, tell whoever runs the dashboard.'
      );
    default:
      // An unknown code is a bug on our side, not the visitor's. Say so
      // plainly, and quote the code so a support message can carry it.
      return (
        'Sign-in did not complete, and the reason given ' +
        `(${code}) is not one this page knows. Try again, and quote that ` +
        'wording if you need to report it.'
      );
  }
}

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
  // Coming BACK from Google with the browser's back button restores this page
  // from the bfcache with its JS state intact — including `pending`, which
  // would leave the only button on the screen inert and mid-sentence. pageshow
  // fires on that restore where a constructor does not.
  host: { '(window:pageshow)': 'onRestored()' },
})
export class LoginComponent {
  private readonly route = inject(ActivatedRoute);

  /** The refusal carried back on the callback redirect, if any. */
  readonly error = signal<string | null>(null);
  /** The raw `?error=` code, kept so the message can be rebuilt once the probe
   *  supplies the real domain (the `sso_not_enrolled` copy names it). */
  private readonly errorCode = signal<string | null>(null);
  /** Set the moment the browser is handed to Google, so the button stops. */
  readonly pending = signal(false);

  /** Fail-open: the button works unless the API positively says it cannot. */
  readonly available = signal(true);
  readonly unavailableReason = signal<string | null>(null);
  readonly domain = signal(DEFAULT_DOMAIN_LABEL);

  /**
   * The developer password door — and it FAILS CLOSED, the opposite of
   * `available` above.
   *
   * That asymmetry is the whole design, so it is worth saying why. A broken
   * probe leaving the Google button live is harmless: the worst case is a
   * student clicking it and getting a refusal from the server. A broken probe
   * conjuring a PASSWORD FORM is not harmless — it is a second door drawn on a
   * production login screen. So this one starts `false` and only ever opens on
   * a positive `password_login_available: true`; a 404, a timeout, a reshaped
   * payload or a `undefined` all leave it shut.
   *
   * The flag is the server's own `settings.password_login_allowed`, which is an
   * ALLOWLIST of dev/CI environment names (`_DEV_ENV_NAMES` in app/config.py),
   * not `not is_prod` — a typo'd `ENV` closes the door rather than opening it.
   * This form therefore cannot appear on prod, staging, uat or demo, and even
   * if someone forced it to render, `POST /api/auth/login` applies the very
   * same guard and answers 403. Two independent locks, one key.
   */
  readonly devLogin = signal(false);
  readonly devEmail = signal('');
  readonly devPassword = signal('');
  readonly devPending = signal(false);
  readonly devError = signal<string | null>(null);

  constructor() {
    const code = this.route.snapshot.queryParamMap.get('error');
    if (code) {
      this.errorCode.set(code);
      this.error.set(messageFor(code, this.domain()));
    }
    void this.probe();
  }

  /// Same-origin paths only. This check is a courtesy — the server re-applies
  /// it when it decides where to send the browser after the callback, because
  /// the value crosses an origin we do not control on the way there.
  private get safeNext(): string | undefined {
    const next = this.route.snapshot.queryParamMap.get('next');
    return next && next.startsWith('/') && !next.startsWith('//') ? next : undefined;
  }

  /// A full-page URL, not a router link: the redirect has to leave the SPA.
  /// `next` rides along as a query parameter because the SPA's own query string
  /// does not survive the hop out to Google and back.
  ///
  /// The CANONICAL route, not the `/auth/google/start` compat alias — that one
  /// is `include_in_schema=False` in app/routers/auth.py and exists for old
  /// bookmarks. Pointing the only button on this screen at it would make the
  /// login screen collateral damage the day the alias is tidied away.
  get signInUrl(): string {
    const start = `${environment.apiBase}/auth/sso/google`;
    const next = this.safeNext;
    return next ? `${start}?next=${encodeURIComponent(next)}` : start;
  }

  get subtitle(): string {
    return this.safeNext
      ? 'Sign in to carry on to the page you asked for.'
      : 'Use the Google account the programme has on record for you.';
  }

  /**
   * Ask the API whether Google sign-in is actually configured.
   *
   * This is the gate `/api/interview/status` and `/api/voice/status` already
   * put in front of their buttons, for the same reason: a live-looking button
   * with no credentials behind it produces exactly the "why is it broken"
   * report this codebase has learned to avoid. It fails OPEN — a probe that
   * 404s (endpoint not deployed), times out, or answers something unexpected
   * leaves the button enabled, because a broken probe must never become the
   * reason nobody can sign in.
   */
  private async probe(): Promise<void> {
    try {
      const res = await fetch(`${environment.apiBase}/auth/sso/status`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const status = (await res.json()) as SsoStatus;
      if (status.domain) {
        this.domain.set(status.domain);
        // Re-render the refusal now the real domain is known: `sso_not_enrolled`
        // is the message that names it, and naming the wrong one sends a
        // student to the wrong account.
        const code = this.errorCode();
        if (code) this.error.set(messageFor(code, status.domain));
      }
      if (status.google_available === false) {
        this.available.set(false);
        this.unavailableReason.set(
          status.reason ||
            'Google sign-in is not configured on this server, so there is no ' +
              'way in yet. Tell whoever runs the dashboard.',
        );
      }
      // Strict `=== true`, matching the `=== false` above and for the same
      // reason the interface keeps these fields optional: `undefined` is not a
      // yes. An older API that has never heard of this field leaves the door
      // shut, which is the correct way for this particular flag to be wrong.
      this.devLogin.set(status.password_login_available === true);
    } catch {
      // Fail open for Google, closed for passwords. See both docstrings above.
    }
  }

  /**
   * Sign in with the seeded credentials — development environments only.
   *
   * This calls the same `POST /api/auth/login` the suite's `login` fixture
   * uses, so it exercises the real endpoint rather than a shortcut around it:
   * the server hashes, compares, mints the identical HS256 session and sets the
   * identical httpOnly `reep_session` cookie. Nothing here sees a token.
   *
   * The redirect is a FULL PAGE LOAD, not a router navigation, and that is
   * deliberate — it is the same cold boot the Google callback produces at step
   * 3, so `authGuard` and `AuthService.refresh()` run exactly one code path for
   * both doors. A `router.navigate` would leave the SPA holding pre-login state
   * and quietly diverge from the flow that actually ships.
   */
  async submitDevLogin(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.devLogin() || this.devPending()) return;

    this.devPending.set(true);
    this.devError.set(null);
    try {
      const res = await fetch(`${environment.apiBase}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: this.devEmail().trim(),
          password: this.devPassword(),
        }),
      });

      if (!res.ok) {
        // 403 is the guard, not a typo, and it is the one message worth
        // distinguishing: it means this build is talking to a server where the
        // password door is shut, so no amount of retyping will help.
        this.devError.set(
          res.status === 403
            ? 'This server refuses password sign-in. Use Google, or point the app at a development API.'
            : res.status === 401
              ? 'That email and password do not match a seeded account.'
              : `Sign-in failed (HTTP ${res.status}).`,
        );
        this.devPending.set(false);
        return;
      }

      // `?next=` wins when present, exactly as the server's callback prefers
      // `flow.next_path`; otherwise land on the role's own home rather than
      // `/`, which redirects to /student for everyone.
      const session = (await res.json()) as { role?: string };
      const home = HOME_FOR_ROLE[session.role ?? ''] ?? DEFAULT_HOME;
      window.location.assign(this.safeNext ?? home);
    } catch {
      this.devError.set('Could not reach the API. Is it running on port 3300?');
      this.devPending.set(false);
    }
  }

  /** Fill the form from the seeded logins in AGENTS.md, so a developer opening
   *  this screen does not have to go and look them up. */
  useSeeded(role: 'student' | 'mentor' | 'director' | 'alumni'): void {
    this.devEmail.set(`${role}@bgscet.ac.in`);
    this.devPassword.set(`${role}123`);
    this.devError.set(null);
  }

  /// Does NOT preventDefault — the anchor's navigation is the whole mechanism.
  /// This only stops the button re-arming while the browser is on its way out.
  beginSignIn(): void {
    if (!this.available()) return;
    this.pending.set(true);
    this.error.set(null);
  }

  /// The page came back into view — from the bfcache, another tab, or the back
  /// button. Whatever it was, we are no longer on our way to Google, so re-arm.
  onRestored(): void {
    this.pending.set(false);
  }
}
