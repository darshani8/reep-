import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { environment } from './environments/environment';

/**
 * Sentry (one tool for observability + traceability, same as the API). A
 * DYNAMIC import on purpose: with no DSN configured the SDK is never fetched,
 * so the initial bundle and every non-telemetry deployment stay exactly as
 * they were. Errors and page/route traces land in the same Sentry org as the
 * API's, where the API tags every request with the X-Request-ID the SPA can
 * read off any response — one id from a click to a backend log line.
 */
if (environment.sentryDsn) {
  void import('@sentry/angular').then((Sentry) => {
    Sentry.init({
      dsn: environment.sentryDsn,
      environment: environment.production ? 'production' : 'development',
      tracesSampleRate: 0.2,
      sendDefaultPii: false,
    });
  });
}

/**
 * Reveal the icon font only once it has actually loaded.
 *
 * Material Symbols draws its glyphs from LIGATURES: the markup says
 * `<span class="icon">chevron_left</span>` and the font turns that text into an
 * arrow. When the font does not arrive — a blocked or slow font host, an offline
 * client, a strict CSP — the browser renders the ligature text instead, and every
 * icon in the product becomes the literal word "chevron_left", "school",
 * "task_alt". Buttons stretch, the sidebar wraps, and the UI reads as broken
 * rather than as degraded.
 *
 * `.icon { visibility: hidden }` in reep-v2.scss is the default; this adds
 * `fonts-ready` to <html> only when the font is genuinely available, so a failed
 * load leaves a blank space where a glyph would be. Every icon in this app is
 * decorative (aria-hidden) and sits beside a real text label, so a missing glyph
 * costs nothing while a stray word costs the layout.
 *
 * Three ways out, in order: the font reports itself loaded; the Font Loading API
 * is missing entirely (very old browser — reveal, since we cannot tell); or the
 * check has not resolved within a second and `document.fonts.check` says the face
 * is there anyway. If the font truly never loads, the class is never added.
 */
const ICON_FACE = '24px "Material Symbols Rounded"';

function revealIcons(): void {
  document.documentElement.classList.add('fonts-ready');
}

if (!('fonts' in document)) {
  revealIcons();
} else {
  document.fonts
    .load(ICON_FACE)
    .then((faces) => {
      // The FACE STATUS, not document.fonts.check(). `check()` answers "can I
      // render this text?", and a browser that has fallen back to a system font
      // answers yes — which is exactly the broken case, so check() reveals the
      // ligature words it was added to hide. `load()` resolves with the matched
      // FontFace objects, and a face that failed to fetch is 'error', never
      // 'loaded'.
      if (faces.some((face) => face.status === 'loaded')) revealIcons();
    })
    .catch(() => {
      /* Blocked or failed: leave the icons hidden rather than showing ligature
         text. Nothing else on the page depends on this resolving. */
    });
}

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
