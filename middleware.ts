import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { SESSION_COOKIE_NAME } from '@/lib/security/constants';

/**
 * Central defense-in-depth gate for page routes. It only checks for the
 * presence of an identity carrier; real authentication and project ownership
 * are always enforced in the page data layer (`lib/security/page-access.ts`)
 * and the API routes. It must never be the only authorization boundary.
 */
export function middleware(request: NextRequest) {
  const hasSession = request.cookies.has(SESSION_COOKIE_NAME);
  const hasAuthorization = request.headers.has('authorization');

  if (!hasSession && !hasAuthorization) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/projects', '/projects/:path*']
};
