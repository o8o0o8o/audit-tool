import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Audit Dispatcher',
  description: 'Dispatch audits to GitHub Actions and view their reports',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
        />
      </head>
      <body>
        <header className="site-header">
          <a className="wordmark" href="/">
            Focus Reactive<span className="wordmark-dot">.</span>
          </a>
          <nav className="site-nav">
            <a href="/">New audit</a>
            <a href="/runs">Runs</a>
          </nav>
        </header>
        <div className="page">{children}</div>
      </body>
    </html>
  );
}
