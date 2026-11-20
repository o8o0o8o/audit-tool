import { notFound } from 'next/navigation';

import { isValidRunId } from '../../../../lib/audit-options';
import { isReportPath, viewHref } from '../../../../lib/audit-progress';

export const metadata = { title: 'Audit report | FocusReactive' };

// A run's HTML report inside the site shell (header and footer from the root layout).
// The report itself still comes from /view/…, which serves it sandboxed, so it keeps
// its own scripts, tabs and in-page links; it scrolls inside a frame one screen high.
export default async function ReportPage({ params }: { params: Promise<{ runId: string; path: string[] }> }) {
  const { runId, path } = await params;
  if (!isValidRunId(runId) || !isReportPath(path)) notFound();
  const name = path.join('/');
  const src = viewHref(runId, name);
  return (
    <section className="report-page">
      <div className="container">
        <p className="report-page-bar">
          <span className="muted">{name}</span>
          <a className="link-accent" href={`/runs/${runId}`}>
            Run details
          </a>
          <a className="link-accent" href={src} target="_blank" rel="noreferrer">
            Report only
          </a>
        </p>
        <iframe
          className="report-page-frame"
          data-testid="report-page-frame"
          src={src}
          title={`Audit report ${name}`}
        />
      </div>
    </section>
  );
}
