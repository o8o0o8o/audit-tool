import { notFound, redirect } from 'next/navigation';
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
  const reports = a.artifacts.filter((f) => f.kind !== 'gate_evidence');
  return (
    <section className="section">
      <div className="container">
        <h1 className="section__title section__title--sm">Audit</h1>
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
          />
          {a.status === 'succeeded' && a.artifacts.some((f) => f.kind === 'report_html') && (
            <iframe
              className="report-frame"
              data-testid="report-frame"
              src={`/internal/audits/${a.audit_id}/report?embed=1`}
              title="Audit report"
            />
          )}
        </div>
      </div>
    </section>
  );
}
