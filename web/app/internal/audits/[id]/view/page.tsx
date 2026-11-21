import { redirect } from 'next/navigation';
import { internalPrincipal } from '../../../../../lib/server';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Audit report | FocusReactive' };

/**
 * An audit's HTML report inside the site shell (header and footer from the root layout). The report
 * itself loads through /internal/audits/<id>/report → a fresh /r/<token> link, served sandboxed, so it
 * keeps its own scripts and tabs and scrolls inside a frame one screen high.
 */
export default async function ReportView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await internalPrincipal())) redirect(`/internal/login?next=/internal/audits/${id}/view`);
  const src = `/internal/audits/${id}/report`;
  return (
    <section className="report-page">
      <div className="container">
        <p className="report-page-bar">
          <a className="link-accent" href={`/internal/audits/${id}`}>
            Audit details
          </a>
          <a className="link-accent" href={src} target="_blank" rel="noreferrer">
            Report only
          </a>
        </p>
        <iframe
          className="report-page-frame"
          data-testid="report-page-frame"
          src={`${src}?embed=1`}
          title="Audit report"
        />
      </div>
    </section>
  );
}
