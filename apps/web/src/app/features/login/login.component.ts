/**
 * Sign in — Google only.
 *
 * There is one way into REEP: a college Google account that is already on the
 * programme roster. The email/password form this screen used to carry is gone
 * from the UI; `POST /api/auth/login` still exists on the API, but only as a
 * dev/CI affordance that production refuses, and nothing here calls it.
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
    } catch {
      // Fail open, deliberately. See the docstring above.
    }
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
