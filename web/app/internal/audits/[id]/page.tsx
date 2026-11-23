import { notFound, redirect } from 'next/navigation';
import { McpHint } from '../../../components/McpHint';
import { getAudit } from '../../../../lib/core/audits';
import { CoreError } from '../../../../lib/core/errors';
import { ctx, internalPrincipal } from '../../../../lib/server';
import { RunActions } from './run-actions';

export const dynamic = 'force-dynamic';

const LABELS: Record<string, string> = {
  report_html: 'HTML report',
  report_md: 'Report (Markdown)',
  report_pdf: 'Report (PDF)',
  report_verified_md: 'Verified report (Markdown)',
  report_verified_pdf: 'Verified report (PDF)',
  content_research_md: 'Content research (Markdown)',
  content_research_pdf: 'Content research (PDF)',
  teaser_md: 'Teaser (Markdown)',
  teaser_pdf: 'Teaser (PDF)',
  raw_archive: 'Raw run archive',
  gate_evidence: 'Gate evidence',
};

export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await internalPrincipal();
  if (!principal) redirect(`/internal/login?next=/internal/audits/${id}`);
  let a;
  try {
    a = await getAudit(ctx().db, principal, id);
  } catch (err) {
    if (err instanceof CoreError && err.code === 'not_found') notFound();
    throw err;
  }
  const active = !['succeeded', 'failed', 'cancelled'].includes(a.status);
  // The HTML report has its own button below (rendered on view), so it is not listed as a file.
  const reports = a.artifacts.filter((f) => f.kind !== 'gate_evidence' && f.kind !== 'report_html');
  return (
    <section className="section">
      <div className="container">
        <h1 className="section__title section__title--sm">Audit</h1>
        <McpHint text="You can also read this audit's findings and summary from your AI assistant." />
        <div className="run-details">
          <p className="muted">{a.audit_id}</p>
          <p data-testid="run-status">
            Status: {a.status}
            {a.phase && active ? ` · ${a.phase}` : ''}
            {a.progress.total ? ` · ${a.progress.processed ?? 0}/${a.progress.total} pages` : ''}
            {a.attempt > 1 ? ` · attempt ${a.attempt}` : ''}
          </p>
          <p>
            {a.mode === 'page' ? 'Page' : 'Site'}: {a.target_url} · {a.mode}
            {a.preset ? ` · ${a.preset}` : ''} · {a.source} · profile {a.profile}
          </p>
          {a.scan_quality && <p>Scan quality: {a.scan_quality}</p>}
          {Object.keys(a.scores).length > 0 && (
            <p>
              Scores:{' '}
              {Object.entries(a.scores)
                .map(([k, v]) => `${k} ${v ?? '—'}`)
                .join(' · ')}
            </p>
          )}
          {a.page_cap && (
            <p data-testid="page-cap">
              Page cap of {a.page_cap.cap} reached: {a.page_cap.pages_loaded ?? '?'} pages loaded
              {a.page_cap.sitemap_held ? `, ${a.page_cap.sitemap_held} sitemap URLs not loaded` : ''}. Continuing starts
              a new audit that keeps these pages and loads more.
            </p>
          )}
          {a.continued_from && (
            <p>
              Continues{' '}
              <a className="link-accent" href={`/internal/audits/${a.continued_from}`}>
                an earlier audit
              </a>
              .
            </p>
          )}
          {a.error && <p className="error">{a.error}</p>}
          {a.load_blocked && <p className="error">Load waits for a newer app: {a.load_blocked}</p>}
          <p className="muted">
            Created {a.created_at} {a.started_at ? `· started ${a.started_at}` : ''}{' '}
            {a.finished_at ? `· finished ${a.finished_at}` : ''}
            {a.tool_version ? ` · tool ${a.tool_version}` : ''} {a.model_version ? `· model ${a.model_version}` : ''}
          </p>
          {reports.length > 0 && (
            <ul className="run-list">
              {reports.map((f) => (
                <li key={f.id}>
                  <a
                    data-testid="report-link"
                    className="link-accent"
                    href={
                      f.kind === 'report_html'
                        ? `/internal/audits/${a.audit_id}/view`
                        : `/internal/audits/${a.audit_id}/a/${f.id}`
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    {LABELS[f.kind] ?? f.kind}
                  </a>{' '}
                  <span className="muted">({Math.round(f.bytes / 1024)} KB)</span>
                </li>
              ))}
            </ul>
          )}
          <RunActions
            auditId={a.audit_id}
            active={active}
            succeeded={a.status === 'succeeded'}
            hasReportMd={a.artifacts.some((f) => f.kind === 'report_md')}
            hasPdf={a.artifacts.some((f) => f.kind === 'report_pdf')}
            pageCap={a.mode === 'full' ? (a.page_cap?.cap ?? null) : null}
          />
          {a.status === 'succeeded' && a.artifacts.some((f) => f.kind === 'report_html') && (
            <p>
              <a className="btn" href={`/internal/audits/${a.audit_id}/view`}>
                Open the report
              </a>
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
