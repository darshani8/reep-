import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE } from '@/lib/session-shared';

/**
 * Edge-safe gate. It only checks that a session cookie is *present* — the
 * signature check and the role check happen in the server components, which can
 * reach Prisma. Keeping the crypto out of middleware avoids pulling the auth
 * module (and `server-only`) into the Edge bundle.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
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
  matcher: ['/student/:path*', '/mentor/:path*', '/director/:path*'],
};
