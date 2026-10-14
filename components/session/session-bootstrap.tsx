'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface SessionBootstrapProps {
  authenticated: boolean;
}

let sessionRequest: Promise<number> | null = null;

export function ensureAnonymousSession(): Promise<number> {
  if (!sessionRequest) {
    sessionRequest = fetch('/api/auth/session', { method: 'POST' })
      .then((response) => response.status)
      .catch(() => {
        sessionRequest = null;
        return 0;
      });
  }

  return sessionRequest;
}

/**
 * Bootstraps a local (non-production) anonymous session when the request has no
 * identity yet, then refreshes the server-rendered tree. In production no
 * anonymous session is issued, so the protected server-rendered content simply
 * stays hidden until a real identity provider is configured.
 */
export function SessionBootstrap({ authenticated }: SessionBootstrapProps) {
  const router = useRouter();

  useEffect(() => {
    if (authenticated) {
      return;
    }

    let cancelled = false;

    void (async () => {
      const status = await ensureAnonymousSession();
      if (!cancelled && status === 201) {
        router.refresh();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authenticated, router]);

  return null;
}
