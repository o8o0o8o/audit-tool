import { redirect } from 'next/navigation';
import { internalPrincipal } from '../../../../../lib/server';
import { ReportFrame } from './report-frame';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Audit report | FocusReactive' };

/**
 * The one view of an audit's HTML report: full size, between the site header and footer. The report
 * loads through /internal/audits/<id>/report → a fresh /r/<token> link, served sandboxed.
 */
export default async function ReportView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await internalPrincipal())) redirect(`/internal/login?next=/internal/audits/${id}/view`);
  return (
    <section className="report-page">
      <div className="container">
        <ReportFrame src={`/internal/audits/${id}/report?embed=1`} />
      </div>
    </section>
  );
}
