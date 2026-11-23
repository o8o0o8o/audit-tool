import type { ReactNode } from 'react';

import { SiteFooter } from './components/SiteFooter';
import { SiteHeader } from './components/SiteHeader';
import './fr-ui.css';
import './globals.css';

export const metadata = {
  title: 'Website Audit | FocusReactive',
  description: 'Check a website for SEO, performance, accessibility, security and UX problems',
};

// Same shell as focusreactive.com (src/_layouts/redesignPage.njk): main-wrapper > header, main, footer.
// UI styles and assets come from that site via scripts/sync-fr-ui.mjs; favicon is app/favicon.ico.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {['SemiBold', 'Regular', 'Medium'].map((face) => (
          <link
            key={face}
            rel="preload"
            href={`/assets/fonts/InterDisplay-${face}.subset.woff2`}
            as="font"
            type="font/woff2"
            crossOrigin=""
          />
        ))}
      </head>
      <body>
        <div className="main-wrapper">
          <SiteHeader />
          <main className="main">{children}</main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}
