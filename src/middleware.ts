import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE } from '@/lib/session-shared';

/**
 * Edge-safe gate. It only checks that a session cookie is *present* — the
 * signature check and the role check happen in the server components, which can
 * reach Prisma. Keeping the crypto out of middleware avoids pulling the auth
 * module (and `server-only`) into the Edge bundle.
 *
 * Next 16 renamed this convention to `proxy.ts`; the file still runs under its
 * old name and the rename is left as its own change rather than folded into a
 * feature branch, because getting it wrong unguards every route at once.
 */

/// Sign-in screens that live *under* a guarded prefix. The matcher below keeps
/// them out too, so this is the belt to that pair of braces: matcher patterns
/// are static strings that no test exercises, and a redirect loop on the sign-in
/// page is the one failure a user cannot work around.
const PUBLIC_PATHS = new Set(['/mentor/login']);

/**
 * Whole prefixes that belong to people who have no session and never will.
 *
 * Registration is the first unauthenticated *write* surface this app has had.
 * Everything else here is a signed-in user being sent to the right place; an
 * applicant filling in `/register`, or the browser POSTing their CV to
 * `/api/register/cv`, has no cookie by definition, so a redirect to `/login`
 * is the same trap `PUBLIC_PATHS` exists to avoid — and a worse one, because
 * there is no account to sign in with.
 *
 * These already sit outside every prefix in `matcher`. This is the belt to that
 * pair of braces, for the same reason the line above it is: matcher entries are
 * static strings no test exercises, and the direction they tend to grow in is a
 * single catch-all with negative lookaheads. The day someone writes one, the
 * signup form disappearing behind a login wall should not be the way we find
 * out.
 *
 * `/director/registrations` is deliberately absent. Reading other people's
 * applications is staff work and stays behind the cookie; only the applicant's
 * own path is public.
 */
const PUBLIC_PREFIXES = ['/register', '/api/register'];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Exact match or a real path segment, so a future `/registers-of-interest`
  // does not inherit the exemption by string prefix alone.
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const hasSession = request.cookies.has(SESSION_COOKIE);

  if (!hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // `/mentor/login` is deliberately not matched. It is a sign-in page inside a
  // guarded prefix, so matching `/mentor/:path*` would redirect it to `/login`
  // before it could render — the loop being: you are not signed in, so you may
  // not see the page that signs you in. `/mentor` itself is listed separately
  // because the exclusion pattern only covers what comes after the slash.
  //
  // Nothing here is a security boundary. Every page under these prefixes calls
  // `requireSession()` / `requireMentor()` for itself, so an over-broad
  // exclusion costs a redirect, not access.
  //
  // `/register`, `/register/*` and `/api/register/*` are excluded by not being
  // listed: this is an allowlist of guarded prefixes, not a blocklist. See
  // `PUBLIC_PREFIXES` above for why they are also named explicitly in the
  // function — anyone replacing these entries with a catch-all needs to carry
  // that exclusion across with them.
  matcher: [
    '/student/:path*',
    '/mentor',
    '/mentor/((?!login$).*)',
    '/director/:path*',
  ],
};
