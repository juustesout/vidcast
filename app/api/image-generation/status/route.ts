import { NextResponse } from 'next/server';

import { getImageGenerationConfigurationStatus } from '@/lib/ai/image-generation/registry';
import { AccessControlError, requireIdentity } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';

export async function GET(request: Request) {
  try {
    requireIdentity(request);
    const status = getImageGenerationConfigurationStatus();
    return NextResponse.json({
      defaultProvider: status.defaultProvider,
      model: status.model
    });
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected authentication failure.', code: 'auth.unexpected' }, { status: 500 });
  }
}
