import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Safety Guard — Go together. Get home.',
  description:
    'A community journey companion with human guardians, signed relays, and verifiable contributions.',
  robots: { index: false, follow: false },
  metadataBase: new URL(
    process.env.SITE_ORIGIN ||
      'https://safety-guard-htn2026.klavander56.chatgpt.site',
  ),
  openGraph: {
    title: 'Safety Guard',
    description: 'Go together. Get home. Human care. Verifiable contributions.',
    images: [
      {
        url: '/og.png',
        width: 1734,
        height: 907,
        alt: 'Safety Guard — Go together. Get home. A glass shield with a chrome orbit and green community figures.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Safety Guard',
    description: 'Go together. Get home. Human care. Verifiable contributions.',
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
