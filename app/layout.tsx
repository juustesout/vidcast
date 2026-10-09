import type { Metadata } from 'next';
import { Inter, IBM_Plex_Mono, Fraunces } from 'next/font/google';

import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-body' });
const ibmPlexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-mono' });
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-display' });

export const metadata: Metadata = {
  title: 'Local Explainer Video Studio',
  description: 'Local-first explainer video compiler foundation.'
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${ibmPlexMono.variable} ${fraunces.variable}`}>
      <body>{children}</body>
    </html>
  );
}
