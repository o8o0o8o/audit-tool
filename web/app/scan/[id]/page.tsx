import { notFound } from 'next/navigation';
import { publicScanView } from '../../../lib/core/public';
import { makeReportToken } from '../../../lib/core/reports';
import { secretFromEnv } from '../../../lib/core/tokens';
import { ctx } from '../../../lib/server';
import { ScanProgress } from './ScanProgress';

export const dynamic = 'force-dynamic';
/** Reachable only by its id, and never indexed (design §7). */
export const metadata = { title: 'Website Audit | FocusReactive', robots: { index: false, follow: false } };

const REMOVAL = process.env.PUBLIC_CONTACT_EMAIL
  ? `mailto:${process.env.PUBLIC_CONTACT_EMAIL}?subject=${encodeURIComponent('Remove my site from the website audit')}`
  : 'https://focusreactive.com/#contacts';

/**
 * The result of one public scan: progress while it runs, then the full report of that scan. Only
 * audits the public site started exist here; any other id is "not found". The report opens through
 * a link made for this audit that works for an hour; every load of the page makes a new one.
 */
export default async function ScanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await publicScanView(ctx().db, id);
  if (!view) notFound();
  const what = view.mode === 'page' ? 'Single page' : 'Quick scan';
  return (
    <section className="section">
      <div className="container">
        <h1 className="section__title section__title--sm">Website Audit</h1>
        <p className="muted run-details">
          {what} of {view.target} · started {view.created_at.slice(0, 16).replace('T', ' ')} UTC
        </p>
        {view.status === 'running' && <ScanProgress auditId={view.audit_id} initial={view} />}
        {view.status === 'failed' && (
          <div className="card" data-testid="scan-failed">
            <h2>The scan did not finish</h2>
            <p>
              The site may have refused the scan, or something went wrong on our side.{' '}
              <a className="link-accent" href="/">
                Start another scan
              </a>
            </p>
          </div>
        )}
      </div>
      {view.status === 'succeeded' && (
        <iframe
          title={`Audit report of ${view.target}`}
          data-testid="scan-report"
          src={`/r/${makeReportToken(view.audit_id, secretFromEnv('REPORT_TOKEN_SECRET'))}/report.html`}
          style={{ display: 'block', width: '100%', height: '100vh', border: 0, marginTop: 24 }}
        />
      )}
      <div className="container">
        <p className="muted run-details">
          <a className="link-accent" href="/">
            Scan another site
          </a>{' '}
          ·{' '}
          <a className="link-accent" href={REMOVAL}>
            Own this site? Ask us to delete this data
          </a>
        </p>
      </div>
    </section>
  );
}
