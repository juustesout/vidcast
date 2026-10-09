import { NextResponse } from 'next/server';

import { createUserSessionCookie, getRequestIdentity, SESSION_COOKIE_NAME } from '@/lib/security/auth';

export async function POST(request: Request) {
  const existing = getRequestIdentity(request);
  if (existing) {
    return NextResponse.json({ authenticated: true, subject: existing.subject, kind: existing.kind }, { status: 200 });
  }

  const cookieValue = createUserSessionCookie();
  const maxAgeSec = Math.max(60, Number.parseInt(process.env.EXPLAINER_SESSION_MAX_AGE_SEC ?? '', 10) || 30 * 24 * 60 * 60);
  const secureFlag = request.url.startsWith('https://') ? '; Secure' : '';

  const response = NextResponse.json({ authenticated: true, kind: 'user' }, { status: 201 });
  response.headers.append('Set-Cookie', `${SESSION_COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=${maxAgeSec}`);
  return response;
}

export async function GET(request: Request) {
  const identity = getRequestIdentity(request);
  if (!identity) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  return NextResponse.json({ authenticated: true, subject: identity.subject, kind: identity.kind }, { status: 200 });
}
