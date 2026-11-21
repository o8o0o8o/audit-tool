import { dispatchJobs, requestPdf } from '../../../../../../lib/core/jobs';
import { ctx, handle, readJson, requireInternalPrincipal } from '../../../../../../lib/server';

export const dynamic = 'force-dynamic';

/** "Generate PDF" on the run page. */
export const POST = handle(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const principal = await requireInternalPrincipal();
  const { id } = await params;
  const body = (await readJson(request)) as { kind?: string };
  const { db, platform } = ctx();
  const res = await requestPdf(db, principal, { audit_id: id, kind: body?.kind ?? 'pdf' });
  if (res.status === 'queued') await dispatchJobs(db, platform).catch(() => {});
  return Response.json(res);
});
