import { NextResponse, type NextRequest } from 'next/server';

/**
 * Redirects only (§1 rule 1): every page under /internal needs the session cookie to be present.
 * The cookie is verified by lib/core on every call; this never decides access by itself.
 */
export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (
    pathname.startsWith('/internal') &&
    !pathname.startsWith('/internal/login') &&
    pathname !== '/internal/shell' &&
    !request.cookies.get('audit_session')
  ) {
    const url = new URL('/internal/login', request.url);
    url.searchParams.set('next', pathname + search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/internal/:path*'] };
