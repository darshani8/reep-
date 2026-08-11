import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import InitColorSchemeScript from '@mui/material/InitColorSchemeScript';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v16-appRouter';

import { Providers } from '@/components/providers';

/// Humanist proportions and a tall x-height: reads plain-spoken at the 12–13px
/// this dashboard needs, without the corporate flatness of a geometric sans.
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'REEP — BGSCET MBA',
  description:
    'Student journey, time usage, faculty mentor focus tracking and cohort analytics for the Reboot · Excel · Elevate Programme.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The browser chrome around the page, so it matches CREAM.page rather than
  // framing a cream document in a white bar.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#efe9dd' },
    { media: '(prefers-color-scheme: dark)', color: '#14120d' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body>
        {/* Stamps the saved colour scheme before first paint, so a dark-mode
            reader never gets a white flash on navigation. */}
        <InitColorSchemeScript attribute="data-theme" defaultMode="light" />
        <AppRouterCacheProvider options={{ key: 'mui' }}>
          <Providers>{children}</Providers>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
