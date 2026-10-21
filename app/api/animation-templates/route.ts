import { NextResponse } from 'next/server';

import { listAnimationTemplateSummaries } from '@/lib/animation/catalog';
import { AccessControlError, requireIdentity } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';

export async function GET(request: Request) {
  try {
    requireIdentity(request);
    return NextResponse.json({ templates: listAnimationTemplateSummaries() });
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected authentication failure.', code: 'auth.unexpected' }, { status: 500 });
  }
}
