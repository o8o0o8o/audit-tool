import { redirect } from 'next/navigation';
import { botCheckConfigured, publicScansOpen } from '../lib/core/public';
import { PublicScanForm } from './components/PublicScanForm';

export const dynamic = 'force-dynamic';

/**
 * The public site (design §7): a quick scan or a single-page audit, no options. While it is not
 * switched on (`PUBLIC_SCANS=on`, or the bot check's keys) `/` leads to the internal app.
 */
export default function PublicPage() {
  if (!publicScansOpen()) redirect('/internal');
  return (
    <section className="section contacts" aria-labelledby="scan-heading">
      <div className="container">
        <div className="contacts__wrap">
          <div className="contacts__wrap-left">
            <div className="contacts__header">
              <h1 className="section__title section__title--sm" id="scan-heading">
                Website Audit
              </h1>
              <p className="contacts__text">
                Checks a website for SEO, performance, accessibility, security and UX problems. The scan only reads
                pages the site publishes, and the report opens here when it is done.
              </p>
            </div>
            <ul className="contacts__list list-arrow">
              <li>Up to 25 pages, or one page</li>
              <li>Prioritised findings with examples</li>
              <li>Free, no account needed</li>
            </ul>
          </div>
          <div className="contacts__wrap-right">
            <PublicScanForm siteKey={botCheckConfigured() ? process.env.TURNSTILE_SITE_KEY! : null} />
          </div>
        </div>
      </div>
    </section>
  );
}
