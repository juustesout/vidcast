'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface SessionBootstrapProps {
  authenticated: boolean;
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
      try {
        const response = await fetch('/api/auth/session', { method: 'POST' });
        if (!cancelled && response.status === 201) {
          router.refresh();
        }
      } catch {
        // Keep protected content hidden while no session can be established.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authenticated, router]);

  return null;
}
