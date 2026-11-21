import { getAudit } from '../../../../../../lib/core/audits';
import { isMainReportName } from '../../../../../../lib/run-status';
import { ctx, handle, requireInternalPrincipal } from '../../../../../../lib/server';

export const dynamic = 'force-dynamic';

const IN_PROGRESS = ['queued', 'dispatched', 'running', 'built', 'loading', 'stalled'];

/** The live-progress shape the dispatch page polls (RunStatus in lib/audit-progress.ts), from the row. */
export const GET = handle(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const principal = await requireInternalPrincipal();
  const { id } = await params;
  const a = await getAudit(ctx().db, principal, id);
  const files = a.artifacts.map((f) => {
    const name = f.key.split('/').slice(3).join('/');
    return {
      name,
      url:
        f.kind === 'report_html' && isMainReportName(name)
          ? `/internal/audits/${id}/report`
          : `/internal/audits/${id}/a/${f.id}`,
    };
  });
  return Response.json({
    status: IN_PROGRESS.includes(a.status) ? 'running' : a.status,
    platformStatus: a.status,
    phase: a.phase,
    startedAt: a.started_at ?? a.created_at,
    finishedAt: a.finished_at ?? undefined,
    error: a.error ?? undefined,
    files,
    progress: a.progress.total
      ? {
          processed: a.progress.processed ?? 0,
          total: a.progress.total,
          phase: 'pages',
          updatedAt: a.progress.updated_at ?? undefined,
        }
      : undefined,
  });
});
