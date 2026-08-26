/**
 * Runtime configuration. `apiBase` is where the FastAPI backend answers — the
 * Python backend (apps/api-py) that took over Prisma, auth and the domain logic,
 * so the Angular client is purely the UI calling it over HTTP.
 */
export const environment = {
  production: false,
  /// The FastAPI API runs on 3300 (uvicorn). The dev proxy (proxy.conf.json)
  /// forwards /api -> http://localhost:3300 so this stays same-origin in the
  /// browser and the http-only session cookie is carried without CORS friction.
  apiBase: '/api',
  /// Sentry — the single observability + traceability tool, mirroring the
  /// API's SENTRY_DSN. Blank = the SDK is never even DOWNLOADED (main.ts
  /// dynamic-imports it only when this is set), so dev builds and the initial
  /// bundle pay nothing. Set per deployment at build time.
  sentryDsn: '',
};
