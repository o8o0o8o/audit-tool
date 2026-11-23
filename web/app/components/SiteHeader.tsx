'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { FR_ORIGIN, SOCIALS } from './site-links';

// Markup and classes copied from focusreactive.com-front src/_includes/_header.html; the sticky
// header and burger menu follow initStickyHeader() in src/jsNew/blocks/navigation.js.
// `tool` items are the internal app's own pages; they are shown only inside /internal.
const NAV: { title: string; href: string; tool?: boolean }[] = [
  { title: 'New audit', href: '/internal', tool: true },
  { title: 'Runs', href: '/internal/runs', tool: true },
  { title: 'API keys', href: '/internal/keys', tool: true },
  { title: 'Usage', href: '/internal/usage', tool: true },
  { title: 'Set up MCP', href: '/internal/mcp', tool: true },
  { title: 'Services', href: `${FR_ORIGIN}/services/` },
  { title: 'Solutions', href: `${FR_ORIGIN}/solutions/` },
  { title: 'Portfolio', href: `${FR_ORIGIN}/portfolio/` },
  { title: 'About', href: `${FR_ORIGIN}/about/` },
  { title: 'Blog', href: `${FR_ORIGIN}/blog/` },
];
const CONTACT = { title: 'Contact Us', href: `${FR_ORIGIN}/#contacts` };

function RollText({ text }: { text: string }) {
  return (
    <span className="roll__box">
      <span data-text={text}>{text}</span>
    </span>
  );
}

function isCurrent(pathname: string, href: string): boolean {
  return href === '/' || href === '/internal'
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteHeader() {
  const pathname = usePathname();
  const [sticky, setSticky] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setSticky(window.scrollY > 0);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('no-scroll', open);
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Close the mobile menu after client-side navigation.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <header className={`header${sticky ? ' is-sticky' : ''}`} role="banner">
      <div className="header__container container">
        <a href={`${FR_ORIGIN}/`} className="header__logo" aria-label="Focus Reactive">
          <img src="/assets/img/fr-logo.svg" alt="Focus Reactive logo" width={160} height={55} />
        </a>

        <nav className={`header__nav${open ? ' is-open' : ''}`} role="navigation">
          <ul className="header__nav-list">
            {NAV.filter((item) => !item.tool || pathname.startsWith('/internal')).map((item) => (
              <li
                key={item.href}
                className={`header__nav-item${item.tool && isCurrent(pathname, item.href) ? ' header__nav-item--current' : ''}`}
              >
                <a
                  href={item.href}
                  className="header__nav-link roll roll--md-none"
                  aria-current={item.tool && isCurrent(pathname, item.href) ? 'page' : undefined}
                >
                  <RollText text={item.title} />
                </a>
              </li>
            ))}
            <li className="header__nav-item visible-md">
              <a href={CONTACT.href} className="header__nav-link roll roll--md-none">
                <RollText text={CONTACT.title} />
              </a>
            </li>
          </ul>
          <ul className="social-list visible-md">
            {SOCIALS.map((s) => (
              <li key={s.href} className="social-list__item">
                <a href={s.href} className="social-list__link" aria-label={s.title} target="_blank" rel="noreferrer">
                  <span className="social-list__icon-box">
                    <img src={s.icon} alt="" aria-hidden="true" className="social-list__icon social-list__icon--top" />
                    <img src={s.icon} alt="" aria-hidden="true" className="social-list__icon" />
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="header__btn hidden-md">
          <a href={CONTACT.href} className="btn roll">
            <RollText text={CONTACT.title} />
          </a>
        </div>

        <button
          type="button"
          className={`hamburger visible-md${open ? ' is-active' : ''}`}
          aria-label={open ? 'Close main menu' : 'Open main menu'}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="hamburger__line" />
          <span className="hamburger__line" />
        </button>
      </div>
    </header>
  );
}
