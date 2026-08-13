/**
 * Runtime configuration. `apiBase` is where the NestJS backend answers — the
 * backend that took over Prisma, auth and the domain logic from the Next.js
 * server, so the Angular client is purely the UI calling it over HTTP.
 */
export const environment = {
  production: false,
  /// The NestJS API. It runs on 3200 by default (see apps/api); the dev proxy
  /// can also forward /api to it so this stays same-origin in the browser.
  apiBase: '/api',
};
