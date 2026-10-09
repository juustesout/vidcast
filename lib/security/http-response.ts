import { NextResponse } from 'next/server';

import { AccessControlError } from './access-control';

export function toAccessControlResponse(error: AccessControlError): NextResponse {
  if (error.code === 'RATE_LIMITED') {
    return NextResponse.json(
      {
        message: error.message,
        code: error.code,
        details: error.details
      },
      {
        status: error.status,
        headers: typeof error.details?.retryAfterSec === 'number'
          ? { 'Retry-After': String(error.details.retryAfterSec) }
          : undefined
      }
    );
  }

  return NextResponse.json(
    {
      message: error.message,
      code: error.code
    },
    { status: error.status }
  );
}
