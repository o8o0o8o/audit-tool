import { redirect } from 'next/navigation';
import { listAudits } from '../../../lib/core/audits';
import { ctx, internalPrincipal } from '../../../lib/server';

export const dynamic = 'force-dynamic';

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ domain?: string; status?: string }>;
}) {
  const principal = await internalPrincipal();
  if (!principal) redirect('/internal/login?next=/internal/runs');
  const q = await searchParams;
  const audits = await listAudits(ctx().db, principal, {
    domain: q.domain || undefined,
    status: q.status || undefined,
    limit: 200,
  });
  return (
    <section className="section">
      <div className="container">
        <h1 className="section__title section__title--sm">Audit runs</h1>
        <form className="internal-filter" method="get">
          <input name="domain" defaultValue={q.domain ?? ''} placeholder="domain" className="form-input" />
          <input name="status" defaultValue={q.status ?? ''} placeholder="status" className="form-input" />
          <button className="btn btn--outline" type="submit">
            Filter
          </button>
        </form>
        {audits.length === 0 && <p className="muted run-details">No runs yet.</p>}
        <div className="table-scroll">
          <table className="run-table">
            <thead>
              <tr>
                <th>Created</th>
                <th>Site</th>
                <th>Mode</th>
                <th>Source</th>
                <th>Status</th>
                <th>Progress</th>
              </tr>
            </thead>
            <tbody>
              {audits.map((a) => (
                <tr key={a.audit_id}>
                  <td>
                    <a className="link-accent" href={`/internal/audits/${a.audit_id}`}>
                      {a.created_at.slice(0, 16).replace('T', ' ')}
                    </a>
                  </td>
                  <td>{a.mode === 'page' ? a.target_url : a.domain}</td>
                  <td>
                    {a.mode}
                    {a.preset ? ` · ${a.preset}` : ''}
                  </td>
                  <td>{a.source}</td>
                  <td data-testid="run-status">
                    {a.status}
                    {a.phase && !['succeeded', 'failed', 'cancelled'].includes(a.status) ? ` (${a.phase})` : ''}
                  </td>
                  <td>
                    {a.pages_total ? `${a.pages_processed ?? 0}/${a.pages_total}` : ''}
                    {a.status === 'succeeded' && a.page_cap && (
                      <>
                        {' '}
                        <a className="link-accent" href={`/internal/audits/${a.audit_id}`} data-testid="continue-link">
                          capped at {a.page_cap.cap} · continue
                        </a>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
