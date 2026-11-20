import { FR_ORIGIN, SOCIALS } from './site-links';

// Markup and classes copied from focusreactive.com-front src/_includes/_footer.html, with the
// menu, addresses and copyright as the live site renders them from its CMS.
const FOOTER_NAV = [
  {
    title: 'Company',
    links: [
      { title: 'About', href: `${FR_ORIGIN}/about/` },
      { title: 'Portfolio', href: `${FR_ORIGIN}/portfolio/` },
      { title: 'Blog', href: `${FR_ORIGIN}/blog/` },
      { title: 'Careers', href: 'https://careers.smartrecruiters.com/FocusReactive', external: true },
      { title: 'Contact Us', href: `${FR_ORIGIN}/#contacts` },
    ],
  },
  {
    title: 'Services',
    links: [
      { title: 'Headless CMS Agency', href: `${FR_ORIGIN}/services/headless-cms-expert-agency/` },
      { title: 'Headless eCommerce', href: `${FR_ORIGIN}/headless-ecommerce-expert-agency/` },
      { title: 'Next.JS Development', href: `${FR_ORIGIN}/next-js-expert-agency/` },
      { title: 'CMS Migrations', href: `${FR_ORIGIN}/cms-migration-services/` },
      { title: 'Web Design & Modernization', href: `${FR_ORIGIN}/services/headless-website-design/` },
    ],
  },
];

const ADDRESSES = [
  { city: 'Amsterdam', text: 'Keurenplein 41, 1069CD', phone: '+ 31 97 010283044', tel: '+3197010283044' },
  { city: 'London', text: '124 City Road, EC1V 2NX', phone: '+ 44 20 37697253', tel: '+442037697253' },
  { city: 'Warsaw', text: 'Czackiego 15/17, 00-043', phone: '+ 48 22 1530567', tel: '+48221530567' },
  { city: 'New York', text: '600 Lexington Avenue', phone: '+1 (415) 676-0487', tel: '+14156760487' },
];

export function SiteFooter() {
  return (
    <footer className="footer" role="contentinfo">
      <div className="container">
        <div className="footer__top">
          <div className="footer__top-item footer__top-logo">
            <div className="footer__logo">
              <img src="/assets/img/fr-logo-footer.svg" alt="Focus Reactive logo" width={716} height={244} />
            </div>
          </div>
          <div className="footer__top-item footer__top-nav">
            {FOOTER_NAV.map((group) => (
              <div key={group.title} className="footer__nav-item">
                <h2 className="footer__title">{group.title}</h2>
                <ul className="footer__list">
                  {group.links.map((link) => (
                    <li key={link.href} className="footer__list-item">
                      <a
                        href={link.href}
                        className="footer__list-link"
                        {...('external' in link ? { target: '_blank', rel: 'noreferrer' } : {})}
                      >
                        {link.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="footer__top-item footer__top-description">
            <p className="footer__description">We build Composable Content Systems. Fast and Scalable.</p>
          </div>
          <div className="footer__top-item footer__top-social">
            <ul className="social-list">
              {SOCIALS.map((s) => (
                <li key={s.href} className="social-list__item">
                  <a href={s.href} className="social-list__link" aria-label={s.title} target="_blank" rel="noreferrer">
                    <span className="social-list__icon-box">
                      <img
                        src={s.icon}
                        alt=""
                        aria-hidden="true"
                        width={18}
                        height={18}
                        className="social-list__icon social-list__icon--top"
                      />
                      <img
                        src={s.icon}
                        alt=""
                        aria-hidden="true"
                        width={18}
                        height={18}
                        className="social-list__icon"
                      />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div className="footer__addresses">
            {ADDRESSES.map((a) => (
              <div key={a.city} className="footer__address-item">
                <div className="footer__address-city">{a.city}</div>
                <div className="footer__address-text">{a.text}</div>
                <a href={`tel:${a.tel}`} className="footer__address-phone">
                  {a.phone}
                </a>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="footer__bottom">
        <div className="container">
          <div className="footer__bottom-row">
            <div className="footer__bottom-info">
              <div className="copyright">© {new Date().getFullYear()} Focus Reactive BV (The Netherlands)</div>
            </div>
            <a
              className="footer__clutch-widget"
              href="https://clutch.co/profile/focusreactive"
              target="_blank"
              rel="noopener noreferrer"
            >
              <img src="/assets/img/clutch.svg" alt="Clutch Reviews" width={75} height={40} />
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
