import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import './simple.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'StillHere — Be there for someone.',
  description:
    'Free community companionship for your journey, with human guardians, thoughtful handoffs, and verifiable contributions.',
  robots: { index: false, follow: false },
  metadataBase: new URL(
    process.env.SITE_ORIGIN ||
      'https://safety-guard-htn2026.klavander56.chatgpt.site',
  ),
  openGraph: {
    title: 'StillHere',
    description: 'Be there for someone. Free community companionship and verifiable contributions.',
    images: [
      {
        url: '/og.png',
        width: 1733,
        height: 908,
        alt: 'StillHere — Be there for someone. Community companionship that carries forward.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'StillHere',
    description: 'Be there for someone. Free community companionship and verifiable contributions.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
