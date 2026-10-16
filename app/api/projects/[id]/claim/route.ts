import { NextResponse } from 'next/server';

import { AccessControlError, requireIdentity } from '@/lib/security/access-control';
import { hashClaimToken } from '@/lib/security/claim-token';
import { toAccessControlResponse } from '@/lib/security/http-response';
import { projectStore } from '@/lib/storage/project-store';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Redeems a single-use claim capability, transferring a service-created
 * (ownerless) project to the authenticated browser user.
 *
 * The token is supplied in the request body, never in the URL, so it cannot
 * leak through access logs, referrers or history. A service token is rejected:
 * ownership is always bound to a browser session subject.
 */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const identity = requireIdentity(request);
    if (identity.kind !== 'user') {
      throw new AccessControlError('A browser session is required to claim a project.', 'FORBIDDEN', 403);
    }

    const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
    const token = body && typeof body === 'object' && typeof body.token === 'string' ? body.token : '';
    if (!token) {
      throw new AccessControlError('Claim token is required.', 'FORBIDDEN', 403);
    }

    const result = await projectStore.redeemClaim(id, identity.subject, hashClaimToken(token));

    switch (result.status) {
      case 'claimed':
        return NextResponse.json({ project: result.project });
      case 'already_owned':
        return NextResponse.json({ message: 'Project has already been claimed.', code: 'claim.alreadyClaimed' }, { status: 409 });
      case 'not_found':
        throw new AccessControlError('Project not found.', 'NOT_FOUND', 404);
      case 'invalid':
      default:
        throw new AccessControlError('Claim token is invalid or has expired.', 'FORBIDDEN', 403);
    }
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected project claim failure.', code: 'project.unexpected' }, { status: 500 });
  }
}
