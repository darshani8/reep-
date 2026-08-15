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
};
