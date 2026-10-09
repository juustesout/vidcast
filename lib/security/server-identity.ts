import { headers } from 'next/headers';

import { getIdentityFromHeaders, type RequestIdentity } from './auth';

/**
 * Resolves the identity for a server-rendered page from the incoming request
 * headers. Unlike `getRequestIdentity` this does not accept a `Request` object,
 * so it can be used from React Server Components.
 */
export async function getServerIdentity(): Promise<RequestIdentity | null> {
  const headerList = await headers();
  return getIdentityFromHeaders(headerList.get('cookie'), headerList.get('authorization'));
}
