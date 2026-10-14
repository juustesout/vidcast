import type { Metadata } from 'next';

import { SessionBootstrap } from '@/components/session/session-bootstrap';
import { getServerIdentity } from '@/lib/security/server-identity';

import './globals.css';

export const metadata: Metadata = {
  title: 'Local Explainer Video Studio',
  description: 'Local-first explainer video compiler foundation.'
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const identity = await getServerIdentity();

  return (
    <html lang="en">
      <body>
        <SessionBootstrap authenticated={Boolean(identity)} />
        {children}
      </body>
    </html>
  );
}
