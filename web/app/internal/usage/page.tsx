import { redirect } from 'next/navigation';
import { usageByUser, USAGE_DEFAULT_DAYS } from '../../../lib/core/usage';
import { ctx, internalPrincipal } from '../../../lib/server';

export const dynamic = 'force-dynamic';

const day = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : undefined);

export default async function UsagePage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const principal = await internalPrincipal();
  if (!principal) redirect('/internal/login?next=/internal/usage');
  const q = await searchParams;
  const usage = await usageByUser(ctx().db, principal, { from: day(q.from), to: day(q.to) });
  const total = (k: 'audits' | 'pages' | 'full' | 'quick' | 'page' | 'succeeded' | 'failed') =>
    usage.rows.reduce((n, r) => n + r[k], 0);
  return (
    <section className="section">
      <div className="container">
        <h1 className="section__title section__title--sm">Usage</h1>
        <form className="internal-filter" method="get">
          <input name="from" type="date" defaultValue={q.from ?? usage.from.slice(0, 10)} className="form-input" />
          <input name="to" type="date" defaultValue={q.to ?? usage.to.slice(0, 10)} className="form-input" />
          <button className="btn btn--outline" type="submit">
            Show
          </button>
        </form>
        <p className="muted run-details">
          Audits created from {usage.from.slice(0, 10)} up to {usage.to.slice(0, 10)} (last {USAGE_DEFAULT_DAYS} days
          when no dates are given). Websites are counted per user, so they are not added up.
        </p>
        {usage.rows.length === 0 && <p className="muted run-details">No audits in this period.</p>}
        <div className="table-scroll">
          <table className="run-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Audits</th>
                <th>Websites</th>
                <th>Pages</th>
                <th>Full</th>
                <th>Quick</th>
                <th>Single page</th>
                <th>Succeeded</th>
                <th>Failed</th>
                <th>Last audit</th>
              </tr>
            </thead>
            <tbody>
              {usage.rows.map((r) => (
                <tr key={`${r.user_kind}:${r.user}`} data-testid="usage-row">
                  <td>
                    {r.name ? `${r.name} · ` : ''}
                    {r.user}
                    {r.user_kind !== 'admin' ? ` (${r.user_kind === 'client' ? 'API key' : 'no user'})` : ''}
                  </td>
                  <td>{r.audits}</td>
                  <td>{r.websites}</td>
                  <td>{r.pages}</td>
                  <td>{r.full}</td>
                  <td>{r.quick}</td>
                  <td>{r.page}</td>
                  <td>{r.succeeded}</td>
                  <td>{r.failed}</td>
                  <td>{r.last_audit_at?.slice(0, 16).replace('T', ' ') ?? ''}</td>
                </tr>
              ))}
              {usage.rows.length > 1 && (
                <tr>
                  <td>Total</td>
                  <td>{total('audits')}</td>
                  <td />
                  <td>{total('pages')}</td>
                  <td>{total('full')}</td>
                  <td>{total('quick')}</td>
                  <td>{total('page')}</td>
                  <td>{total('succeeded')}</td>
                  <td>{total('failed')}</td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
