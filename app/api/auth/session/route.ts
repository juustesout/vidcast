import { NextResponse } from 'next/server';

import { createUserSessionCookie, generateUserSubject, getRequestIdentity, SESSION_COOKIE_NAME } from '@/lib/security/auth';
import { isAnonymousSessionAllowed } from '@/lib/security/config';
import { projectStore } from '@/lib/storage/project-store';

export async function POST(request: Request) {
  const existing = getRequestIdentity(request);
  if (existing) {
    return NextResponse.json({ authenticated: true, subject: existing.subject, kind: existing.kind }, { status: 200 });
  }

  // A browser identity is always server-generated. The request body is never
  // read, so a client cannot choose its own subject. Anonymous identities are
  // only available in an explicitly local (non-production) mode.
  if (!isAnonymousSessionAllowed()) {
    return NextResponse.json(
      {
        message: 'Anonymous session issuance is disabled. Configure an authenticated identity provider.',
        code: 'AUTH_SESSION_DISABLED'
      },
      { status: 403 }
    );
  }

  const subject = generateUserSubject();
  const cookieValue = createUserSessionCookie(subject);
  await projectStore.claimUnownedProjects(subject);

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
