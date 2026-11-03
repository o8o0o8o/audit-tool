import type { ReactNode } from 'react';

export const metadata = {
  title: 'SEO Audit Dispatcher',
  description: 'Dispatch SEO audits to GitHub Actions and view their reports',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 760, margin: '0 auto', padding: '24px 16px' }}>
        <nav style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
          <a href="/">New audit</a>
          <a href="/runs">Runs</a>
        </nav>
        {children}
      </body>
    </html>
  );
}
